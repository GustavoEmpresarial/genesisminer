//! Player mining projection — `POST /v1/mining/projection`.
//!
//! Builds per-coin `coins/s = user_hps × yield_per_hash` for a scope
//! (`total` or room id), matching progress/header identity. Prefer
//! recompute via [`genesis_core::mining::resolve_yield_per_hash`] with live
//! active hashrate from `app_cache.network_stats`; fall back to latest
//! `mining_yield_history.yield_per_hash` when live is unavailable.

use std::collections::HashMap;

use deadpool_postgres::Pool;
use genesis_core::calculator::checkin_bonus::{
    effective_hash_with_checkin_bonus, sum_non_nft_room_rig_hash_hps,
};
use genesis_core::calculator::constants::{
    BLOCK_HISTORY_LIMIT, ROOM_ID_MAX_LEN, ROOM_INITIAL_FALLBACK_NAME, ROOM_INITIAL_ID, SCOPE_TOTAL,
    SCOPE_TOTAL_UI_NAME, SECONDS_PER_MONTH,
};
use genesis_core::calculator::nft::is_independent_network_pool_mining_coin_ref;
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::calculator::slot_credits::list_slot_mining_credits;
use genesis_core::calculator::types::{CalculatorUpgradeLite, CheckinHashEntry, MiningCoinInput};
use genesis_core::checkin::is_checkin_frozen_for_mining;
use genesis_core::header::{aggregate_header_hash, HeaderHashEntry};
use genesis_core::mining::{
    coins_per_sec, project_rows, resolve_yield_per_hash, CoinYieldInput, DistributionMode,
};
use genesis_core::time::SECONDS_PER_DAY;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::{
    f64_cell, i32_cell, i64_cell, now_ms, opt_string, pg_user_id, string_cell, PlayerReadError,
};
use crate::progress::{load_live_network_hashrates, resolve_premium_weekly_checkin};
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

pub const MINING_PROJECTION_PATH: &str = "/v1/mining/projection";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionRequest {
    pub user_id: i64,
    #[serde(default)]
    pub scope: Option<String>,
}

/// Active hashrate used as `usd_month` divisor.
///
/// Prefer live network hashrate from `app_cache.network_stats` (same source as
/// yield_tick). Live is base-only and may undercount vs check-in-boosted
/// `user_hps_all_rooms`, so always take `max(live, user)` — never prefer a
/// live value smaller than the user's full-coin power (all rooms).
///
/// `user_hps_all_rooms` must be power across **all** operable racks for that
/// coin (not scope-filtered), so room scope does not shrink the competitive
/// pool divisor when other rooms also mine the same coin.
fn resolve_active_hash_for_projection(live: f64, user_hps_all_rooms: f64) -> f64 {
    let live = if live.is_finite() && live > 0.0 {
        live
    } else {
        0.0
    };
    let user = if user_hps_all_rooms.is_finite() && user_hps_all_rooms > 0.0 {
        user_hps_all_rooms
    } else {
        0.0
    };
    live.max(user)
}

fn normalize_scope(raw: Option<&str>) -> Result<String, PlayerReadError> {
    let s = raw.unwrap_or(SCOPE_TOTAL).trim();
    if s.is_empty() || s.eq_ignore_ascii_case(SCOPE_TOTAL) {
        return Ok(SCOPE_TOTAL.to_string());
    }
    if s.len() > ROOM_ID_MAX_LEN {
        return Err(PlayerReadError::bad("invalid scope"));
    }
    Ok(normalize_placed_rack_room_id(s))
}

async fn user_owns_room(
    conn: &tokio_postgres::Client,
    uid: i32,
    room_id: &str,
) -> Result<bool, PlayerReadError> {
    if room_id == ROOM_INITIAL_ID || room_id == "main" {
        return Ok(true);
    }
    let owned = conn
        .query_opt(
            "SELECT 1 FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2",
            &[&uid, &room_id],
        )
        .await?
        .is_some();
    if owned {
        return Ok(true);
    }
    // Also accept rooms where the user already has placed racks (legacy grants).
    let has_rack = conn
        .query_opt(
            "SELECT 1 FROM placed_racks
              WHERE user_id = $1
                AND COALESCE(NULLIF(BTRIM(room_id::text), ''), $2) = $3
              LIMIT 1",
            &[&uid, &ROOM_INITIAL_ID, &room_id],
        )
        .await?
        .is_some();
    Ok(has_rack)
}

async fn load_scopes_ui(conn: &tokio_postgres::Client, uid: i32) -> Result<Vec<Value>, PlayerReadError> {
    let mut scopes = vec![json!({
        "id": SCOPE_TOTAL,
        "name": SCOPE_TOTAL_UI_NAME,
    })];
    // Always surface the free initial room.
    scopes.push(json!({
        "id": ROOM_INITIAL_ID,
        "name": ROOM_INITIAL_FALLBACK_NAME,
    }));
    let rows = conn
        .query(
            "SELECT urr.room_id,
                    COALESCE(NULLIF(BTRIM(rr.name), ''), urr.room_id) AS name
               FROM user_rig_rooms urr
               LEFT JOIN rig_rooms rr ON rr.id = urr.room_id
              WHERE urr.user_id = $1
              ORDER BY name ASC, urr.room_id ASC",
            &[&uid],
        )
        .await?;
    let mut seen = std::collections::HashSet::new();
    seen.insert(SCOPE_TOTAL.to_string());
    seen.insert(ROOM_INITIAL_ID.to_string());
    for r in &rows {
        let id = string_cell(r, "room_id");
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let name = string_cell(r, "name");
        scopes.push(json!({
            "id": id,
            "name": if name.is_empty() { string_cell(r, "room_id") } else { name },
        }));
    }
    Ok(scopes)
}

fn rack_operable_for_hash(r: &tokio_postgres::Row) -> bool {
    if i32_cell(r, "is_on") != 1 {
        return false;
    }
    let wiring = string_cell(r, "wiring_id");
    let battery = string_cell(r, "battery_id");
    !wiring.is_empty() && !battery.is_empty()
}

pub async fn run_mining_projection(
    pool: &Pool,
    user_id: i64,
    scope_raw: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let scope = normalize_scope(scope_raw)?;
    let uid = pg_user_id(user_id)?;
    let now = now_ms();
    let conn = pool.get().await?;

    if scope != SCOPE_TOTAL && !user_owns_room(&*conn, uid, &scope).await? {
        return Err(PlayerReadError::bad("scope not owned"));
    }

    let scopes_ui = load_scopes_ui(&*conn, uid).await?;

    let gs = conn
        .query_opt(
            "SELECT last_checkin_at_ms, checkin_bonus_hps::double precision AS checkin_bonus_hps
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let (last_checkin_raw, checkin_bonus_hps) = match gs.as_ref() {
        Some(row) => {
            let last = {
                let v = i64_cell(row, "last_checkin_at_ms");
                if v > 0 {
                    Some(v)
                } else {
                    None
                }
            };
            (last, f64_cell(row, "checkin_bonus_hps").max(0.0))
        }
        None => (None, 0.0),
    };

    let premium = resolve_premium_weekly_checkin(&*conn, uid).await;
    let checkin_frozen = is_checkin_frozen_for_mining(
        last_checkin_raw,
        now,
        premium.premium_weekly,
        premium.interval_days,
    );

    let racks = if checkin_frozen {
        Vec::new()
    } else {
        conn.query(
            "SELECT id, item_id, is_on, wiring_id, battery_id, selected_coin_id, room_id
               FROM placed_racks WHERE user_id = $1",
            &[&uid],
        )
        .await?
    };

    let ups_rows = conn
        .query(
            "SELECT id, type, category, base_production, multiplier, nft_mining_coin_id FROM upgrades",
            &[],
        )
        .await?;
    let mut ups_map: HashMap<String, CalculatorUpgradeLite> = HashMap::new();
    for row in &ups_rows {
        let id: String = row.get("id");
        ups_map.insert(
            id.clone(),
            CalculatorUpgradeLite {
                id,
                upgrade_type: row.try_get("type").unwrap_or_default(),
                category: row.try_get("category").ok(),
                base_production: f64_cell(row, "base_production"),
                multiplier: row
                    .try_get::<_, f64>("multiplier")
                    .ok()
                    .or_else(|| row.try_get::<_, i32>("multiplier").ok().map(|v| v as f64)),
                power_capacity: None,
                nft_mining_coin_id: row.try_get("nft_mining_coin_id").ok(),
            },
        );
    }

    let nft_room_ids = resolve_nft_auto_room_ids(&*conn)
        .await
        .map_err(PlayerReadError::from)?;
    let asic_room_ids = resolve_asic_room_ids(&*conn)
        .await
        .map_err(PlayerReadError::from)?;

    let mut slots_map: HashMap<String, Vec<Option<String>>> = HashMap::new();
    let mut multi_map: HashMap<String, Vec<Option<String>>> = HashMap::new();
    if !racks.is_empty() {
        let rack_ids: Vec<String> = racks.iter().map(|r| r.get::<_, String>("id")).collect();
        let slot_rows = conn
            .query(
                "SELECT rack_id, slot_index, machine_item_id
                   FROM rack_slots WHERE rack_id = ANY($1)
                   ORDER BY rack_id ASC, slot_index ASC",
                &[&rack_ids],
            )
            .await?;
        let multi_rows = conn
            .query(
                "SELECT rack_id, slot_index, multiplier_item_id
                   FROM rack_multiplier_slots WHERE rack_id = ANY($1)
                   ORDER BY rack_id ASC, slot_index ASC",
                &[&rack_ids],
            )
            .await?;
        for s in &slot_rows {
            let rid: String = s.get("rack_id");
            let idx = i32_cell(s, "slot_index").max(0) as usize;
            let mid: Option<String> = s
                .try_get::<_, Option<String>>("machine_item_id")
                .ok()
                .flatten()
                .or_else(|| s.try_get::<_, String>("machine_item_id").ok());
            let arr = slots_map.entry(rid).or_default();
            while arr.len() <= idx {
                arr.push(None);
            }
            arr[idx] = mid.filter(|v| !v.is_empty());
        }
        for m in &multi_rows {
            let rid: String = m.get("rack_id");
            let idx = i32_cell(m, "slot_index").max(0) as usize;
            let mid: Option<String> = m
                .try_get::<_, Option<String>>("multiplier_item_id")
                .ok()
                .flatten()
                .or_else(|| m.try_get::<_, String>("multiplier_item_id").ok());
            let arr = multi_map.entry(rid).or_default();
            while arr.len() <= idx {
                arr.push(None);
            }
            arr[idx] = mid.filter(|v| !v.is_empty());
        }
    }

    let empty_slots: Vec<Option<String>> = Vec::new();
    let mut hash_entries: Vec<CheckinHashEntry> = Vec::new();
    for r in &racks {
        if !rack_operable_for_hash(r) {
            continue;
        }
        let rid: String = r.get("id");
        let room_raw: Option<String> = r.try_get("room_id").ok();
        let room_norm = normalize_placed_rack_room_id(room_raw.as_deref().unwrap_or(""));
        if scope != SCOPE_TOTAL && room_norm != scope {
            continue;
        }
        let selected: String = r
            .try_get::<_, String>("selected_coin_id")
            .unwrap_or_default();
        let item_id: Option<String> = r.try_get("item_id").ok();
        let credits = list_slot_mining_credits(
            Some(room_norm.as_str()),
            slots_map.get(&rid).unwrap_or(&empty_slots),
            multi_map.get(&rid).unwrap_or(&empty_slots),
            &ups_map,
            &selected,
            Some(&nft_room_ids),
            item_id.as_deref(),
            Some(&asic_room_ids),
        );
        for sc in credits {
            if !sc.effective_base_prod.is_finite() || sc.effective_base_prod <= 0.0 {
                continue;
            }
            hash_entries.push(CheckinHashEntry {
                coin_id: sc.coin_id,
                room_id: Some(room_norm.clone()),
                base_hps: sc.effective_base_prod,
                counts_toward_general_power: sc.counts_toward_general_power,
            });
        }
    }

    // Check-in bonus base uses non-NFT hash across *all* operable racks (header),
    // not only the selected scope — same as progress.
    let mut all_hash_entries: Vec<CheckinHashEntry> = Vec::new();
    for r in &racks {
        if !rack_operable_for_hash(r) {
            continue;
        }
        let rid: String = r.get("id");
        let room_raw: Option<String> = r.try_get("room_id").ok();
        let room_norm = normalize_placed_rack_room_id(room_raw.as_deref().unwrap_or(""));
        let selected: String = r
            .try_get::<_, String>("selected_coin_id")
            .unwrap_or_default();
        let item_id: Option<String> = r.try_get("item_id").ok();
        let credits = list_slot_mining_credits(
            Some(room_norm.as_str()),
            slots_map.get(&rid).unwrap_or(&empty_slots),
            multi_map.get(&rid).unwrap_or(&empty_slots),
            &ups_map,
            &selected,
            Some(&nft_room_ids),
            item_id.as_deref(),
            Some(&asic_room_ids),
        );
        for sc in credits {
            if !sc.effective_base_prod.is_finite() || sc.effective_base_prod <= 0.0 {
                continue;
            }
            all_hash_entries.push(CheckinHashEntry {
                coin_id: sc.coin_id,
                room_id: Some(room_norm.clone()),
                base_hps: sc.effective_base_prod,
                counts_toward_general_power: sc.counts_toward_general_power,
            });
        }
    }
    let total_non_nft_rig_hash =
        sum_non_nft_room_rig_hash_hps(&all_hash_entries, &nft_room_ids, Some(&asic_room_ids));

    let to_header_entry = |entry: &CheckinHashEntry| {
        let effective = effective_hash_with_checkin_bonus(
            entry.base_hps,
            &entry.coin_id,
            entry.room_id.as_deref(),
            checkin_bonus_hps,
            total_non_nft_rig_hash,
            &nft_room_ids,
            Some(&asic_room_ids),
            Some(entry.counts_toward_general_power),
        );
        HeaderHashEntry {
            coin_id: entry.coin_id.clone(),
            effective_hps: effective,
            counts_toward_general_power: entry.counts_toward_general_power,
        }
    };
    // Scope-filtered power → earnings numerator / UI userPowerHps.
    let agg = aggregate_header_hash(
        &hash_entries.iter().map(to_header_entry).collect::<Vec<_>>(),
    );
    let general_power_hps = agg.total_hash;
    // All-rooms power for this user → usd_month divisor fallback / max(live, user).
    let agg_all = aggregate_header_hash(
        &all_hash_entries
            .iter()
            .map(to_header_entry)
            .collect::<Vec<_>>(),
    );

    let live_hashrates = load_live_network_hashrates(&*conn).await;

    let yield_hist = conn
        .query(
            "SELECT DISTINCT ON (coin_id) coin_id, yield_per_hash::double precision AS yield_per_hash
               FROM mining_yield_history
              WHERE yield_per_hash > 0
              ORDER BY coin_id, effective_at DESC",
            &[],
        )
        .await?;
    let mut hist_yph: HashMap<String, f64> = HashMap::new();
    for r in &yield_hist {
        let id = string_cell(r, "coin_id");
        let y = f64_cell(r, "yield_per_hash");
        if !id.is_empty() && y.is_finite() && y > 0.0 {
            hist_yph.insert(id, y);
        }
    }

    let coin_rows = conn
        .query(
            "SELECT id, symbol, name, block_reward, block_time, network_hashrate,
                    price_usd, usdc_rate, nft_room_only, distribution_mode, distribution_usd_month,
                    icon_url
               FROM mining_coins WHERE is_active = 1
               ORDER BY symbol ASC, id ASC",
            &[],
        )
        .await?;

    let history_limit = i64::try_from(BLOCK_HISTORY_LIMIT).unwrap_or(120);
    let mut coins_out: Vec<Value> = Vec::new();

    for coin in &coin_rows {
        let coin_id: String = coin.get("id");
        let symbol: String = coin.try_get("symbol").unwrap_or_default();
        let name: String = coin.try_get("name").unwrap_or_default();
        let name = if name.is_empty() {
            if symbol.is_empty() {
                coin_id.clone()
            } else {
                symbol.clone()
            }
        } else {
            name
        };
        let icon_url = opt_string(coin, "icon_url");
        let block_reward = f64_cell(coin, "block_reward");
        let block_time = f64_cell(coin, "block_time");
        let network_hashrate = f64_cell(coin, "network_hashrate");
        let price_usd = f64_cell(coin, "price_usd");
        let usdc_rate = f64_cell(coin, "usdc_rate");
        let nft_room_only = i32_cell(coin, "nft_room_only") != 0;
        let distribution_mode = DistributionMode::parse(
            &coin
                .try_get::<_, Option<String>>("distribution_mode")
                .ok()
                .flatten()
                .unwrap_or_default(),
        );
        let distribution_usd_month = f64_cell(coin, "distribution_usd_month");
        let mode_str = match distribution_mode {
            DistributionMode::UsdMonth => "usd_month",
            DistributionMode::Legacy => "legacy",
        };

        let flag_input = MiningCoinInput {
            id: coin_id.clone(),
            symbol: symbol.clone(),
            name: name.clone(),
            network_hashrate,
            block_reward,
            block_time,
            price_usd,
            usdc_rate,
            nft_room_only,
            distribution_mode,
            distribution_usd_month,
        };
        let independent_pool = is_independent_network_pool_mining_coin_ref(&flag_input);

        let user_power = agg
            .hash_by_coin_id
            .get(&coin_id)
            .copied()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        let user_power_all = agg_all
            .hash_by_coin_id
            .get(&coin_id)
            .copied()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);

        let live = live_hashrates
            .get(&coin_id)
            .copied()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        let active = resolve_active_hash_for_projection(live, user_power_all);

        let yield_input = CoinYieldInput {
            id: coin_id.clone(),
            block_reward,
            block_time,
            network_hashrate,
            independent_pool,
            distribution_mode,
            distribution_usd_month,
            price_usd,
        };

        let (mut yph, mut network_hps) = resolve_yield_per_hash(&yield_input, active);
        // Legacy only: live unavailable / recompute zero → latest yield history.
        // UsdMonth keeps 0 (empty pool / no budget) — hist must not invent yield.
        if yph <= 0.0 && distribution_mode == DistributionMode::Legacy {
            if let Some(hist) = hist_yph.get(&coin_id).copied() {
                yph = hist;
                if network_hps <= 0.0 && active > 0.0 {
                    network_hps = active;
                }
            }
        }

        let cps = coins_per_sec(user_power, yph);
        let daily_coins = cps * SECONDS_PER_DAY as f64;
        let price_for_usd = if price_usd.is_finite() && price_usd > 0.0 {
            price_usd
        } else {
            0.0
        };
        let daily_usd = daily_coins * price_for_usd;
        let month_usd = cps * SECONDS_PER_MONTH * price_for_usd;
        let share_pct = if network_hps > 0.0 && user_power > 0.0 {
            (user_power / network_hps * 100.0).min(100.0)
        } else {
            0.0
        };
        let rows = project_rows(user_power, yph, price_for_usd);
        let rows_json: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "periodId": r.period_id,
                    "coins": r.coins,
                    "usd": r.usd,
                })
            })
            .collect();

        let block_history = load_block_history(
            &*conn,
            uid,
            &coin_id,
            &scope,
            history_limit,
        )
        .await?;

        coins_out.push(json!({
            "id": coin_id,
            "symbol": symbol,
            "name": name,
            "iconUrl": icon_url,
            "priceUsd": price_usd,
            "distributionMode": mode_str,
            "distributionUsdMonth": if distribution_mode == DistributionMode::UsdMonth {
                json!(distribution_usd_month)
            } else {
                Value::Null
            },
            "nftRoomOnly": nft_room_only,
            "independentPool": independent_pool,
            "userPowerHps": user_power,
            "networkHps": network_hps,
            "yieldPerHash": yph,
            "sharePct": share_pct,
            "coinsPerSec": cps,
            "dailyCoins": daily_coins,
            "dailyUsd": daily_usd,
            "monthUsd": month_usd,
            "rows": rows_json,
            "blockHistory": block_history,
        }));
    }

    // Mining first, then symbol.
    coins_out.sort_by(|a, b| {
        let ap = a
            .get("userPowerHps")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let bp = b
            .get("userPowerHps")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let a_mining = ap > 0.0;
        let b_mining = bp > 0.0;
        match (a_mining, b_mining) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let as_ = a
                    .get("symbol")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_uppercase();
                let bs = b
                    .get("symbol")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_uppercase();
                as_.cmp(&bs)
            }
        }
    });

    Ok(json!({
        "scope": scope,
        "scopesUi": scopes_ui,
        "checkinFrozen": checkin_frozen,
        "generalPowerHps": general_power_hps,
        "coins": coins_out,
    }))
}

async fn load_block_history(
    conn: &tokio_postgres::Client,
    uid: i32,
    coin_id: &str,
    scope: &str,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let rows = if scope == SCOPE_TOTAL {
        conn.query(
            "SELECT room_id, window_start_ms, window_end_ms, credit_blocks,
                    amount_coins::double precision AS amount_coins,
                    amount_usd::double precision AS amount_usd,
                    user_hash_hps::double precision AS user_hash_hps,
                    network_hashrate::double precision AS network_hashrate
               FROM mining_block_history
              WHERE user_id = $1 AND coin_id = $2
              ORDER BY window_end_ms DESC
              LIMIT $3",
            &[&uid, &coin_id, &limit],
        )
        .await
    } else {
        conn.query(
            "SELECT room_id, window_start_ms, window_end_ms, credit_blocks,
                    amount_coins::double precision AS amount_coins,
                    amount_usd::double precision AS amount_usd,
                    user_hash_hps::double precision AS user_hash_hps,
                    network_hashrate::double precision AS network_hashrate
               FROM mining_block_history
              WHERE user_id = $1 AND coin_id = $2
                AND COALESCE(NULLIF(BTRIM(room_id::text), ''), $4) = $5
              ORDER BY window_end_ms DESC
              LIMIT $3",
            &[&uid, &coin_id, &limit, &ROOM_INITIAL_ID, &scope],
        )
        .await
    };

    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            // Table may be absent on fresh envs — empty history, not hard fail.
            let code = e.code().map(|c| c.code());
            if code == Some("42P01") {
                return Ok(Vec::new());
            }
            return Err(PlayerReadError::from(e));
        }
    };

    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "roomId": string_cell(r, "room_id"),
                "windowStartMs": i64_cell(r, "window_start_ms"),
                "windowEndMs": i64_cell(r, "window_end_ms"),
                "creditBlocks": i64_cell(r, "credit_blocks"),
                "amountCoins": f64_cell(r, "amount_coins"),
                "amountUsd": f64_cell(r, "amount_usd"),
                "userHashHps": f64_cell(r, "user_hash_hps"),
                "networkHashrate": f64_cell(r, "network_hashrate"),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_stable() {
        assert_eq!(MINING_PROJECTION_PATH, "/v1/mining/projection");
    }

    #[test]
    fn active_hash_prefers_live_when_live_ge_user() {
        assert!((resolve_active_hash_for_projection(100.0, 10.0) - 100.0).abs() < 1e-12);
    }

    #[test]
    fn active_hash_falls_back_to_user_when_live_zero() {
        assert!((resolve_active_hash_for_projection(0.0, 10.0) - 10.0).abs() < 1e-12);
    }

    #[test]
    fn active_hash_uses_user_when_live_undercounts_checkin() {
        // Live base-only can be < check-in-boosted user power; max prevents share>100%.
        assert!((resolve_active_hash_for_projection(50.0, 80.0) - 80.0).abs() < 1e-12);
    }

    #[test]
    fn normalize_scope_total() {
        assert_eq!(normalize_scope(None).unwrap(), SCOPE_TOTAL);
        assert_eq!(normalize_scope(Some("total")).unwrap(), SCOPE_TOTAL);
        assert_eq!(normalize_scope(Some(" TOTAL")).unwrap(), SCOPE_TOTAL);
    }
}
