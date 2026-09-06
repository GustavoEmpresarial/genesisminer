//! Admin Web3 settings write + wallet labels — Node
//! `server/modules/wallet/services/web3-settings-write.ts` and
//! `server/modules/admin/wallet-labels/services/wallet-labels.ts`.
//!
//! The keys written here are exactly the ones
//! [`crate::player_reads::run_web3_settings`] reads back, so the admin form and
//! the player GET stay in sync. Admin authorization lives in genesis-api.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::current_unix_ms;
use crate::errors::WalletError;
use crate::http::AppState;

pub const WEB3_SETTINGS_PERSIST_PATH: &str = "/v1/web3-settings/persist";
pub const WALLET_LABELS_LIST_PATH: &str = "/v1/wallet-labels/list";
pub const WALLET_LABELS_UPSERT_PATH: &str = "/v1/wallet-labels/upsert";

/// Node `EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/`.
const EVM_ADDRESS_HEX_DIGITS: usize = 40;
const EVM_ADDRESS_PREFIX: &str = "0x";
/// Node `WITHDRAW_TOKENS_MAX`.
const WITHDRAW_TOKENS_MAX: usize = 80;
/// Node `WITHDRAW_TOKENS_JSON_MAX_CHARS` — measured in JS string length, i.e.
/// UTF-16 code units.
const WITHDRAW_TOKENS_JSON_MAX_CHARS: usize = 100_000;
/// Node `WITHDRAW_NETWORKS`.
const WITHDRAW_NETWORKS: &[&str] = &["polygon", "bnb", "base"];

const CODE_INVALID_WEB3_ADDRESS: &str = "INVALID_WEB3_ADDRESS";
const CODE_INVALID_MIN_DEPOSIT: &str = "INVALID_MIN_DEPOSIT";
const CODE_WITHDRAW_TOKENS_LIMIT: &str = "WITHDRAW_TOKENS_LIMIT";
const CODE_INVALID_WITHDRAW_TOKEN: &str = "INVALID_WITHDRAW_TOKEN";
const CODE_INVALID_WITHDRAW_NETWORK: &str = "INVALID_WITHDRAW_NETWORK";
const CODE_WITHDRAW_TOKENS_TOO_LARGE: &str = "WITHDRAW_TOKENS_TOO_LARGE";

const ERR_INVALID_MIN_DEPOSIT: &str = "Invalid minDepositUsdc.";
const ERR_WITHDRAW_TOKENS_LIMIT: &str = "Too many withdrawTokens.";
const ERR_INVALID_WITHDRAW_TOKEN: &str = "Invalid withdrawTokens entry.";
const ERR_INVALID_WITHDRAW_NETWORK: &str = "Invalid withdrawTokens.network.";
const ERR_WITHDRAW_TOKENS_TOO_LARGE: &str = "withdrawTokens payload too large.";

const KV_UPSERT_SQL: &str = "INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

const WALLET_LABELS_LIST_SQL: &str = "SELECT address, label, updated_at FROM wallet_labels";

const WALLET_LABEL_UPSERT_SQL: &str = "INSERT INTO wallet_labels (address, label, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET
       label = EXCLUDED.label,
       updated_at = EXCLUDED.updated_at";

/// Node `flagTo01`.
fn flag_to_01(v: Option<&Value>) -> &'static str {
    match v {
        Some(Value::Bool(true)) => "1",
        Some(Value::Bool(false)) => "0",
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f != 0.0 => "1",
            _ => "0",
        },
        Some(Value::String(s)) => match s.as_str() {
            "1" => "1",
            "0" | "" => "0",
            other if other.eq_ignore_ascii_case("true") => "1",
            other if other.eq_ignore_ascii_case("false") => "0",
            _ => "1",
        },
        None | Some(Value::Null) => "0",
        Some(_) => "1",
    }
}

/// Node `asStringField` — anything that is not a string reads as `''`.
fn as_string_field(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Node `EVM_ADDRESS_RE.test(s)`.
pub fn is_evm_address(s: &str) -> bool {
    let Some(hex) = s.strip_prefix(EVM_ADDRESS_PREFIX) else {
        return false;
    };
    hex.len() == EVM_ADDRESS_HEX_DIGITS && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Node `asOptionalAddress` — empty stays empty, anything else must be an
/// address. `asOptionalContract` is the same check under a different label.
fn as_optional_address(field: &str, v: Option<&Value>) -> Result<String, WalletError> {
    let s = as_string_field(v).trim().to_string();
    if s.is_empty() {
        return Ok(String::new());
    }
    if !is_evm_address(&s) {
        return Err(WalletError::bad_code(
            format!("Invalid {field}."),
            CODE_INVALID_WEB3_ADDRESS,
        ));
    }
    Ok(s)
}

/// Node `minDepositUsdcValue` — only a JSON number is stored.
fn min_deposit_usdc_value(v: Option<&Value>) -> Result<String, WalletError> {
    let Some(Value::Number(n)) = v else {
        return Ok(String::new());
    };
    let Some(f) = n.as_f64().filter(|f| f.is_finite() && *f >= 0.0) else {
        return Err(WalletError::bad_code(
            ERR_INVALID_MIN_DEPOSIT,
            CODE_INVALID_MIN_DEPOSIT,
        ));
    };
    Ok(number_to_js_string(f))
}

/// JS `String(number)`.
fn number_to_js_string(n: f64) -> String {
    format!("{n}")
}

/// Node `serializeWithdrawTokens` — validates every entry, then stores the JSON.
fn serialize_withdraw_tokens(raw: Option<&Value>) -> Result<String, WalletError> {
    let Some(Value::Array(items)) = raw else {
        return Ok("[]".to_string());
    };
    if items.len() > WITHDRAW_TOKENS_MAX {
        return Err(WalletError::bad_code(
            ERR_WITHDRAW_TOKENS_LIMIT,
            CODE_WITHDRAW_TOKENS_LIMIT,
        ));
    }
    for item in items {
        let Value::Object(token) = item else {
            return Err(WalletError::bad_code(
                ERR_INVALID_WITHDRAW_TOKEN,
                CODE_INVALID_WITHDRAW_TOKEN,
            ));
        };
        if token.contains_key("payoutWallet") {
            as_optional_address("withdrawTokens.payoutWallet", token.get("payoutWallet"))?;
        }
        if token.contains_key("contract") {
            as_optional_address("withdrawTokens.contract", token.get("contract"))?;
        }
        if let Some(Value::String(network)) = token.get("network") {
            if !network.trim().is_empty() && !WITHDRAW_NETWORKS.contains(&network.as_str()) {
                return Err(WalletError::bad_code(
                    ERR_INVALID_WITHDRAW_NETWORK,
                    CODE_INVALID_WITHDRAW_NETWORK,
                ));
            }
        }
    }
    let json = Value::Array(items.clone()).to_string();
    if json.encode_utf16().count() > WITHDRAW_TOKENS_JSON_MAX_CHARS {
        return Err(WalletError::bad_code(
            ERR_WITHDRAW_TOKENS_TOO_LARGE,
            CODE_WITHDRAW_TOKENS_TOO_LARGE,
        ));
    }
    Ok(json)
}

/// Node `buildWeb3SettingsUpserts`. The three network flags are only written
/// when the key is present, so omitting one never clears an existing block.
pub fn build_web3_settings_upserts(
    body: &Value,
) -> Result<Vec<(&'static str, String)>, WalletError> {
    let empty = serde_json::Map::new();
    let b = match body {
        Value::Object(m) => m,
        _ => &empty,
    };
    let mut upserts = vec![
        (
            "web3_deposit_wallet",
            as_optional_address("depositWallet", b.get("depositWallet"))?,
        ),
        (
            "web3_payout_wallet",
            as_optional_address("payoutWallet", b.get("payoutWallet"))?,
        ),
        (
            "web3_deposit_token_contract",
            as_optional_address("depositTokenContract", b.get("depositTokenContract"))?,
        ),
        (
            "web3_deposit_token_contract_bnb",
            as_optional_address("depositTokenContractBnb", b.get("depositTokenContractBnb"))?,
        ),
        (
            "web3_deposit_token_contract_base",
            as_optional_address(
                "depositTokenContractBase",
                b.get("depositTokenContractBase"),
            )?,
        ),
        (
            "web3_min_deposit_usdc",
            min_deposit_usdc_value(b.get("minDepositUsdc"))?,
        ),
        (
            "web3_withdraw_token_name",
            as_string_field(b.get("withdrawTokenName")),
        ),
        (
            "web3_withdraw_token_contract",
            as_optional_address("withdrawTokenContract", b.get("withdrawTokenContract"))?,
        ),
        (
            "web3_withdraw_tokens",
            serialize_withdraw_tokens(b.get("withdrawTokens"))?,
        ),
    ];
    for (key, flag) in [
        ("web3_deposit_polygon_disabled", "depositPolygonDisabled"),
        ("web3_deposit_bnb_disabled", "depositBnbDisabled"),
        ("web3_deposit_base_disabled", "depositBaseDisabled"),
    ] {
        if b.contains_key(flag) {
            upserts.push((key, flag_to_01(b.get(flag)).to_string()));
        }
    }
    Ok(upserts)
}

pub async fn run_persist_web3_settings(pool: &Pool, payload: &Value) -> Result<Value, WalletError> {
    let entries = build_web3_settings_upserts(payload)?;
    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;
    for (key, value) in &entries {
        tx.execute(KV_UPSERT_SQL, &[key, value])
            .await
            .map_err(WalletError::transport)?;
    }
    tx.commit().await.map_err(WalletError::transport)?;
    Ok(json!({}))
}

/// Node `mapWalletLabelRow` — the DTO keeps the `updated_at` snake_case key the
/// admin panel already reads.
fn map_wallet_label_row(row: &tokio_postgres::Row) -> Value {
    json!({
        "address": row.get::<_, String>("address"),
        "label": row.get::<_, String>("label"),
        "updated_at": row.get::<_, i64>("updated_at"),
    })
}

pub async fn run_list_wallet_labels(pool: &Pool) -> Result<Value, WalletError> {
    let client = pool.get().await.map_err(WalletError::transport)?;
    let rows = client
        .query(WALLET_LABELS_LIST_SQL, &[])
        .await
        .map_err(WalletError::transport)?;
    let items: Vec<Value> = rows.iter().map(map_wallet_label_row).collect();
    Ok(json!({ "items": items }))
}

/// Node `planUpsertWalletLabel` minus the presence check, which genesis-api
/// runs so the 400 body stays `{ error: 'Missing fields' }`.
#[derive(Debug, Clone, PartialEq)]
pub struct WalletLabelUpsertPlan {
    pub address: String,
    pub label: String,
}

pub fn plan_upsert_wallet_label(payload: &Value) -> WalletLabelUpsertPlan {
    let empty = serde_json::Map::new();
    let b = match payload {
        Value::Object(m) => m,
        _ => &empty,
    };
    WalletLabelUpsertPlan {
        address: js_string(b.get("address")),
        label: js_string(b.get("label")),
    }
}

/// Node stores `String(address)` / `String(label)` without trimming.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_js_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(_) => "[object Object]".into(),
    }
}

pub async fn run_upsert_wallet_label(pool: &Pool, payload: &Value) -> Result<Value, WalletError> {
    let plan = plan_upsert_wallet_label(payload);
    let client = pool.get().await.map_err(WalletError::transport)?;
    upsert_wallet_label(&client, &plan, current_unix_ms())
        .await
        .map_err(WalletError::transport)?;
    Ok(json!({}))
}

async fn upsert_wallet_label<C: GenericClient>(
    client: &C,
    plan: &WalletLabelUpsertPlan,
    now_ms: i64,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            WALLET_LABEL_UPSERT_SQL,
            &[&plan.address, &plan.label, &now_ms],
        )
        .await?;
    Ok(())
}

/// The admin panel posts an arbitrary JSON document; Node reads `req.body` raw,
/// so the twin carries it untouched.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWeb3Request {
    #[serde(default)]
    pub payload: Value,
}

type AdminWeb3Response = (StatusCode, Json<Value>);

fn admin_web3_ok(mut payload: Value) -> AdminWeb3Response {
    if let Value::Object(map) = &mut payload {
        map.insert("ok".into(), Value::Bool(true));
    }
    (StatusCode::OK, Json(payload))
}

fn admin_web3_fail(e: WalletError) -> AdminWeb3Response {
    match e {
        WalletError::Domain {
            status,
            error,
            code,
            ..
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            let mut body = json!({ "ok": false, "error": error });
            if let (Value::Object(map), Some(code)) = (&mut body, code) {
                map.insert("code".into(), Value::String(code));
            }
            (sc, Json(body))
        }
        WalletError::Transport(err) => {
            warn!(err = %err, "admin web3 transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
        }
    }
}

pub async fn post_web3_settings_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminWeb3Request>,
) -> AdminWeb3Response {
    match run_persist_web3_settings(&state.pool, &body.payload).await {
        Ok(v) => admin_web3_ok(v),
        Err(e) => admin_web3_fail(e),
    }
}

pub async fn post_wallet_labels_list(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<Value>,
) -> AdminWeb3Response {
    match run_list_wallet_labels(&state.pool).await {
        Ok(v) => admin_web3_ok(v),
        Err(e) => admin_web3_fail(e),
    }
}

pub async fn post_wallet_labels_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminWeb3Request>,
) -> AdminWeb3Response {
    match run_upsert_wallet_label(&state.pool, &body.payload).await {
        Ok(v) => admin_web3_ok(v),
        Err(e) => admin_web3_fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDRESS: &str = "0x1234567890abcdefABCDEF1234567890abcdef12";

    fn by_key(
        entries: Vec<(&'static str, String)>,
    ) -> std::collections::HashMap<&'static str, String> {
        entries.into_iter().collect()
    }

    #[test]
    fn worker_paths_match_genesis_api_client() {
        assert_eq!(WEB3_SETTINGS_PERSIST_PATH, "/v1/web3-settings/persist");
        assert_eq!(WALLET_LABELS_LIST_PATH, "/v1/wallet-labels/list");
        assert_eq!(WALLET_LABELS_UPSERT_PATH, "/v1/wallet-labels/upsert");
    }

    #[test]
    fn evm_address_matches_the_node_regex() {
        assert!(is_evm_address(ADDRESS));
        assert!(!is_evm_address("0x123"));
        assert!(!is_evm_address(&ADDRESS.replace("0x", "")));
        assert!(!is_evm_address(&format!("{ADDRESS}0")));
        assert!(!is_evm_address(
            "0xzzzz567890abcdefABCDEF1234567890abcdef12"
        ));
    }

    #[test]
    fn empty_body_writes_the_nine_base_keys() {
        let entries = build_web3_settings_upserts(&json!({})).unwrap();
        assert_eq!(entries.len(), 9);
        let kv = by_key(entries);
        assert_eq!(kv["web3_deposit_wallet"], "");
        assert_eq!(kv["web3_min_deposit_usdc"], "");
        assert_eq!(kv["web3_withdraw_token_name"], "");
        assert_eq!(kv["web3_withdraw_tokens"], "[]");
        assert!(!kv.contains_key("web3_deposit_polygon_disabled"));
    }

    #[test]
    fn non_object_body_reads_as_empty() {
        for bad in [json!([1]), json!("x"), json!(null), json!(7)] {
            assert_eq!(build_web3_settings_upserts(&bad).unwrap().len(), 9);
        }
    }

    #[test]
    fn addresses_are_validated_and_trimmed() {
        let kv = by_key(
            build_web3_settings_upserts(&json!({ "depositWallet": format!("  {ADDRESS} ") }))
                .unwrap(),
        );
        assert_eq!(kv["web3_deposit_wallet"], ADDRESS);

        let err = build_web3_settings_upserts(&json!({ "payoutWallet": "0xnope" })).unwrap_err();
        match err {
            WalletError::Domain {
                status,
                error,
                code,
                ..
            } => {
                assert_eq!(status, 400);
                assert_eq!(error, "Invalid payoutWallet.");
                assert_eq!(code.as_deref(), Some(CODE_INVALID_WEB3_ADDRESS));
            }
            other => panic!("expected domain error, got {other:?}"),
        }
    }

    #[test]
    fn min_deposit_only_accepts_non_negative_numbers() {
        let kv = by_key(build_web3_settings_upserts(&json!({ "minDepositUsdc": 2.5 })).unwrap());
        assert_eq!(kv["web3_min_deposit_usdc"], "2.5");
        // Non-numbers are stored as an empty string, not rejected.
        let kv = by_key(build_web3_settings_upserts(&json!({ "minDepositUsdc": "2.5" })).unwrap());
        assert_eq!(kv["web3_min_deposit_usdc"], "");
        assert!(build_web3_settings_upserts(&json!({ "minDepositUsdc": -1 })).is_err());
    }

    #[test]
    fn network_flags_are_only_written_when_present() {
        let kv = by_key(
            build_web3_settings_upserts(&json!({
                "depositPolygonDisabled": true,
                "depositBnbDisabled": "false",
                "depositBaseDisabled": 0
            }))
            .unwrap(),
        );
        assert_eq!(kv["web3_deposit_polygon_disabled"], "1");
        assert_eq!(kv["web3_deposit_bnb_disabled"], "0");
        assert_eq!(kv["web3_deposit_base_disabled"], "0");

        let kv =
            by_key(build_web3_settings_upserts(&json!({ "depositBnbDisabled": null })).unwrap());
        assert_eq!(kv["web3_deposit_bnb_disabled"], "0");
        assert!(!kv.contains_key("web3_deposit_polygon_disabled"));
    }

    #[test]
    fn withdraw_tokens_are_validated_entry_by_entry() {
        let kv = by_key(
            build_web3_settings_upserts(&json!({
                "withdrawTokens": [{ "network": "base", "contract": ADDRESS }]
            }))
            .unwrap(),
        );
        assert!(kv["web3_withdraw_tokens"].contains("base"));

        // A non-array is stored as `[]`, not rejected.
        let kv = by_key(build_web3_settings_upserts(&json!({ "withdrawTokens": "nope" })).unwrap());
        assert_eq!(kv["web3_withdraw_tokens"], "[]");

        for bad in [
            json!({ "withdrawTokens": [7] }),
            json!({ "withdrawTokens": [[]] }),
            json!({ "withdrawTokens": [{ "network": "solana" }] }),
            json!({ "withdrawTokens": [{ "payoutWallet": "0x1" }] }),
        ] {
            assert!(build_web3_settings_upserts(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn withdraw_tokens_respect_the_entry_limit() {
        let tokens: Vec<Value> = (0..=WITHDRAW_TOKENS_MAX).map(|_| json!({})).collect();
        let err = build_web3_settings_upserts(&json!({ "withdrawTokens": tokens })).unwrap_err();
        match err {
            WalletError::Domain { code, .. } => {
                assert_eq!(code.as_deref(), Some(CODE_WITHDRAW_TOKENS_LIMIT));
            }
            other => panic!("expected domain error, got {other:?}"),
        }
    }

    #[test]
    fn empty_network_string_is_allowed() {
        assert!(build_web3_settings_upserts(&json!({
            "withdrawTokens": [{ "network": "  " }]
        }))
        .is_ok());
    }

    #[test]
    fn wallet_label_plan_stringifies_without_trimming() {
        let plan = plan_upsert_wallet_label(&json!({ "address": "  0xA ", "label": "hot " }));
        assert_eq!(plan.address, "  0xA ");
        assert_eq!(plan.label, "hot ");

        let plan = plan_upsert_wallet_label(&json!({ "address": 7, "label": true }));
        assert_eq!(plan.address, "7");
        assert_eq!(plan.label, "true");
    }
}
