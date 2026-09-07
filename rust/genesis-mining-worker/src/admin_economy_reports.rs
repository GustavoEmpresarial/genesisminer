//! Admin economy read reports for the "Moedas & Calculadora" panel:
//! `GET /api/admin/economy-stats` (per-coin real active miners + hashrate from
//! `placed_racks`) and `GET /api/admin/mining-runtime-summary` (last yield-tick
//! snapshot from `app_cache.network_stats`).
//!
//! Ports `server/modules/admin/{economy-stats,mining-runtime-summary}/`.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

pub const ECONOMY_STATS_PATH: &str = "/v1/admin/economy/coin-stats";
pub const MINING_RUNTIME_SUMMARY_PATH: &str = "/v1/admin/economy/runtime-summary";

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

#[cfg(test)]
mod tests {
    #[test]
    fn paths_stable() {
        assert_eq!(super::ECONOMY_STATS_PATH, "/v1/admin/economy/coin-stats");
    }
}
