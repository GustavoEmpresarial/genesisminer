//! `POST /v1/hardware/bulk-batteries` — Node `bulk-batteries.controller.ts`.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::{
    is_valid_room_id, parse_boolean_smart_fill, run_bulk_room_battery, BulkBatteryPrev, PlacedRack,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::config::current_unix_ms;
use crate::eligibility::{
    record_mining_eligibility_event, EligibilityEvent, EVENT_RACK_BATTERY_CHANGED,
    EVENT_RACK_POWER_CHANGED, IDENTITY_RACK,
};
use crate::intent_idem::{
    insert_intent_idem_success, validate_intent_idem_keys, IntentIdemError,
    GAME_INTENT_IDEM_FP_KEY, HTTP_OK, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_PAYLOAD_MISMATCH_CODE,
    IDEMPOTENCY_PAYLOAD_MISMATCH_ERROR,
};
use crate::load::{
    load_hardware_state, load_upgrades_with_compat, resolve_asic_room_ids, resolve_nft_room_ids,
};
use crate::persist::{persist_hardware, PersistInput, StockMode};
use crate::pg_types::pg_user_id;
use crate::post_apply::{
    sanitize_placed_racks_nft_auto_room, validate_placed_racks_for_save, PostApplyError,
};

pub const BULK_BATTERIES_PATH: &str = "/v1/hardware/bulk-batteries";

/// Node `STATEMENT_TIMEOUT_MS`.
pub const BULK_STATEMENT_TIMEOUT_MS: u64 = 20_000;
/// Node `LOCK_TIMEOUT_MS`.
pub const BULK_LOCK_TIMEOUT_MS: u64 = 45_000;
const IDEMPOTENCY_KEY_MIN_LENGTH: usize = 8;
const FINGERPRINT_HEX_LEN: usize = 32;
const HASH_INT32_BYTE_OFFSET: usize = 4;
const BULK_ELIGIBILITY_REASON: &str = "bulk_batteries";

const _: () = assert!(BULK_STATEMENT_TIMEOUT_MS == 20_000);
const _: () = assert!(BULK_LOCK_TIMEOUT_MS == 45_000);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkBatteriesRequest {
    pub user_id: i64,
    pub room_id: Option<Value>,
    pub battery_upgrade_id: Option<Value>,
    pub smart_fill: Option<Value>,
    pub rig_sort: Option<Value>,
    pub idempotency_key: Option<String>,
    pub client_state_version: Option<Value>,
}

#[derive(Debug)]
pub struct BulkBatteriesError {
    pub http_status: u16,
    pub body: Value,
}

fn bad(msg: impl Into<String>, code: Option<&str>) -> BulkBatteriesError {
    let mut body = json!({ "error": msg.into() });
    if let Some(c) = code {
        body["code"] = json!(c);
    }
    BulkBatteriesError {
        http_status: 400,
        body,
    }
}

fn conflict(msg: impl Into<String>, code: &str, extra: Value) -> BulkBatteriesError {
    let mut body = json!({ "error": msg.into(), "code": code });
    if let Value::Object(m) = extra {
        for (k, v) in m {
            body[k] = v;
        }
    }
    BulkBatteriesError {
        http_status: 409,
        body,
    }
}

fn internal(e: impl ToString) -> BulkBatteriesError {
    BulkBatteriesError {
        http_status: 500,
        body: json!({ "error": e.to_string() }),
    }
}

fn parse_idem_key(raw: Option<&str>) -> Result<String, BulkBatteriesError> {
    let s = raw.unwrap_or("").trim();
    if s.len() < IDEMPOTENCY_KEY_MIN_LENGTH || s.len() > IDEMPOTENCY_KEY_MAX_LEN {
        return Err(bad(
            "Invalid or missing idempotencyKey (8–128 safe characters).",
            Some("IDEMPOTENCY_KEY_REQUIRED"),
        ));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
    {
        return Err(bad(
            "Invalid or missing idempotencyKey (8–128 safe characters).",
            Some("IDEMPOTENCY_KEY_REQUIRED"),
        ));
    }
    Ok(s.to_string())
}

fn value_as_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn parse_client_state_version(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

fn bulk_scope(user_id: i64) -> String {
    format!("bulk_room_batt:{user_id}")
}

fn bulk_fp(room_norm: &str, battery_upgrade_id: &str, smart_fill: bool, rig_sort: &str) -> String {
    let mut map = serde_json::Map::new();
    map.insert("bat".into(), json!(battery_upgrade_id));
    map.insert("room".into(), json!(room_norm));
    map.insert("smart".into(), json!(smart_fill));
    map.insert("sort".into(), json!(rig_sort));
    let mut keys: Vec<_> = map.keys().cloned().collect();
    keys.sort();
    let mut ordered = serde_json::Map::new();
    for k in keys {
        if let Some(v) = map.remove(&k) {
            ordered.insert(k, v);
        }
    }
    let payload = Value::Object(ordered).to_string();
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
        .chars()
        .take(FINGERPRINT_HEX_LEN)
        .collect()
}

fn advisory_pair(user_id: i64, scope: &str, key: &str) -> (i32, i32) {
    let mut hasher = Sha256::new();
    hasher.update(user_id.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(scope.as_bytes());
    hasher.update([0u8]);
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let k1 = i32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let k2 = i32::from_be_bytes([
        digest[HASH_INT32_BYTE_OFFSET],
        digest[HASH_INT32_BYTE_OFFSET + 1],
        digest[HASH_INT32_BYTE_OFFSET + 2],
        digest[HASH_INT32_BYTE_OFFSET + 3],
    ]);
    (k1, k2)
}

fn strip_fp(mut body: Value) -> Value {
    if let Value::Object(ref mut m) = body {
        m.remove(GAME_INTENT_IDEM_FP_KEY);
    }
    body
}

fn replay_from_stored(stored: &Value, fp: &str) -> Result<Value, BulkBatteriesError> {
    let prev_fp = stored
        .get(GAME_INTENT_IDEM_FP_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !prev_fp.is_empty() && prev_fp != fp {
        return Err(conflict(
            IDEMPOTENCY_PAYLOAD_MISMATCH_ERROR,
            IDEMPOTENCY_PAYLOAD_MISMATCH_CODE,
            json!({}),
        ));
    }
    let mut out = strip_fp(stored.clone());
    if let Value::Object(ref mut m) = out {
        m.insert("idempotentReplay".into(), json!(true));
    }
    Ok(out)
}

async fn emit_deltas<C: GenericClient>(
    client: &C,
    user_id: i64,
    prev: &[PlacedRack],
    next: &[PlacedRack],
    at_ms: i64,
) -> anyhow::Result<()> {
    let prev_by: HashMap<&str, &PlacedRack> = prev.iter().map(|r| (r.id.as_str(), r)).collect();
    let next_by: HashMap<&str, &PlacedRack> = next.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut ids: HashSet<&str> = HashSet::new();
    ids.extend(prev_by.keys().copied());
    ids.extend(next_by.keys().copied());
    for rack_id in ids {
        let Some(prev_r) = prev_by.get(rack_id) else {
            continue;
        };
        let Some(next_r) = next_by.get(rack_id) else {
            continue;
        };
        let prev_bat = prev_r
            .battery_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let next_bat = next_r
            .battery_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let prev_cat = prev_r
            .battery_catalog_item_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let next_cat = next_r
            .battery_catalog_item_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if prev_bat != next_bat || prev_cat != next_cat {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id,
                    event_type: EVENT_RACK_BATTERY_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(rack_id),
                    slot_index: None,
                    catalog_item_id: if next_cat.is_empty() {
                        None
                    } else {
                        Some(next_cat.as_str())
                    },
                    coin_id: None,
                    payload: Some(json!({
                        "previous_battery_id": if prev_bat.is_empty() { Value::Null } else { json!(prev_bat) },
                        "next_battery_id": if next_bat.is_empty() { Value::Null } else { json!(next_bat) },
                        "previous_catalog_item_id": if prev_cat.is_empty() { Value::Null } else { json!(prev_cat) },
                        "next_catalog_item_id": if next_cat.is_empty() { Value::Null } else { json!(next_cat) },
                    })),
                },
            )
            .await?;
        }
        if prev_r.is_on != next_r.is_on {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id,
                    event_type: EVENT_RACK_POWER_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(rack_id),
                    slot_index: None,
                    catalog_item_id: None,
                    coin_id: None,
                    payload: Some(json!({
                        "is_on": next_r.is_on,
                        "previous": prev_r.is_on,
                        "reason": BULK_ELIGIBILITY_REASON,
                    })),
                },
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn run_bulk_batteries(
    pool: &Pool,
    req: BulkBatteriesRequest,
) -> Result<Value, BulkBatteriesError> {
    if req.user_id <= 0 {
        return Err(BulkBatteriesError {
            http_status: 401,
            body: json!({ "error": "Not authenticated", "code": "UNAUTHORIZED" }),
        });
    }
    let idem = parse_idem_key(req.idempotency_key.as_deref())?;
    let room_norm = normalize_placed_rack_room_id(&value_as_str(req.room_id.as_ref()));
    if !is_valid_room_id(&room_norm) {
        return Err(bad("Invalid room.", None));
    }
    let battery_upgrade_id = value_as_str(req.battery_upgrade_id.as_ref())
        .trim()
        .to_string();
    let smart = parse_boolean_smart_fill(req.smart_fill.as_ref().unwrap_or(&Value::Null));
    let rig_sort_raw = value_as_str(req.rig_sort.as_ref());
    let rig_sort = if rig_sort_raw == "hashrate_desc" {
        "hashrate_desc"
    } else {
        "slot_asc"
    };
    let fp = bulk_fp(&room_norm, &battery_upgrade_id, smart, rig_sort);
    let scope = bulk_scope(req.user_id);
    let client_state_version = parse_client_state_version(req.client_state_version.as_ref());
    let keys = validate_intent_idem_keys(&scope, &idem).map_err(|e| match e {
        IntentIdemError::Domain { error, .. } => bad(error, Some("IDEMPOTENCY_KEY_REQUIRED")),
        IntentIdemError::Transport(err) => internal(err),
    })?;
    let uid = pg_user_id(req.user_id).map_err(internal)?;

    let mut conn = pool.get().await.map_err(internal)?;

    // Outside-TX replay
    if let Some(r) = conn
        .query_opt(
            "SELECT http_status, response_json FROM game_servers_intent_idempotency
             WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3",
            &[&uid, &keys.scope, &keys.idempotency_key],
        )
        .await
        .map_err(internal)?
    {
        let status: i32 = r.get("http_status");
        let stored: Value = r.get("response_json");
        let out = replay_from_stored(&stored, &fp)?;
        if status == HTTP_OK {
            return Ok(out);
        }
        return Err(BulkBatteriesError {
            http_status: status as u16,
            body: out,
        });
    }

    let tx = conn.transaction().await.map_err(internal)?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = {BULK_STATEMENT_TIMEOUT_MS}; SET LOCAL lock_timeout = {BULK_LOCK_TIMEOUT_MS}"
    ))
    .await
    .map_err(internal)?;
    let (a, b) = advisory_pair(req.user_id, &scope, &idem);
    tx.execute("SELECT pg_advisory_xact_lock($1::int, $2::int)", &[&a, &b])
        .await
        .map_err(internal)?;

    if let Some(r) = tx
        .query_opt(
            "SELECT http_status, response_json FROM game_servers_intent_idempotency
             WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3",
            &[&uid, &keys.scope, &keys.idempotency_key],
        )
        .await
        .map_err(internal)?
    {
        let status: i32 = r.get("http_status");
        let stored: Value = r.get("response_json");
        let out = replay_from_stored(&stored, &fp).map_err(|e| e)?;
        let _ = tx.rollback().await;
        if status == HTTP_OK {
            return Ok(out);
        }
        return Err(BulkBatteriesError {
            http_status: status as u16,
            body: out,
        });
    }

    let t_ensure = current_unix_ms();
    tx.execute(
        "INSERT INTO game_states (user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed, last_updated_at, server_updated_at, black_market_balance)
         VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
         ON CONFLICT (user_id) DO NOTHING",
        &[&uid, &t_ensure],
    )
    .await
    .map_err(internal)?;
    tx.execute(
        "SELECT 1 FROM game_states WHERE user_id = $1 FOR UPDATE",
        &[&uid],
    )
    .await
    .map_err(internal)?;
    let gs = tx
        .query_one(
            "SELECT server_updated_at FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(internal)?;
    let db_version: i64 = gs.try_get("server_updated_at").unwrap_or(0);
    if let Some(csv) = client_state_version {
        if csv != db_version {
            let _ = tx.rollback().await;
            return Err(conflict(
                "Game state was updated. Reload and try again.",
                "STATE_VERSION_CONFLICT",
                json!({ "forceReload": true, "serverStateVersion": db_version }),
            ));
        }
    }

    let mut prev = load_hardware_state(&tx, req.user_id)
        .await
        .map_err(internal)?;
    let upgrades = load_upgrades_with_compat(&tx).await.map_err(internal)?;
    let nft_ids = resolve_nft_room_ids(&tx)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_nft_room_ids());
    let asic_ids = resolve_asic_room_ids(&tx)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_asic_room_ids());
    let now_ms = current_unix_ms();
    sanitize_placed_racks_nft_auto_room(
        &tx,
        req.user_id,
        &mut prev,
        &nft_ids,
        &asic_ids,
        &upgrades,
        now_ms,
    )
    .await
    .map_err(internal)?;

    let prev_for_bulk = BulkBatteryPrev {
        stock: prev.stock.clone(),
        stored_batteries: prev.stored_batteries.clone(),
        placed_racks: prev.placed_racks.clone(),
    };
    let out = run_bulk_room_battery(
        &prev_for_bulk,
        &room_norm,
        &battery_upgrade_id,
        &upgrades,
        smart,
        rig_sort,
    );
    if !out.ok {
        let _ = tx.rollback().await;
        if smart {
            return Err(BulkBatteriesError {
                http_status: 400,
                body: json!({
                    "error": "Could not apply smart fill in this room. Reload and try again.",
                    "code": "SMART_FILL_FAILED",
                    "forceReload": true,
                }),
            });
        }
        return Err(bad(
            out.message.unwrap_or_else(|| "Bulk failed.".into()),
            None,
        ));
    }
    let next = out.next.ok_or_else(|| bad("Bulk failed.", None))?;

    if let Err(e) =
        validate_placed_racks_for_save(&tx, &next.placed_racks, &nft_ids, &asic_ids).await
    {
        let _ = tx.rollback().await;
        return Err(match e {
            PostApplyError::Domain(msg) => bad(msg, None),
            PostApplyError::Transport(err) => internal(err),
        });
    }

    emit_deltas(
        &tx,
        req.user_id,
        &prev_for_bulk.placed_racks,
        &next.placed_racks,
        now_ms,
    )
    .await
    .map_err(internal)?;

    persist_hardware(
        &tx,
        PersistInput {
            user_id: req.user_id,
            stock: Some(next.stock.clone()),
            stock_mode: StockMode::Snapshot,
            stored_batteries: Some(next.stored_batteries.clone()),
            placed_racks: Some(next.placed_racks.clone()),
        },
    )
    .await
    .map_err(|e| {
        warn!(err = %e, "bulk-batteries persist");
        let msg = e.to_string();
        if msg.to_ascii_lowercase().contains("battery") {
            conflict(msg, "BATTERY_GUARD", json!({ "forceReload": true }))
        } else {
            internal(e)
        }
    })?;

    let final_at = current_unix_ms();
    tx.execute(
        "UPDATE game_states SET last_updated_at = $1, server_updated_at = $2 WHERE user_id = $3",
        &[&final_at, &final_at, &uid],
    )
    .await
    .map_err(internal)?;

    let mut response_body = json!({
        "ok": true,
        "serverUpdatedAt": final_at,
        "stateVersion": final_at,
        "stock": next.stock,
        "storedBatteries": next.stored_batteries,
        "placedRacks": next.placed_racks,
        "appliedRigs": out.applied_rigs,
        "compatibleRigs": out.compatible_rigs,
        "smartFill": out.smart_fill.unwrap_or(smart),
        "idempotentReplay": false,
    });
    response_body[GAME_INTENT_IDEM_FP_KEY] = json!(fp);

    if let Err(e) = insert_intent_idem_success(&tx, req.user_id, &keys, &response_body).await {
        warn!(err = ?e, "bulk-batteries idempotency write after success");
    }

    tx.commit().await.map_err(internal)?;
    Ok(strip_fp(response_body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_fp() {
        assert_eq!(BULK_BATTERIES_PATH, "/v1/hardware/bulk-batteries");
        let a = bulk_fp("room_a", "battery_estelar", false, "slot_asc");
        let b = bulk_fp("room_a", "battery_estelar", false, "slot_asc");
        assert_eq!(a, b);
        assert_eq!(a.len(), FINGERPRINT_HEX_LEN);
    }
}
