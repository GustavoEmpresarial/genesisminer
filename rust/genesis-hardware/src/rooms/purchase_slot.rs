//! Room slot purchase — USDC debit + `user_rig_rooms` unlock + idem in one TX.
//!
//! Mirrors Node `server/modules/rooms/services/rooms.ts` `purchaseRigRoomSlot`.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::config::current_unix_ms;
use crate::market::{
    assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH,
    TX_BUY_TIMEOUT_MS,
};
use crate::pg_types::pg_user_id;

use super::errors::{
    RoomsError, CODE_IDEMPOTENCY_KEY_REQUIRED, CODE_ROOM_ACCESS_DENIED,
    ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_IDEMPOTENCY_PAYLOAD_MISMATCH, ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_PRICE, ERR_MAX_CAPACITY, ERR_ROOM_ACCESS_DENIED, ERR_ROOM_NOT_AVAILABLE,
};

/// Node `PURCHASE_MAX_QUANTITY`.
pub const PURCHASE_MAX_QUANTITY: i64 = 50;
/// Node `PURCHASE_DEFAULT_QUANTITY`.
pub const PURCHASE_DEFAULT_QUANTITY: i64 = 1;
/// Node `PURCHASE_TX_TIMEOUT_MS`.
pub const PURCHASE_TX_TIMEOUT_MS: u64 = 25_000;
/// Node `LOCK_TIMEOUT_MS` (same as market buy lock).
pub const LOCK_TIMEOUT_MS: u64 = BUY_LOCK_TIMEOUT_MS;
/// Node `PERCENT_BASE`.
pub const PERCENT_BASE: f64 = 100.0;
/// Node `FINGERPRINT_LENGTH`.
pub const FINGERPRINT_HEX_LEN: usize = 32;
/// Node fingerprint op.
const FINGERPRINT_OP: &str = "room_slot_purchase";
/// Advisory lock scope.
const LOCK_SCOPE: &str = "room_slot_purchase";
/// Node room id max (regex `{1,120}`).
const ROOM_ID_MAX_LEN: usize = 120;

const _: () = assert!(PURCHASE_TX_TIMEOUT_MS == 25_000);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(TX_BUY_TIMEOUT_MS >= PURCHASE_TX_TIMEOUT_MS);

pub const ROOM_PURCHASE_SLOT_PATH: &str = "/v1/rooms/purchase-slot";

#[derive(Debug, Clone)]
pub struct PurchaseSlotOutcome {
    pub room_id: String,
    pub slots_purchased: i32,
    pub total_price: f64,
    pub new_usdc: f64,
    pub cached: bool,
}

fn normalize_idem_key(raw: &str) -> Result<String, RoomsError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(RoomsError::bad_code(
            ERR_IDEMPOTENCY_KEY_REQUIRED,
            CODE_IDEMPOTENCY_KEY_REQUIRED,
        ));
    }
    Ok(key)
}

fn is_valid_room_id(id: &str) -> bool {
    if id.is_empty() || id.len() > ROOM_ID_MAX_LEN {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-')
}

/// Node `stableIntentFingerprint({ op, roomId, quantity })`.
fn room_slot_fingerprint(room_id: &str, quantity: i64) -> String {
    let mut map = serde_json::Map::new();
    map.insert("op".to_string(), json!(FINGERPRINT_OP));
    map.insert("quantity".to_string(), json!(quantity));
    map.insert("roomId".to_string(), json!(room_id));
    let keys: Vec<String> = {
        let mut k: Vec<_> = map.keys().cloned().collect();
        k.sort();
        k
    };
    let mut ordered = serde_json::Map::new();
    for k in keys {
        if let Some(v) = map.get(&k) {
            ordered.insert(k, v.clone());
        }
    }
    let payload = serde_json::Value::Object(ordered).to_string();
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
        .chars()
        .take(FINGERPRINT_HEX_LEN)
        .collect()
}

fn parse_json_string_array(raw: Option<String>) -> Vec<String> {
    let Some(s) = raw.filter(|t| !t.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<serde_json::Value>(&s) {
        Ok(serde_json::Value::Array(arr)) => arr
            .into_iter()
            .map(|v| match v {
                serde_json::Value::String(x) => x,
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn room_access_allowed(
    allowed_plan_ids: &[String],
    allowed_pass_ids: &[String],
    plan_ids: &[String],
    pass_ids: &[String],
) -> bool {
    let plan_ok = allowed_plan_ids.is_empty()
        || allowed_plan_ids
            .iter()
            .any(|id| plan_ids.iter().any(|p| p == id));
    let season_ok = allowed_pass_ids.is_empty()
        || allowed_pass_ids
            .iter()
            .any(|id| pass_ids.iter().any(|p| p == id));
    plan_ok && season_ok
}

fn room_purchasable_remaining(initial: i32, max: i32, unlocked: i32) -> i32 {
    let initial = initial.max(0);
    let max = max.max(0);
    let unlocked = unlocked.max(0);
    let effective = (initial + unlocked).min(max);
    (max - effective).max(0)
}

pub async fn purchase_slot(
    pool: &Pool,
    user_id: i64,
    room_id: &str,
    quantity_raw: i64,
    idempotency_key: &str,
    server_now_ms: Option<i64>,
) -> Result<PurchaseSlotOutcome, RoomsError> {
    let room_id = room_id.trim();
    if !is_valid_room_id(room_id) {
        return Err(RoomsError::bad("Invalid room."));
    }
    let idem_key = normalize_idem_key(idempotency_key)?;
    let quantity = quantity_raw
        .max(PURCHASE_DEFAULT_QUANTITY)
        .min(PURCHASE_MAX_QUANTITY);
    let request_fp = room_slot_fingerprint(room_id, quantity);
    let now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(RoomsError::transport)?;

    let mut client = pool.get().await.map_err(RoomsError::transport)?;
    let tx = client.transaction().await.map_err(RoomsError::transport)?;

    let out = match run_inner(
        &tx,
        uid,
        user_id,
        room_id,
        quantity,
        &idem_key,
        &request_fp,
        now,
    )
    .await
    {
        Ok(o) => {
            tx.commit().await.map_err(RoomsError::transport)?;
            o
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };
    Ok(out)
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    room_id: &str,
    quantity: i64,
    idem_key: &str,
    request_fp: &str,
    now_ms: i64,
) -> Result<PurchaseSlotOutcome, RoomsError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {PURCHASE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(RoomsError::transport)?;
    client
        .execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"), &[])
        .await
        .map_err(RoomsError::transport)?;

    assert_active_user(client, user_id)
        .await
        .map_err(|e| match e {
            crate::market::errors::MarketError::Domain {
                status,
                error,
                code,
                ..
            } => RoomsError::Domain {
                status,
                error,
                code,
                missing: None,
            },
            crate::market::errors::MarketError::Transport(err) => RoomsError::Transport(err),
        })?;

    let lock_b = format!("{user_id}:{idem_key}");
    client
        .query(
            "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
            &[&LOCK_SCOPE, &lock_b],
        )
        .await
        .map_err(RoomsError::transport)?;

    let idem_rows = client
        .query(
            "SELECT room_id, slots_purchased, total_price::float8 AS total_price,
                    new_usdc::float8 AS new_usdc, request_fingerprint
               FROM room_slot_purchase_idempotency
              WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE",
            &[&uid, &idem_key],
        )
        .await
        .map_err(RoomsError::transport)?;
    if let Some(row) = idem_rows.first() {
        let st_fp: Option<String> = row.get("request_fingerprint");
        let st_fp = st_fp.unwrap_or_default().trim().to_string();
        if !st_fp.is_empty() && st_fp != request_fp {
            return Err(RoomsError::conflict_mismatch(
                ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
            ));
        }
        let cached_room: String = row.get("room_id");
        let slots: i32 = row.get("slots_purchased");
        let total: Option<f64> = row.get("total_price");
        let new_usdc: Option<f64> = row.get("new_usdc");
        return Ok(PurchaseSlotOutcome {
            room_id: cached_room,
            slots_purchased: slots,
            total_price: total.unwrap_or(0.0),
            new_usdc: new_usdc.unwrap_or(0.0),
            cached: true,
        });
    }

    client
        .query(
            "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&uid],
        )
        .await
        .map_err(RoomsError::transport)?;

    let room_rows = client
        .query(
            "SELECT id, is_active, initial_capacity, max_capacity,
                    base_slot_price::float8 AS base_slot_price,
                    slot_price_increase_percent::float8 AS slot_price_increase_percent,
                    allowed_levels, allowed_season_pass_ids
               FROM rig_rooms WHERE id = $1",
            &[&room_id],
        )
        .await
        .map_err(RoomsError::transport)?;
    let Some(room) = room_rows.first() else {
        return Err(RoomsError::not_found(ERR_ROOM_NOT_AVAILABLE));
    };
    let is_active: Option<i32> = room.get("is_active");
    if is_active.unwrap_or(0) == 0 {
        return Err(RoomsError::not_found(ERR_ROOM_NOT_AVAILABLE));
    }

    let allowed_levels: Option<String> = room.get("allowed_levels");
    let allowed_passes: Option<String> = room.get("allowed_season_pass_ids");
    let allowed_plan_ids = parse_json_string_array(allowed_levels);
    let allowed_pass_ids = parse_json_string_array(allowed_passes);

    let (plan_ids, pass_ids) = load_user_room_access(client, uid).await?;
    if !room_access_allowed(&allowed_plan_ids, &allowed_pass_ids, &plan_ids, &pass_ids) {
        return Err(RoomsError::unauthorized_code(
            ERR_ROOM_ACCESS_DENIED,
            CODE_ROOM_ACCESS_DENIED,
        ));
    }

    let user_room = client
        .query(
            "SELECT unlocked_slots FROM user_rig_rooms
              WHERE user_id = $1 AND room_id = $2 FOR UPDATE",
            &[&uid, &room_id],
        )
        .await
        .map_err(RoomsError::transport)?;
    let purchased_count: i32 = user_room
        .first()
        .and_then(|r| r.get::<_, Option<i32>>("unlocked_slots"))
        .unwrap_or(0);
    let initial: i32 = room.get("initial_capacity");
    let max_cap: i32 = room.get("max_capacity");
    let remaining = room_purchasable_remaining(initial, max_cap, purchased_count);
    if remaining < 1 {
        return Err(RoomsError::bad(ERR_MAX_CAPACITY));
    }

    let n = (quantity as i32).min(remaining);
    let base: Option<f64> = room.get("base_slot_price");
    let pct: Option<f64> = room.get("slot_price_increase_percent");
    let base = base.unwrap_or(0.0);
    let factor = 1.0 + pct.unwrap_or(0.0) / PERCENT_BASE;
    if !base.is_finite() || base < 0.0 || !factor.is_finite() || factor < 0.0 {
        return Err(RoomsError::bad(ERR_INVALID_PRICE));
    }
    let mut total_price = 0.0;
    for j in 0..n {
        total_price += base * factor.powi(purchased_count + j);
    }

    let gs = client
        .query(
            "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(RoomsError::transport)?;
    let bal = gs
        .first()
        .and_then(|r| r.get::<_, Option<f64>>("usdc"))
        .unwrap_or(0.0);
    if bal < total_price {
        return Err(RoomsError::insufficient(total_price - bal));
    }

    let debit = client
        .execute(
            "UPDATE game_states SET usdc = usdc - $1 WHERE user_id = $2 AND usdc >= $1",
            &[&total_price, &uid],
        )
        .await
        .map_err(RoomsError::transport)?;
    if debit == 0 {
        return Err(RoomsError::bad(ERR_INSUFFICIENT_BALANCE));
    }

    if user_room.first().is_some() {
        client
            .execute(
                "UPDATE user_rig_rooms SET unlocked_slots = unlocked_slots + $1
                  WHERE user_id = $2 AND room_id = $3",
                &[&n, &uid, &room_id],
            )
            .await
            .map_err(RoomsError::transport)?;
    } else {
        client
            .execute(
                "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
                 VALUES ($1, $2, $3, $4)",
                &[&uid, &room_id, &now_ms, &n],
            )
            .await
            .map_err(RoomsError::transport)?;
    }

    let final_gs = client
        .query(
            "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(RoomsError::transport)?;
    let new_usdc = final_gs
        .first()
        .and_then(|r| r.get::<_, Option<f64>>("usdc"))
        .unwrap_or(bal - total_price);

    client
        .execute(
            "INSERT INTO room_slot_purchase_idempotency
               (user_id, idempotency_key, room_id, slots_purchased, total_price, new_usdc,
                request_fingerprint, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[
                &uid,
                &idem_key,
                &room_id,
                &n,
                &total_price,
                &new_usdc,
                &request_fp,
                &now_ms,
            ],
        )
        .await
        .map_err(RoomsError::transport)?;

    Ok(PurchaseSlotOutcome {
        room_id: room_id.to_string(),
        slots_purchased: n,
        total_price,
        new_usdc,
        cached: false,
    })
}

async fn load_user_room_access<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<(Vec<String>, Vec<String>), RoomsError> {
    let user = client
        .query("SELECT access_level_id FROM users WHERE id = $1", &[&uid])
        .await
        .map_err(RoomsError::transport)?;
    let mut plan_ids: Vec<String> = Vec::new();
    if let Some(row) = user.first() {
        let al: Option<String> = row.get("access_level_id");
        if let Some(id) = al.filter(|s| !s.trim().is_empty()) {
            plan_ids.push(id);
        }
    }
    let grants = client
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(RoomsError::transport)?;
    for row in grants {
        let id: String = row.get("access_level_id");
        if !id.trim().is_empty() && !plan_ids.iter().any(|p| p == &id) {
            plan_ids.push(id);
        }
    }
    let passes = client
        .query(
            "SELECT pass_id FROM season_purchases WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(RoomsError::transport)?;
    let pass_ids: Vec<String> = passes
        .into_iter()
        .map(|r| r.get::<_, String>("pass_id"))
        .collect();
    Ok((plan_ids, pass_ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_stable_key_order() {
        let a = room_slot_fingerprint("room_a", 2);
        let b = room_slot_fingerprint("room_a", 2);
        assert_eq!(a, b);
        assert_eq!(a.len(), FINGERPRINT_HEX_LEN);
        assert_ne!(room_slot_fingerprint("room_a", 1), a);
    }

    #[test]
    fn purchasable_remaining() {
        assert_eq!(room_purchasable_remaining(4, 10, 0), 6);
        assert_eq!(room_purchasable_remaining(10, 10, 0), 0);
        assert_eq!(room_purchasable_remaining(0, 3, 0), 3);
    }

    #[test]
    fn access_gate() {
        assert!(room_access_allowed(&[], &[], &[], &[]));
        assert!(room_access_allowed(
            &["founder".into()],
            &[],
            &["founder".into()],
            &[]
        ));
        assert!(!room_access_allowed(
            &["founder".into()],
            &[],
            &["normal".into()],
            &[]
        ));
        assert!(!room_access_allowed(
            &["founder".into()],
            &["pass_a".into()],
            &["founder".into()],
            &[]
        ));
    }
}
