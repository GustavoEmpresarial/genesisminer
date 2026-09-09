//! Calculator snapshot I/O — port of `loadCalculatorComputeInput` + in-process
//! `genesis_core::calculator::compute_snapshot`.
//!
//! HTTP: `POST /v1/calculator/snapshot` body `{ userId, scope? }`.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use deadpool_postgres::Pool;
use genesis_core::calculator::compute_snapshot;
use genesis_core::calculator::constants::{
    BLOCK_HISTORY_LIMIT, ROOM_INITIAL_FALLBACK_NAME, ROOM_INITIAL_ID, SCOPE_TOTAL,
    SCOPE_TOTAL_UI_NAME,
};
use genesis_core::calculator::projection::network_hashrate_from_yield_per_hash;
use genesis_core::calculator::room_id::{
    is_valid_calculator_room_scope_id, normalize_placed_rack_room_id,
};
use genesis_core::calculator::types::{
    BlockHistoryRowInput, CalculatorComputeInput, CalculatorRackInput, CalculatorUpgradeLite,
    MiningCoinInput, PlayerCalculatorSnapshot, ScopeOption,
};
use genesis_core::checkin::is_checkin_frozen_for_mining;
use serde::{Deserialize, Serialize};
use tokio_postgres::error::SqlState;
use tracing::warn;

use crate::config::PG_UNDEFINED_TABLE;
use crate::progress::{load_live_network_hashrates, resolve_premium_weekly_checkin};
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

/// Node `snapshot.ts` `HTTP_UNPROCESSABLE_ENTITY`.
const HTTP_UNPROCESSABLE_ENTITY: u16 = 422;
/// Node `snapshot.ts` `HTTP_FORBIDDEN`.
const HTTP_FORBIDDEN: u16 = 403;
/// Worker internal failure.
const HTTP_INTERNAL: u16 = 500;
/// Node `snapshot.ts` `HTTP_UNPROCESSABLE_ENTITY` body.
const CODE_INVALID_SCOPE: &str = "INVALID_SCOPE";
/// Node `snapshot.ts` `HTTP_FORBIDDEN` body.
const CODE_FORBIDDEN_SCOPE: &str = "FORBIDDEN_SCOPE";
const MSG_INVALID_SCOPE: &str = "Invalid scope parameter.";
const MSG_FORBIDDEN_SCOPE: &str = "No access to this room.";

pub const CALCULATOR_SNAPSHOT_PATH: &str = "/v1/calculator/snapshot";

const _: () = assert!(HTTP_UNPROCESSABLE_ENTITY == 422);
const _: () = assert!(HTTP_FORBIDDEN == 403);
const _: () = assert!(BLOCK_HISTORY_LIMIT == 120);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorSnapshotRequest {
    pub user_id: i64,
    pub scope: Option<String>,
}

/// Full GET `/api/calculator/me` JSON (`ok` + snapshot fields).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorSnapshotResponse {
    pub ok: bool,
    #[serde(flatten)]
    pub snapshot: PlayerCalculatorSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorSnapshotErrorBody {
    pub ok: bool,
    pub error: String,
    pub code: String,
}

#[derive(Debug)]
pub struct CalculatorApiError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl CalculatorApiError {
    fn invalid_scope() -> Self {
        Self {
            http_status: HTTP_UNPROCESSABLE_ENTITY,
            code: CODE_INVALID_SCOPE,
            message: MSG_INVALID_SCOPE.to_string(),
        }
    }

    fn forbidden_scope() -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            code: CODE_FORBIDDEN_SCOPE,
            message: MSG_FORBIDDEN_SCOPE.to_string(),
        }
    }

    fn internal(msg: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            code: "CALCULATOR_IO",
            message: msg.into(),
        }
    }

    pub fn to_body(&self) -> CalculatorSnapshotErrorBody {
        CalculatorSnapshotErrorBody {
            ok: false,
            error: self.message.clone(),
            code: self.code.to_string(),
        }
    }
}

#[derive(Debug)]
enum ScopeParse {
    Ok(String),
    Invalid,
}

fn parse_scope(raw: Option<&str>) -> ScopeParse {
    let Some(raw) = raw else {
        return ScopeParse::Ok(SCOPE_TOTAL.to_string());
    };
    let t = raw.trim();
    if t.is_empty() || t.eq_ignore_ascii_case(SCOPE_TOTAL) {
        return ScopeParse::Ok(SCOPE_TOTAL.to_string());
    }
    if !is_valid_calculator_room_scope_id(t) {
        return ScopeParse::Invalid;
    }
    ScopeParse::Ok(normalize_placed_rack_room_id(t))
}

fn sort_room_ids(ids: &mut [String]) {
    ids.sort_by(|a, b| {
        if a == ROOM_INITIAL_ID {
            return std::cmp::Ordering::Less;
        }
        if b == ROOM_INITIAL_ID {
            return std::cmp::Ordering::Greater;
        }
        a.cmp(b)
    });
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn row_f64(row: &tokio_postgres::Row, col: &str) -> f64 {
    row.try_get::<_, f64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(|v| v as f64))
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v as f64))
        .unwrap_or(0.0)
}

fn row_i32(row: &tokio_postgres::Row, col: &str) -> i32 {
    row.try_get::<_, i32>(col)
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v as i32))
        .or_else(|_| row.try_get::<_, f64>(col).map(|v| v as i32))
        .unwrap_or(0)
}

fn row_i64_opt(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    row.try_get::<_, i64>(col)
        .ok()
        .or_else(|| row.try_get::<_, i32>(col).ok().map(|v| v as i64))
        .or_else(|| {
            row.try_get::<_, f64>(col)
                .ok()
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| v as i64)
        })
        .filter(|&v| v > 0)
}

fn row_opt_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    row.try_get::<_, Option<String>>(col)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<_, String>(col).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn pg_undefined_table(err: &tokio_postgres::Error) -> bool {
    err.code().is_some_and(|c| c == &SqlState::UNDEFINED_TABLE)
        || err
            .code()
            .map(|c| c.code() == PG_UNDEFINED_TABLE)
            .unwrap_or(false)
}

fn build_indexed_slots(
    rack_id: &str,
    rows: &[(String, i32, Option<String>)],
) -> Vec<Option<String>> {
    let mine: Vec<&(String, i32, Option<String>)> =
        rows.iter().filter(|(rid, _, _)| rid == rack_id).collect();
    if mine.is_empty() {
        return Vec::new();
    }
    let max = mine.iter().map(|(_, idx, _)| *idx).max().unwrap_or(0);
    if max < 0 {
        return Vec::new();
    }
    let len = usize::try_from(max).unwrap_or(0).saturating_add(1);
    let mut arr = vec![None; len];
    for (_, idx, item) in mine {
        if *idx < 0 {
            continue;
        }
        if let Ok(i) = usize::try_from(*idx) {
            if i < arr.len() {
                arr[i] = item.clone();
            }
        }
    }
    arr
}

async fn load_implied_network(
    client: &tokio_postgres::Client,
    block_time_by_coin: &HashMap<String, f64>,
) -> Result<HashMap<String, f64>, tokio_postgres::Error> {
    let rows = match client
        .query(
            r#"SELECT DISTINCT ON (coin_id)
                    coin_id,
                    yield_per_hash,
                    block_reward,
                    network_hashrate
               FROM mining_yield_history
              WHERE yield_per_hash > 0
              ORDER BY coin_id, effective_at DESC"#,
            &[],
        )
        .await
    {
        Ok(r) => r,
        Err(e) if pg_undefined_table(&e) => return Ok(HashMap::new()),
        Err(e) => return Err(e),
    };
    let mut out = HashMap::new();
    for row in rows {
        let coin_id: String = row.try_get("coin_id").unwrap_or_default();
        let coin_id = coin_id.trim().to_string();
        if coin_id.is_empty() {
            continue;
        }
        let bt = block_time_by_coin.get(&coin_id).copied().unwrap_or(0.0);
        let implied = network_hashrate_from_yield_per_hash(
            row_f64(&row, "yield_per_hash"),
            row_f64(&row, "block_reward"),
            bt,
        );
        if implied > 0.0 {
            out.insert(coin_id, implied);
            continue;
        }
        let stored = row_f64(&row, "network_hashrate");
        if stored.is_finite() && stored > 0.0 {
            out.insert(coin_id, stored);
        }
    }
    Ok(out)
}

async fn load_block_history(
    client: &tokio_postgres::Client,
    user_id: i32,
    scope: &str,
) -> Result<Vec<BlockHistoryRowInput>, tokio_postgres::Error> {
    let limit = i64::try_from(BLOCK_HISTORY_LIMIT).unwrap_or(i64::MAX);
    let rows = if scope == SCOPE_TOTAL {
        match client
            .query(
                r#"SELECT
                      id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
                      amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time
                   FROM mining_block_history
                  WHERE user_id = $1
                  ORDER BY window_end_ms DESC
                  LIMIT $2"#,
                &[&user_id, &limit],
            )
            .await
        {
            Ok(r) => r,
            Err(e) if pg_undefined_table(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        }
    } else {
        let scope_norm = normalize_placed_rack_room_id(scope);
        match client
            .query(
                r#"SELECT
                      id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
                      amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time
                   FROM mining_block_history
                  WHERE user_id = $1
                    AND (
                      CASE
                        WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = '' OR BTRIM(room_id) = 'main'
                          THEN $3
                        ELSE BTRIM(room_id)
                      END
                    ) = $4
                  ORDER BY window_end_ms DESC
                  LIMIT $2"#,
                &[&user_id, &limit, &ROOM_INITIAL_ID, &scope_norm],
            )
            .await
        {
            Ok(r) => r,
            Err(e) if pg_undefined_table(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        }
    };
    Ok(rows
        .iter()
        .map(|row| {
            let id = row
                .try_get::<_, String>("id")
                .or_else(|_| row.try_get::<_, i64>("id").map(|v| v.to_string()))
                .or_else(|_| row.try_get::<_, i32>("id").map(|v| v.to_string()))
                .unwrap_or_default();
            BlockHistoryRowInput {
                id,
                coin_id: row.try_get("coin_id").unwrap_or_default(),
                room_id: row_opt_string(row, "room_id"),
                window_start_ms: row_f64(row, "window_start_ms"),
                window_end_ms: row_f64(row, "window_end_ms"),
                credit_blocks: row_f64(row, "credit_blocks"),
                amount_coins: row_f64(row, "amount_coins"),
                amount_usd: row_f64(row, "amount_usd"),
                user_hash_hps: row_f64(row, "user_hash_hps"),
                network_hashrate: row_f64(row, "network_hashrate"),
                block_reward: row_f64(row, "block_reward"),
                block_time: row_f64(row, "block_time"),
            }
        })
        .collect())
}

fn snapshot_ok(snap: PlayerCalculatorSnapshot) -> CalculatorSnapshotResponse {
    CalculatorSnapshotResponse {
        ok: true,
        snapshot: snap,
    }
}

pub async fn run_calculator_snapshot(
    pool: &Pool,
    user_id: i64,
    scope_raw: Option<&str>,
) -> Result<CalculatorSnapshotResponse, CalculatorApiError> {
    let scope = match parse_scope(scope_raw) {
        ScopeParse::Ok(s) => s,
        ScopeParse::Invalid => return Err(CalculatorApiError::invalid_scope()),
    };
    let user_id_i32: i32 = i32::try_from(user_id).map_err(|_| {
        CalculatorApiError::internal(format!("user_id out of int4 range: {user_id}"))
    })?;

    let client = pool
        .get()
        .await
        .map_err(|e| CalculatorApiError::internal(format!("pg pool: {e}")))?;

    let owned_rows = client
        .query(
            "SELECT room_id FROM user_rig_rooms WHERE user_id = $1",
            &[&user_id_i32],
        )
        .await
        .map_err(|e| CalculatorApiError::internal(format!("user_rig_rooms: {e}")))?;
    let owned_set: HashSet<String> = owned_rows
        .iter()
        .filter_map(|r| row_opt_string(r, "room_id"))
        .map(|id| normalize_placed_rack_room_id(&id))
        .collect();

    let rack_rows = client
        .query(
            r#"SELECT id, item_id, wiring_id, battery_id, battery_catalog_item_id,
                      is_on, selected_coin_id, room_id
                 FROM placed_racks WHERE user_id = $1"#,
            &[&user_id_i32],
        )
        .await
        .map_err(|e| CalculatorApiError::internal(format!("placed_racks: {e}")))?;

    if scope != SCOPE_TOTAL {
        let scope_norm = normalize_placed_rack_room_id(&scope);
        let has_rack = rack_rows.iter().any(|r| {
            normalize_placed_rack_room_id(row_opt_string(r, "room_id").as_deref().unwrap_or(""))
                == scope_norm
        });
        if !has_rack && !owned_set.contains(&scope_norm) {
            return Err(CalculatorApiError::forbidden_scope());
        }
    }

    let gs = client
        .query_opt(
            "SELECT last_checkin_at_ms, checkin_bonus_hps FROM game_states WHERE user_id = $1",
            &[&user_id_i32],
        )
        .await
        .map_err(|e| CalculatorApiError::internal(format!("game_states: {e}")))?;
    let last_checkin = gs
        .as_ref()
        .and_then(|r| row_i64_opt(r, "last_checkin_at_ms"));
    let checkin_bonus_raw = gs
        .as_ref()
        .map(|r| row_f64(r, "checkin_bonus_hps"))
        .unwrap_or(0.0);
    let premium = resolve_premium_weekly_checkin(&client, user_id_i32).await;
    let checkin_frozen = is_checkin_frozen_for_mining(
        last_checkin,
        now_ms(),
        premium.premium_weekly,
        premium.interval_days,
    );
    let checkin_bonus_hps = if checkin_frozen {
        0.0
    } else {
        checkin_bonus_raw.max(0.0)
    };

    let rack_ids: Vec<String> = rack_rows
        .iter()
        .filter_map(|r| r.try_get::<_, String>("id").ok())
        .collect();
    let mut distinct_rooms: Vec<String> = rack_rows
        .iter()
        .map(|r| {
            normalize_placed_rack_room_id(row_opt_string(r, "room_id").as_deref().unwrap_or(""))
        })
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    sort_room_ids(&mut distinct_rooms);

    let slot_rows = if rack_ids.is_empty() {
        Vec::new()
    } else {
        client
            .query(
                "SELECT rack_id, slot_index, machine_item_id FROM rack_slots WHERE rack_id = ANY($1)",
                &[&rack_ids],
            )
            .await
            .map_err(|e| CalculatorApiError::internal(format!("rack_slots: {e}")))?
    };
    let mult_rows = if rack_ids.is_empty() {
        Vec::new()
    } else {
        client
            .query(
                "SELECT rack_id, slot_index, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1)",
                &[&rack_ids],
            )
            .await
            .map_err(|e| CalculatorApiError::internal(format!("rack_multiplier_slots: {e}")))?
    };

    let slot_tuples: Vec<(String, i32, Option<String>)> = slot_rows
        .iter()
        .map(|r| {
            (
                r.try_get("rack_id").unwrap_or_default(),
                row_i32(r, "slot_index"),
                row_opt_string(r, "machine_item_id"),
            )
        })
        .collect();
    let mult_tuples: Vec<(String, i32, Option<String>)> = mult_rows
        .iter()
        .map(|r| {
            (
                r.try_get("rack_id").unwrap_or_default(),
                row_i32(r, "slot_index"),
                row_opt_string(r, "multiplier_item_id"),
            )
        })
        .collect();

    let coin_rows = client
        .query(
            r#"SELECT id, name, symbol, network_hashrate, block_reward, block_time,
                      price_usd, usdc_rate, nft_room_only,
                      distribution_mode, distribution_usd_month
                 FROM mining_coins
                WHERE is_active = 1
                ORDER BY name ASC"#,
            &[],
        )
        .await
        .map_err(|e| CalculatorApiError::internal(format!("mining_coins: {e}")))?;

    let coins: Vec<MiningCoinInput> = coin_rows
        .iter()
        .map(|c| {
            let id: String = c.try_get("id").unwrap_or_default();
            let name: String = c.try_get("name").unwrap_or_else(|_| id.clone());
            let symbol: String = c.try_get("symbol").unwrap_or_else(|_| name.clone());
            MiningCoinInput {
                id,
                name,
                symbol,
                network_hashrate: row_f64(c, "network_hashrate"),
                block_reward: row_f64(c, "block_reward"),
                block_time: row_f64(c, "block_time"),
                price_usd: row_f64(c, "price_usd"),
                usdc_rate: row_f64(c, "usdc_rate"),
                nft_room_only: row_i32(c, "nft_room_only") != 0,
                distribution_mode: genesis_core::mining::DistributionMode::parse(
                    &c.try_get::<_, Option<String>>("distribution_mode")
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                ),
                distribution_usd_month: row_f64(c, "distribution_usd_month"),
            }
        })
        .collect();

    let rig_meta = if distinct_rooms.is_empty() {
        Vec::new()
    } else {
        client
            .query(
                "SELECT id, name FROM rig_rooms WHERE id = ANY($1) AND is_active = 1",
                &[&distinct_rooms],
            )
            .await
            .map_err(|e| CalculatorApiError::internal(format!("rig_rooms: {e}")))?
    };
    let mut rig_name_by_id: HashMap<String, String> = HashMap::new();
    for r in &rig_meta {
        let id: String = r.try_get("id").unwrap_or_default();
        let name: String = r.try_get("name").unwrap_or_else(|_| id.clone());
        let name = if name.trim().is_empty() {
            id.clone()
        } else {
            name
        };
        rig_name_by_id.insert(id, name);
    }

    let block_history_rows = load_block_history(&client, user_id_i32, &scope)
        .await
        .map_err(|e| CalculatorApiError::internal(format!("mining_block_history: {e}")))?;
    let nft_room_ids = resolve_nft_auto_room_ids(&client)
        .await
        .map_err(|e| CalculatorApiError::internal(format!("nft rooms: {e}")))?;
    let asic_room_ids = resolve_asic_room_ids(&client)
        .await
        .map_err(|e| CalculatorApiError::internal(format!("asic rooms: {e}")))?;

    let mut upgrade_ids: HashSet<String> = HashSet::new();
    for r in &rack_rows {
        if let Some(v) = row_opt_string(r, "item_id") {
            upgrade_ids.insert(v);
        }
        if let Some(v) = row_opt_string(r, "wiring_id") {
            upgrade_ids.insert(v);
        }
        if let Some(v) = row_opt_string(r, "battery_id") {
            upgrade_ids.insert(v);
        }
        if let Some(v) = row_opt_string(r, "battery_catalog_item_id") {
            upgrade_ids.insert(v);
        }
    }
    for (_, _, item) in &slot_tuples {
        if let Some(v) = item {
            upgrade_ids.insert(v.clone());
        }
    }
    for (_, _, item) in &mult_tuples {
        if let Some(v) = item {
            upgrade_ids.insert(v.clone());
        }
    }

    let upgrade_id_vec: Vec<String> = upgrade_ids.into_iter().collect();
    let mut upgrades_by_id: HashMap<String, CalculatorUpgradeLite> = HashMap::new();
    if !upgrade_id_vec.is_empty() {
        let up_rows = client
            .query(
                r#"SELECT id, type, category, base_production, multiplier, power_capacity, nft_mining_coin_id
                     FROM upgrades WHERE id = ANY($1)"#,
                &[&upgrade_id_vec],
            )
            .await
            .map_err(|e| CalculatorApiError::internal(format!("upgrades: {e}")))?;
        for row in &up_rows {
            let id: String = row.try_get("id").unwrap_or_default();
            let nft = row_opt_string(row, "nft_mining_coin_id");
            upgrades_by_id.insert(
                id.clone(),
                CalculatorUpgradeLite {
                    id,
                    upgrade_type: row.try_get("type").unwrap_or_default(),
                    category: row.try_get("category").ok(),
                    base_production: row_f64(row, "base_production"),
                    multiplier: {
                        let m = row_f64(&row, "multiplier");
                        if row.try_get::<_, f64>("multiplier").is_ok()
                            || row.try_get::<_, i32>("multiplier").is_ok()
                        {
                            Some(m)
                        } else {
                            None
                        }
                    },
                    power_capacity: {
                        if row.try_get::<_, f64>("power_capacity").is_ok()
                            || row.try_get::<_, i32>("power_capacity").is_ok()
                        {
                            Some(row_f64(row, "power_capacity"))
                        } else {
                            None
                        }
                    },
                    nft_mining_coin_id: nft,
                },
            );
        }
    }

    let racks: Vec<CalculatorRackInput> = rack_rows
        .iter()
        .map(|r| {
            let id: String = r.try_get("id").unwrap_or_default();
            CalculatorRackInput {
                item_id: row_opt_string(r, "item_id"),
                room_id: row_opt_string(r, "room_id"),
                wiring_id: row_opt_string(r, "wiring_id"),
                battery_id: row_opt_string(r, "battery_id"),
                battery_catalog_item_id: row_opt_string(r, "battery_catalog_item_id"),
                is_on: row_i32(r, "is_on") != 0,
                selected_coin_id: row_opt_string(r, "selected_coin_id"),
                slots: build_indexed_slots(&id, &slot_tuples),
                multiplier_slots: build_indexed_slots(&id, &mult_tuples),
            }
        })
        .collect();

    let mut scopes_ui = vec![ScopeOption {
        id: SCOPE_TOTAL.to_string(),
        name: SCOPE_TOTAL_UI_NAME.to_string(),
    }];
    for rid in &distinct_rooms {
        let name = rig_name_by_id.get(rid).cloned().unwrap_or_else(|| {
            if rid == ROOM_INITIAL_ID {
                ROOM_INITIAL_FALLBACK_NAME.to_string()
            } else {
                rid.clone()
            }
        });
        scopes_ui.push(ScopeOption {
            id: rid.clone(),
            name,
        });
    }

    let block_time_by_coin: HashMap<String, f64> =
        coins.iter().map(|c| (c.id.clone(), c.block_time)).collect();
    let implied_network_by_coin = load_implied_network(&client, &block_time_by_coin)
        .await
        .map_err(|e| CalculatorApiError::internal(format!("mining_yield_history: {e}")))?;
    let runtime_network_by_coin = load_live_network_hashrates(&client).await;

    let input = CalculatorComputeInput {
        scope,
        scopes_ui,
        checkin_frozen,
        checkin_bonus_hps,
        racks,
        upgrades_by_id,
        coins,
        nft_room_ids: nft_room_ids.into_iter().collect(),
        asic_room_ids: asic_room_ids.into_iter().collect(),
        runtime_network_by_coin,
        implied_network_by_coin,
        block_history_rows,
    };

    Ok(snapshot_ok(compute_snapshot(&input)))
}

pub fn warn_if_server_error(err: &CalculatorApiError) {
    if err.http_status >= HTTP_INTERNAL {
        warn!(err = %err.message, "calculator snapshot failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scope_total_defaults() {
        assert!(matches!(parse_scope(None), ScopeParse::Ok(s) if s == SCOPE_TOTAL));
        assert!(matches!(parse_scope(Some("")), ScopeParse::Ok(s) if s == SCOPE_TOTAL));
        assert!(matches!(parse_scope(Some("TOTAL")), ScopeParse::Ok(s) if s == SCOPE_TOTAL));
    }

    #[test]
    fn parse_scope_rejects_invalid() {
        assert!(matches!(
            parse_scope(Some("sala com espaço!")),
            ScopeParse::Invalid
        ));
        assert!(matches!(parse_scope(Some("room id")), ScopeParse::Invalid));
    }

    #[test]
    fn parse_scope_normalizes_main() {
        assert!(matches!(parse_scope(Some("main")), ScopeParse::Ok(s) if s == ROOM_INITIAL_ID));
        assert!(matches!(
            parse_scope(Some("room_nft")),
            ScopeParse::Ok(s) if s == "room_nft"
        ));
    }
}
