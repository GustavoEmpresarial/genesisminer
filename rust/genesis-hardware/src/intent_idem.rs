//! `game_servers_intent_idempotency` inside the hardware intent TX.
//!
//! Replay short-circuits apply. Success INSERT is the same commit as persist.
//! Do **not** lock `game_states` here — Node already holds `FOR UPDATE` on that row.

use std::collections::HashMap;

use deadpool_postgres::GenericClient;
use genesis_core::hardware::types::{PlacedRack, StoredBattery};
use serde::Deserialize;
use tracing::warn;

use crate::pg_types::pg_user_id;

/// Prisma `game_servers_intent_idempotency.scope` `VarChar(64)`.
pub const INTENT_IDEM_SCOPE_MAX_LEN: usize = 64;
/// Same as Node `IDEMPOTENCY_KEY_MAX_LENGTH` in `idempotency-key.ts`.
pub const IDEMPOTENCY_KEY_MAX_LEN: usize = 128;
/// Same as Node `GAME_INTENT_IDEM_FP_KEY`.
pub const GAME_INTENT_IDEM_FP_KEY: &str = "_idemRequestFp";
/// Same as Node `HTTP_OK`.
pub const HTTP_OK: i32 = 200;
/// Same as Node `HTTP_BAD_REQUEST` (empty / over-max scope or key).
pub const HTTP_BAD_REQUEST: i32 = 400;
/// Same as Node `HTTP_CONFLICT` (fingerprint mismatch).
pub const HTTP_CONFLICT: i32 = 409;

pub const IDEMPOTENCY_PAYLOAD_MISMATCH_ERROR: &str =
    "Same idempotency key with a different request.";
pub const IDEMPOTENCY_PAYLOAD_MISMATCH_CODE: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";

const ERR_INVALID_INTENT_IDEM: &str = "Invalid idempotency scope or key.";

#[derive(Debug)]
pub enum IntentIdemError {
    Domain { http_status: i32, error: String },
    Transport(anyhow::Error),
}

impl IntentIdemError {
    fn invalid_keys() -> Self {
        Self::Domain {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_INVALID_INTENT_IDEM.to_string(),
        }
    }

    fn mismatch() -> Self {
        Self::Domain {
            http_status: HTTP_CONFLICT,
            error: IDEMPOTENCY_PAYLOAD_MISMATCH_ERROR.to_string(),
        }
    }
}

impl From<tokio_postgres::Error> for IntentIdemError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}

#[derive(Debug, Clone)]
pub struct IntentIdemKeys {
    pub scope: String,
    pub idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentIdemReplay {
    #[serde(default)]
    pub ok: bool,
    pub stock: Option<HashMap<String, i64>>,
    pub stored_batteries: Option<Vec<StoredBattery>>,
    pub placed_racks: Option<Vec<PlacedRack>>,
}

pub enum IntentIdemLookup {
    Miss,
    Replay(IntentIdemReplay),
}

pub fn validate_intent_idem_keys(
    scope: &str,
    key: &str,
) -> Result<IntentIdemKeys, IntentIdemError> {
    let scope = scope.trim();
    let key = key.trim();
    if scope.is_empty() || scope.len() > INTENT_IDEM_SCOPE_MAX_LEN {
        return Err(IntentIdemError::invalid_keys());
    }
    if key.is_empty() || key.len() > IDEMPOTENCY_KEY_MAX_LEN {
        return Err(IntentIdemError::invalid_keys());
    }
    Ok(IntentIdemKeys {
        scope: scope.to_string(),
        idempotency_key: key.to_string(),
    })
}

/// True when stored `_idemRequestFp` and the request fingerprint are both non-empty and differ.
pub fn fingerprints_mismatch(stored_json: &serde_json::Value, request_fp: Option<&str>) -> bool {
    let stored = stored_json
        .get(GAME_INTENT_IDEM_FP_KEY)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let req = request_fp.map(str::trim).filter(|s| !s.is_empty());
    match (stored, req) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    }
}

pub fn build_success_response_json(
    stock: &HashMap<String, i64>,
    stored_batteries: &[StoredBattery],
    placed_racks: &[PlacedRack],
    scope: &str,
    rack_id: &str,
    request_fingerprint: Option<&str>,
    now_ms: i64,
) -> serde_json::Value {
    let mut v = serde_json::json!({
        "ok": true,
        "serverUpdatedAt": now_ms,
        "stateVersion": now_ms,
        "stock": stock,
        "storedBatteries": stored_batteries,
        "placedRacks": placed_racks,
        "scope": scope,
        "rackId": rack_id,
    });
    if let Some(fp) = request_fingerprint.map(str::trim).filter(|s| !s.is_empty()) {
        v[GAME_INTENT_IDEM_FP_KEY] = serde_json::Value::String(fp.to_string());
    }
    v
}

pub async fn lookup_intent_idem<C: GenericClient>(
    client: &C,
    user_id: i64,
    keys: &IntentIdemKeys,
    request_fingerprint: Option<&str>,
) -> Result<IntentIdemLookup, IntentIdemError> {
    let uid = pg_user_id(user_id).map_err(IntentIdemError::Transport)?;
    let row = client
        .query_opt(
            "SELECT http_status, response_json FROM game_servers_intent_idempotency \
             WHERE user_id=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE",
            &[&uid, &keys.scope, &keys.idempotency_key],
        )
        .await?;
    let Some(row) = row else {
        return Ok(IntentIdemLookup::Miss);
    };
    let stored: serde_json::Value = row.try_get("response_json")?;
    if fingerprints_mismatch(&stored, request_fingerprint) {
        warn!(
            code = IDEMPOTENCY_PAYLOAD_MISMATCH_CODE,
            "hardware intent idem fingerprint mismatch"
        );
        return Err(IntentIdemError::mismatch());
    }
    let replay: IntentIdemReplay = serde_json::from_value(stored).map_err(|e| {
        IntentIdemError::Transport(anyhow::anyhow!("intent idempotency replay json: {e}"))
    })?;
    Ok(IntentIdemLookup::Replay(replay))
}

pub async fn insert_intent_idem_success<C: GenericClient>(
    client: &C,
    user_id: i64,
    keys: &IntentIdemKeys,
    response_json: &serde_json::Value,
) -> Result<(), IntentIdemError> {
    let uid = pg_user_id(user_id).map_err(IntentIdemError::Transport)?;
    client
        .execute(
            "INSERT INTO game_servers_intent_idempotency \
             (user_id, scope, idempotency_key, http_status, response_json) \
             VALUES ($1,$2,$3,$4,$5::jsonb)",
            &[
                &uid,
                &keys.scope,
                &keys.idempotency_key,
                &HTTP_OK,
                response_json,
            ],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_and_key_max_match_schema() {
        assert_eq!(INTENT_IDEM_SCOPE_MAX_LEN, 64);
        assert_eq!(IDEMPOTENCY_KEY_MAX_LEN, 128);
        assert_eq!(GAME_INTENT_IDEM_FP_KEY, "_idemRequestFp");
        assert_eq!(HTTP_OK, 200);
        assert_eq!(
            IDEMPOTENCY_PAYLOAD_MISMATCH_ERROR,
            "Same idempotency key with a different request."
        );
        assert_eq!(
            IDEMPOTENCY_PAYLOAD_MISMATCH_CODE,
            "IDEMPOTENCY_PAYLOAD_MISMATCH"
        );
    }

    #[test]
    fn fingerprints_mismatch_when_both_nonempty_and_differ() {
        let stored = serde_json::json!({ GAME_INTENT_IDEM_FP_KEY: "aaa" });
        assert!(fingerprints_mismatch(&stored, Some("bbb")));
        assert!(!fingerprints_mismatch(&stored, Some("aaa")));
        assert!(!fingerprints_mismatch(&stored, Some("")));
        assert!(!fingerprints_mismatch(&stored, None));
        let empty_fp = serde_json::json!({ GAME_INTENT_IDEM_FP_KEY: "" });
        assert!(!fingerprints_mismatch(&empty_fp, Some("bbb")));
        let no_fp = serde_json::json!({ "ok": true });
        assert!(!fingerprints_mismatch(&no_fp, Some("bbb")));
    }

    #[test]
    fn validate_rejects_empty_and_over_max() {
        assert!(validate_intent_idem_keys("scope", "key").is_ok());
        assert!(validate_intent_idem_keys("", "key").is_err());
        assert!(validate_intent_idem_keys("s", "").is_err());
        let over_scope = "x".repeat(INTENT_IDEM_SCOPE_MAX_LEN.saturating_add(1));
        let over_key = "k".repeat(IDEMPOTENCY_KEY_MAX_LEN.saturating_add(1));
        assert!(validate_intent_idem_keys(&over_scope, "key").is_err());
        assert!(validate_intent_idem_keys("scope", &over_key).is_err());
        let max_scope = "x".repeat(INTENT_IDEM_SCOPE_MAX_LEN);
        let max_key = "k".repeat(IDEMPOTENCY_KEY_MAX_LEN);
        assert!(validate_intent_idem_keys(&max_scope, &max_key).is_ok());
    }
}
