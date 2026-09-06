//! Admin wallet tabs outside the `/api/admin` prefix.
//!
//! `require_admin` + forward, mirroring the Express controllers these replace:
//! - `POST /api/web3-settings` → `server/modules/wallet/controllers/wallet.controller.ts`
//!   (including its `walletLimiter`)
//! - `GET|POST /api/wallet-labels` →
//!   `server/modules/admin/wallet-labels/controllers/wallet-labels.controller.ts`
//!
//! `GET /api/web3-settings` is the player read and stays in [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use genesis_core::time::MS_PER_MINUTE;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::client_ip::get_client_ip;
use crate::config::AppState;
use crate::facade::{forward_wallet, forward_wallet_items};
use crate::rate_limit::{enforce, scoped_actor_key};
use crate::session::json_status;

/// Public paths owned here (also the keys of the admin permission table).
const WEB3_SETTINGS_PATH: &str = "/api/web3-settings";
const WALLET_LABELS_PATH: &str = "/api/wallet-labels";

/// Worker twins (genesis-wallet).
const WEB3_SETTINGS_PERSIST_PATH: &str = "/v1/web3-settings/persist";
const WALLET_LABELS_LIST_PATH: &str = "/v1/wallet-labels/list";
const WALLET_LABELS_UPSERT_PATH: &str = "/v1/wallet-labels/upsert";

/// Node `RATE_LIMIT_MAX` on `walletLimiter` in wallet.controller.ts.
const WALLET_RATE_LIMIT_MAX: u64 = 120;
/// Node `windowMs: MS_PER_MINUTE`.
const WALLET_RATE_LIMIT_WINDOW_MS: u64 = MS_PER_MINUTE;
/// Node `keyGenerator: (req) => \`wallet:${uid ?? ip}\``.
const SCOPE_WALLET: &str = "wallet";
/// Node `message: { error: ..., code: 'RATE_LIMIT' }`.
const WALLET_RATE_MSG: &str = "Too many wallet requests. Wait a minute.";

/// Node `HTTP_BAD_REQUEST` in wallet-labels.ts.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HttpControlledError(HTTP_BAD_REQUEST, { error: 'Missing fields' })`.
const ERR_MISSING_FIELDS: &str = "Missing fields";

const _: () = assert!(WALLET_RATE_LIMIT_MAX == 120);
const _: () = assert!(WALLET_RATE_LIMIT_WINDOW_MS == MS_PER_MINUTE);

/// The Node service reads `req.body` raw, so the twin carries it untouched.
fn persist_body(body: Value) -> Value {
    json!({ "payload": body })
}

/// Node `planUpsertWalletLabel`: `if (!address || !label) 400` — JS truthiness,
/// so an empty string or a `0` is rejected too.
fn require_label_fields(body: &Value) -> Result<(), Response> {
    let obj = body.as_object();
    let present = |key: &str| {
        obj.and_then(|m| m.get(key)).is_some_and(|v| match v {
            Value::Null | Value::Bool(false) => false,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
            _ => true,
        })
    };
    if present("address") && present("label") {
        return Ok(());
    }
    Err(json_status(
        HTTP_BAD_REQUEST,
        json!({ "error": ERR_MISSING_FIELDS }),
    ))
}

async fn post_web3_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, WEB3_SETTINGS_PATH).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_WALLET, Some(ctx.user_id), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        WALLET_RATE_LIMIT_MAX,
        WALLET_RATE_LIMIT_WINDOW_MS,
        WALLET_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_wallet(&state, WEB3_SETTINGS_PERSIST_PATH, persist_body(body)).await
}

async fn get_wallet_labels(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, WALLET_LABELS_PATH).await {
        return e;
    }
    forward_wallet_items(&state, WALLET_LABELS_LIST_PATH, json!({})).await
}

async fn post_wallet_labels(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, WALLET_LABELS_PATH).await {
        return e;
    }
    if let Err(e) = require_label_fields(&body) {
        return e;
    }
    forward_wallet(&state, WALLET_LABELS_UPSERT_PATH, persist_body(body)).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(WEB3_SETTINGS_PATH, post(post_web3_settings))
        .route(
            WALLET_LABELS_PATH,
            get(get_wallet_labels).post(post_wallet_labels),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_match_twins() {
        assert_eq!(WEB3_SETTINGS_PERSIST_PATH, "/v1/web3-settings/persist");
        assert_eq!(WALLET_LABELS_LIST_PATH, "/v1/wallet-labels/list");
        assert_eq!(WALLET_LABELS_UPSERT_PATH, "/v1/wallet-labels/upsert");
    }

    #[test]
    fn wallet_rate_limit_matches_node() {
        assert_eq!(WALLET_RATE_LIMIT_MAX, 120);
        assert_eq!(WALLET_RATE_LIMIT_WINDOW_MS, MS_PER_MINUTE);
        assert_eq!(
            scoped_actor_key(SCOPE_WALLET, Some(7), "1.2.3.4"),
            "wallet:7"
        );
        assert_eq!(
            scoped_actor_key(SCOPE_WALLET, None, "1.2.3.4"),
            "wallet:1.2.3.4"
        );
    }

    #[test]
    fn wallet_label_fields_use_js_truthiness() {
        assert!(require_label_fields(&json!({ "address": "0xA", "label": "hot" })).is_ok());
        // `"0"` is truthy in JS.
        assert!(require_label_fields(&json!({ "address": "0", "label": "0" })).is_ok());

        for bad in [
            json!({ "label": "hot" }),
            json!({ "address": "0xA" }),
            json!({ "address": "", "label": "hot" }),
            json!({ "address": "0xA", "label": "" }),
            json!({ "address": 0, "label": "hot" }),
            json!({ "address": null, "label": "hot" }),
            json!(null),
            json!([]),
        ] {
            let err = require_label_fields(&bad).unwrap_err();
            assert_eq!(err.status().as_u16(), HTTP_BAD_REQUEST, "{bad}");
        }
    }

    #[test]
    fn persist_body_keeps_raw_payload() {
        assert_eq!(persist_body(json!([1]))["payload"], json!([1]));
        assert_eq!(
            persist_body(json!({ "depositWallet": "0xA" }))["payload"]["depositWallet"],
            "0xA"
        );
    }
}
