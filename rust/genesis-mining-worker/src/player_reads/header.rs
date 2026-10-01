//! Player-game header — balances + per-coin hash / est coins-per-sec.
//!
//! Hash mapping mirrors Node `player-game-header-snapshot.ts` (slot credits +
//! check-in bonus + `aggregate_header_hash`). Est coins/sec = hash × latest
//! `yield_per_hash` from `mining_yield_history` (not daily/SECONDS_PER_DAY).

use std::collections::HashMap;

use deadpool_postgres::Pool;
use genesis_core::calculator::checkin_bonus::{
    effective_hash_with_checkin_bonus, sum_non_nft_room_rig_hash_hps,
};
use genesis_core::calculator::slot_credits::list_slot_mining_credits;
use genesis_core::calculator::types::{CalculatorUpgradeLite, CheckinHashEntry};
use genesis_core::checkin::is_checkin_frozen_for_mining;
use genesis_core::header::{aggregate_header_hash, HeaderHashEntry};
use genesis_core::mining_last_completed_ten_min_grid;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::MINED_COIN_AMOUNT_DECIMALS;
use crate::progress::resolve_premium_weekly_checkin;
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

use super::{
    f64_cell, i32_cell, i64_cell, now_ms, opt_string, pg_user_id, string_cell, PlayerReadError,
};

const _: () = assert!(MINED_COIN_AMOUNT_DECIMALS == 8);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderHighlightRequest {
    pub user_id: i64,
    #[serde(default)]
    pub coin_id: String,
}

/// Cap for the stored coin id (uuid / `coin_<ts>` — well under this).
const HIGHLIGHT_COIN_ID_MAX: usize = 64;

/// `PATCH /api/player-game/header/highlight` — persist the header's highlighted
/// mined coin to `game_states.header_highlight_coin_id`. Empty string clears it.
/// Client mirror: `client/src/shared/api/player-game.ts` `patchHeaderHighlightCoin`.
pub async fn run_header_highlight(
    pool: &Pool,
    user_id: i64,
    coin_id: &str,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let coin_id: String = coin_id.trim().chars().take(HIGHLIGHT_COIN_ID_MAX).collect();
    let conn = pool.get().await?;
    if !coin_id.is_empty() {
        let known = conn
            .query_opt(
                "SELECT 1 FROM mining_coins WHERE id = $1 AND is_active = 1",
                &[&coin_id],
            )
            .await?
            .is_some();
        if !known {
            return Err(PlayerReadError::bad("unknown or inactive coin"));
        }
    }
    let stored: Option<&str> = if coin_id.is_empty() {
        None
    } else {
        Some(coin_id.as_str())
    };
    conn.execute(
        "UPDATE game_states SET header_highlight_coin_id = $2 WHERE user_id = $1",
        &[&uid, &stored],
    )
    .await?;
    Ok(json!({ "headerHighlightCoinId": coin_id }))
}

pub async fn run_header(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let now = now_ms();
    let conn = pool.get().await?;
    let uid = match pg_user_id(user_id) {
        Ok(v) => v,
        Err(_) => return Ok(empty_header(now)),
    };
    let gs = conn
        .query_opt(
            "SELECT usdc::double precision AS usdc, server_updated_at,
                    COALESCE(header_highlight_coin_id, '') AS header_highlight_coin_id,
                    last_checkin_at_ms, checkin_bonus_hps::double precision AS checkin_bonus_hps
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(gs) = gs else {
        return Ok(empty_header(now));
    };
    let usdc = f64_cell(&gs, "usdc");
    let header_highlight_coin_id = string_cell(&gs, "header_highlight_coin_id");
    let server_updated_at = {
        let v = i64_cell(&gs, "server_updated_at");
        if v > 0 {
            v
        } else {
            now
        }
    };
    let last_checkin_raw = {
        let v = i64_cell(&gs, "last_checkin_at_ms");
        if v > 0 {
            Some(v)
        } else {
            None
        }
    };
    let checkin_bonus_hps = f64_cell(&gs, "checkin_bonus_hps").max(0.0);

    let bals = conn
        .query(
            "SELECT coin_id, amount::double precision AS amount FROM coin_balances WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    // Active mined-coin catalog for the header token strip / highlight picker
    // (Node `dashboard-stats.ts` miningCoins + client `PlayerGameMiningCoin`).
    let coin_rows = conn
        .query(
            "SELECT id, name, symbol, color, icon_url FROM mining_coins WHERE is_active = 1 ORDER BY name ASC, id ASC",
            &[],
        )
        .await?;
    let mining_coins: Vec<Value> = coin_rows
        .iter()
        .map(|r| {
            let id = string_cell(r, "id");
            let name = string_cell(r, "name");
            let name = if name.is_empty() { id.clone() } else { name };
            let symbol = string_cell(r, "symbol");
            let symbol = if symbol.is_empty() { name.clone() } else { symbol };
            json!({
                "id": id,
                "name": name,
                "symbol": symbol,
                "color": opt_string(r, "color"),
                "iconUrl": opt_string(r, "icon_url"),
            })
        })
        .collect();
    let scale = 10f64.powi(MINED_COIN_AMOUNT_DECIMALS);
    let mut coin_balances = serde_json::Map::new();
    for r in &bals {
        let amt = f64_cell(r, "amount");
        let rounded = if amt.is_finite() {
            (amt * scale).round() / scale
        } else {
            0.0
        };
        coin_balances.insert(string_cell(r, "coin_id"), json!(rounded));
    }

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

    let mut rigs_online = 0i64;
    for r in &racks {
        if rack_online_for_header(r) {
            rigs_online += 1;
        }
    }
    let rigs_total = racks.len() as i64;

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

    let nft_room_ids = resolve_nft_auto_room_ids(&*conn).await.map_err(PlayerReadError::from)?;
    let asic_room_ids = resolve_asic_room_ids(&*conn).await.map_err(PlayerReadError::from)?;

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

    let yield_rows = conn
        .query(
            "SELECT DISTINCT ON (coin_id) coin_id, yield_per_hash::double precision AS yield_per_hash
               FROM mining_yield_history
              WHERE yield_per_hash > 0
              ORDER BY coin_id, effective_at DESC",
            &[],
        )
        .await?;
    let mut yield_per_hash_by_coin: HashMap<String, f64> = HashMap::new();
    for r in &yield_rows {
        let coin_id = string_cell(r, "coin_id");
        let yph = f64_cell(r, "yield_per_hash");
        if coin_id.is_empty() || !yph.is_finite() || yph <= 0.0 {
            continue;
        }
        yield_per_hash_by_coin.insert(coin_id, yph);
    }

    drop(conn);

    let empty_slots: Vec<Option<String>> = Vec::new();
    let mut hash_entries: Vec<CheckinHashEntry> = Vec::new();
    for r in &racks {
        if !rack_operable_for_hash(r) {
            continue;
        }
        let rid: String = r.get("id");
        let room_id: Option<String> = r.try_get("room_id").ok();
        let selected: String = r
            .try_get::<_, String>("selected_coin_id")
            .unwrap_or_default();
        let item_id: Option<String> = r.try_get("item_id").ok();
        let credits = list_slot_mining_credits(
            room_id.as_deref(),
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
                room_id: room_id.clone(),
                base_hps: sc.effective_base_prod,
                counts_toward_general_power: sc.counts_toward_general_power,
            });
        }
    }

    let total_non_nft_rig_hash =
        sum_non_nft_room_rig_hash_hps(&hash_entries, &nft_room_ids, Some(&asic_room_ids));
    let agg_entries: Vec<HeaderHashEntry> = hash_entries
        .iter()
        .map(|entry| {
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
        })
        .collect();
    let agg = aggregate_header_hash(&agg_entries);

    let mut hash_by = serde_json::Map::new();
    let mut est = serde_json::Map::new();
    for (coin_id, hash) in &agg.hash_by_coin_id {
        hash_by.insert(coin_id.clone(), json!(hash));
        let Some(yph) = yield_per_hash_by_coin.get(coin_id).copied() else {
            continue;
        };
        if !hash.is_finite() || *hash <= 0.0 || !yph.is_finite() || yph <= 0.0 {
            continue;
        }
        est.insert(coin_id.clone(), json!(hash * yph));
    }

    Ok(json!({
        "coinBalances": coin_balances,
        "usdc": usdc,
        "hashByCoinId": hash_by,
        "totalHash": agg.total_hash,
        "serverUpdatedAt": server_updated_at,
        "rigsTotal": rigs_total,
        "rigsOnline": rigs_online,
        "estCoinsPerSecByCoinId": est,
        "liveAccrualAnchorMs": mining_last_completed_ten_min_grid(now),
        "miningCoins": mining_coins,
        "headerHighlightCoinId": header_highlight_coin_id,
    }))
}

fn empty_header(now: i64) -> Value {
    json!({
        "coinBalances": {},
        "usdc": 0,
        "hashByCoinId": {},
        "totalHash": 0,
        "serverUpdatedAt": now,
        "rigsTotal": 0,
        "rigsOnline": 0,
        "estCoinsPerSecByCoinId": {},
        "liveAccrualAnchorMs": mining_last_completed_ten_min_grid(now),
        "miningCoins": [],
        "headerHighlightCoinId": "",
    })
}

/// Online for header: is_on + battery only (matches TS `rigsOnline`; no wiring).
fn rack_online_for_header(r: &tokio_postgres::Row) -> bool {
    if i32_cell(r, "is_on") != 1 {
        return false;
    }
    !string_cell(r, "battery_id").is_empty()
}

/// Hash credits only when on + wiring + battery (TS header loop).
fn rack_operable_for_hash(r: &tokio_postgres::Row) -> bool {
    if i32_cell(r, "is_on") != 1 {
        return false;
    }
    let wiring = string_cell(r, "wiring_id");
    let battery = string_cell(r, "battery_id");
    !wiring.is_empty() && !battery.is_empty()
}
