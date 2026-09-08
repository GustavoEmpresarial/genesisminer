//! Admin economy read reports for the "Moedas & Calculadora" panel:
//! `GET /api/admin/economy-stats` (per-coin real active miners + hashrate from
//! `placed_racks`) and `GET /api/admin/mining-runtime-summary` (last yield-tick
//! snapshot from `app_cache.network_stats`).
//!
//! Ports `server/modules/admin/{economy-stats,mining-runtime-summary}/`.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;
use genesis_core::calculator::constants::{
    DIST_MIN_HASHRATE, MIN_NETWORK_HASHRATE, SECONDS_PER_MONTH,
};
use genesis_core::mining::{usd_month_yield, NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT};
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

pub const ECONOMY_STATS_PATH: &str = "/v1/admin/economy/coin-stats";
pub const MINING_RUNTIME_SUMMARY_PATH: &str = "/v1/admin/economy/runtime-summary";
pub const DISTRIBUTION_PREVIEW_PATH: &str = "/v1/admin/economy/distribution-preview";

const COIN_SELECT: &str = "id, name, symbol, description, network_hashrate, block_reward, block_time,
     price_usd, algorithm, difficulty, multiplier, color, min_proportion, usdc_rate, is_active,
     target_daily_usd, show_in_exchange, nft_room_only";

fn f(r: &tokio_postgres::Row, c: &str) -> f64 {
    r.try_get::<_, Option<f64>>(c).ok().flatten().unwrap_or(0.0)
}
fn i(r: &tokio_postgres::Row, c: &str) -> i64 {
    if let Ok(v) = r.try_get::<_, i32>(c) {
        return i64::from(v);
    }
    if let Ok(v) = r.try_get::<_, i16>(c) {
        return i64::from(v);
    }
    r.try_get::<_, Option<i64>>(c).ok().flatten().unwrap_or(0)
}
fn oi(r: &tokio_postgres::Row, c: &str) -> Value {
    match r
        .try_get::<_, Option<i32>>(c)
        .ok()
        .flatten()
        .or_else(|| r.try_get::<_, Option<i16>>(c).ok().flatten().map(i32::from))
    {
        Some(v) => json!(v),
        None => Value::Null,
    }
}
fn of(r: &tokio_postgres::Row, c: &str) -> Value {
    match r.try_get::<_, Option<f64>>(c).ok().flatten() {
        Some(v) => json!(v),
        None => Value::Null,
    }
}
fn s(r: &tokio_postgres::Row, c: &str) -> String {
    r.try_get::<_, Option<String>>(c).ok().flatten().unwrap_or_default()
}

fn coin_json(r: &tokio_postgres::Row, real_active_miners: i64, real_total_hashrate: f64) -> Value {
    json!({
        "id": s(r, "id"),
        "name": s(r, "name"),
        "symbol": s(r, "symbol"),
        "description": s(r, "description"),
        "network_hashrate": f(r, "network_hashrate"),
        "block_reward": f(r, "block_reward"),
        "block_time": f(r, "block_time"),
        "price_usd": f(r, "price_usd"),
        "algorithm": s(r, "algorithm"),
        "difficulty": f(r, "difficulty"),
        "multiplier": f(r, "multiplier"),
        "color": s(r, "color"),
        "min_proportion": f(r, "min_proportion"),
        "usdc_rate": f(r, "usdc_rate"),
        "is_active": i(r, "is_active"),
        "target_daily_usd": of(r, "target_daily_usd"),
        "show_in_exchange": oi(r, "show_in_exchange"),
        "nft_room_only": i(r, "nft_room_only"),
        "realActiveMiners": real_active_miners,
        "realTotalHashrate": real_total_hashrate,
    })
}

pub async fn run_economy_coin_stats(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;

    let coin_rows = c
        .query(&format!("SELECT {COIN_SELECT} FROM mining_coins"), &[])
        .await?;

    // upgrades: id -> (base_production, multiplier)
    let up_rows = c
        .query(
            "SELECT id, COALESCE(base_production,0)::float8 AS base_production,
                    COALESCE(multiplier,0)::float8 AS multiplier
               FROM upgrades",
            &[],
        )
        .await?;
    let mut ups: HashMap<String, (f64, f64)> = HashMap::new();
    for r in &up_rows {
        ups.insert(s(r, "id"), (f(r, "base_production"), f(r, "multiplier")));
    }

    // active racks (Node filter): is_on=1, wiring+battery set, user not blocked
    let racks = c
        .query(
            "SELECT pr.id, pr.user_id, pr.selected_coin_id
               FROM placed_racks pr
               JOIN users u ON u.id = pr.user_id
              WHERE pr.is_on = 1 AND pr.wiring_id IS NOT NULL AND pr.battery_id IS NOT NULL
                AND u.is_blocked = 0",
            &[],
        )
        .await?;

    let rack_ids: Vec<String> = racks.iter().map(|r| s(r, "id")).collect();
    let mut slot_machines: HashMap<String, Vec<String>> = HashMap::new();
    let mut mult_items: HashMap<String, Vec<String>> = HashMap::new();
    if !rack_ids.is_empty() {
        for r in c
            .query(
                "SELECT rack_id, machine_item_id FROM rack_slots WHERE rack_id = ANY($1::text[])",
                &[&rack_ids],
            )
            .await?
        {
            let mid: Option<String> = r.try_get("machine_item_id").ok().flatten();
            slot_machines
                .entry(s(&r, "rack_id"))
                .or_default()
                .push(mid.unwrap_or_default());
        }
        for r in c
            .query(
                "SELECT rack_id, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1::text[])",
                &[&rack_ids],
            )
            .await?
        {
            let mid: Option<String> = r.try_get("multiplier_item_id").ok().flatten();
            mult_items
                .entry(s(&r, "rack_id"))
                .or_default()
                .push(mid.unwrap_or_default());
        }
    }

    let coin_ids: HashSet<String> = coin_rows.iter().map(|r| s(r, "id")).collect();
    let mut hash_by_coin: HashMap<String, f64> = HashMap::new();
    let mut miners_by_coin: HashMap<String, HashSet<i64>> = HashMap::new();

    for rack in &racks {
        let Some(cid) = rack.try_get::<_, Option<String>>("selected_coin_id").ok().flatten() else {
            continue;
        };
        if !coin_ids.contains(&cid) {
            continue;
        }
        let rid = s(rack, "id");
        let mut base = 0.0f64;
        for mid in slot_machines.get(&rid).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some((bp, _)) = ups.get(mid) {
                base += bp;
            }
        }
        if base == 0.0 {
            continue;
        }
        let mut mult = 1.0f64;
        for mid in mult_items.get(&rid).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some((_, m)) = ups.get(mid) {
                mult += m;
            }
        }
        *hash_by_coin.entry(cid.clone()).or_insert(0.0) += base * mult;
        miners_by_coin
            .entry(cid)
            .or_default()
            .insert(i(rack, "user_id"));
    }

    let out: Vec<Value> = coin_rows
        .iter()
        .map(|r| {
            let cid = s(r, "id");
            let miners = miners_by_coin.get(&cid).map(HashSet::len).unwrap_or(0) as i64;
            let hash = hash_by_coin.get(&cid).copied().unwrap_or(0.0);
            coin_json(r, miners, hash)
        })
        .collect();
    Ok(json!({ "rows": out }))
}

pub async fn run_mining_runtime_summary(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let row = c
        .query_opt("SELECT value FROM app_cache WHERE key = 'network_stats'", &[])
        .await?;
    let value: Value = row
        .and_then(|r| r.try_get::<_, Option<Value>>("value").ok().flatten())
        .unwrap_or_else(|| json!({}));
    Ok(json!({
        "realActiveMiners": value.get("activeMiners").and_then(Value::as_i64).unwrap_or(0),
        "realNetworkHashrates": value.get("hashrates").cloned().unwrap_or_else(|| json!({})),
        "activeMinersByCoin": value.get("activeMinersByCoin").cloned().unwrap_or_else(|| json!({})),
    }))
}

/// `POST /v1/admin/economy/distribution-preview` — projeta a distribuição de um
/// orçamento USD mensal para uma moeda, usando o MESMO hashrate ativo que o
/// yield-tick usa (`app_cache.network_stats`, ~2 min de defasagem). Assim o
/// preview "ajusta certinho" com o que o boundary vai realmente pagar.
pub async fn run_distribution_preview(
    pool: &Pool,
    coin_id: &str,
    distribution_usd_month: f64,
) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;

    let coin = c
        .query_opt(
            "SELECT symbol, price_usd::double precision AS price_usd, distribution_mode
               FROM mining_coins WHERE id = $1",
            &[&coin_id],
        )
        .await?
        .ok_or_else(|| PlayerReadError::bad("Coin not found."))?;
    let symbol: String = coin
        .try_get::<_, Option<String>>("symbol")
        .ok()
        .flatten()
        .unwrap_or_default();
    let price_usd = coin
        .try_get::<_, Option<f64>>("price_usd")
        .ok()
        .flatten()
        .unwrap_or(0.0);
    let current_mode: String = coin
        .try_get::<_, Option<String>>("distribution_mode")
        .ok()
        .flatten()
        .unwrap_or_else(|| "legacy".to_string());

    // Snapshot do último tick.
    let stats: Value = c
        .query_opt("SELECT value FROM app_cache WHERE key = 'network_stats'", &[])
        .await?
        .and_then(|r| r.try_get::<_, Option<Value>>("value").ok().flatten())
        .unwrap_or_else(|| json!({}));

    let active_hashrate = stats
        .get("hashrates")
        .and_then(|h| h.get(coin_id))
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0);
    let active_miners = stats
        .get("activeMinersByCoin")
        .and_then(|m| m.get(coin_id))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let (yield_per_hash, budget_per_sec_coins, divisor) =
        usd_month_yield(distribution_usd_month, price_usd, active_hashrate);
    let price_or_1 = if price_usd.is_finite() && price_usd > 0.0 {
        price_usd
    } else {
        1.0
    };
    let total_coins_month = yield_per_hash * active_hashrate * SECONDS_PER_MONTH;
    let total_usd_month = total_coins_month * price_or_1;
    let per_hash_usd_month = yield_per_hash * price_or_1 * SECONDS_PER_MONTH;
    let representative_unit_usd_month = 10.0 * per_hash_usd_month;

    // Top mineradores por hashrate na moeda (do ranking do último tick).
    let mut per_user: Vec<(i64, f64)> = Vec::new();
    if let Some(rows) = stats.get("ranking").and_then(Value::as_array) {
        for r in rows {
            let uid = r.get("user_id").and_then(Value::as_i64).unwrap_or(0);
            let h = r
                .get("coins")
                .and_then(|cc| cc.get(coin_id))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if uid != 0 && h.is_finite() && h > 0.0 {
                per_user.push((uid, h));
            }
        }
    }
    per_user.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_share_pct = per_user
        .first()
        .map(|(_, h)| if active_hashrate > 0.0 { h / active_hashrate * 100.0 } else { 0.0 })
        .unwrap_or(0.0);
    let top_miners: Vec<Value> = per_user
        .iter()
        .take(10)
        .map(|(uid, h)| {
            let share = if active_hashrate > 0.0 { h / active_hashrate } else { 0.0 };
            json!({
                "userId": uid,
                "hashrate": h,
                "sharePct": share * 100.0,
                "usdMonth": share * total_usd_month,
            })
        })
        .collect();

    let mut warnings: Vec<String> = Vec::new();
    if active_hashrate <= MIN_NETWORK_HASHRATE {
        warnings.push("Sem hashrate ativo nesta moeda — nada será distribuído.".into());
    } else if active_hashrate < DIST_MIN_HASHRATE {
        warnings.push(format!(
            "Hashrate abaixo do piso ({DIST_MIN_HASHRATE:.0} H/s) — sub-distribuindo (~${:.2}/mês).",
            total_usd_month
        ));
    }
    if top_share_pct > NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT {
        warnings.push(format!(
            "Um único minerador leva {top_share_pct:.1}% da distribuição.",
        ));
    }
    let is_stable = genesis_core::calculator::constants::NFT_STABLE_USD_SYMBOLS
        .contains(&symbol.trim().to_ascii_uppercase().as_str());
    if (!price_usd.is_finite() || price_usd <= 0.0) && !is_stable {
        warnings.push("Preço da moeda é 0/desconhecido — tratando 1 coin = $1.".into());
    }
    if yield_per_hash > 0.0 && yield_per_hash < 1e-12 {
        warnings.push("Orçamento arredonda para ~0 por hash nesse hashrate.".into());
    }

    Ok(json!({
        "coinId": coin_id,
        "symbol": symbol,
        "currentMode": current_mode,
        "distributionUsdMonth": distribution_usd_month,
        "priceUsd": price_usd,
        "activeHashrate": active_hashrate,
        "activeMiners": active_miners,
        "divisor": divisor,
        "yieldPerHash": yield_per_hash,
        "budgetPerSecCoins": budget_per_sec_coins,
        "totalCoinsMonth": total_coins_month,
        "totalUsdMonth": total_usd_month,
        "perHashUsdMonth": per_hash_usd_month,
        "representativeUnitUsdMonth": representative_unit_usd_month,
        "topMiners": top_miners,
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn paths_stable() {
        assert_eq!(super::ECONOMY_STATS_PATH, "/v1/admin/economy/coin-stats");
        assert_eq!(
            super::DISTRIBUTION_PREVIEW_PATH,
            "/v1/admin/economy/distribution-preview"
        );
    }
}
