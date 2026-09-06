//! Shared player-facade helpers — inject `userId`, forward camelCase JSON.

use axum::response::Response;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::AppState;
use crate::session::json_status;
use crate::workers::{
    post_hardware, post_mining, post_wallet, worker_infra_status, worker_unavailable_body,
    WorkerCallError, WorkerJson,
};

const HTTP_NOT_IMPLEMENTED: u16 = 501;

pub fn not_implemented(detail: &str) -> Response {
    json_status(
        HTTP_NOT_IMPLEMENTED,
        json!({
            "error": detail,
            "code": "NOT_IMPLEMENTED"
        }),
    )
}

pub fn merge_user_id(body: Value, user_id: i64) -> Value {
    let mut obj = match body {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("userId".into(), json!(user_id));
    Value::Object(obj)
}

pub fn worker_to_response(r: WorkerJson) -> Response {
    let status = if r.status == 0 { 502 } else { r.status };
    json_status(status, r.body)
}

fn worker_err(err: WorkerCallError) -> Response {
    warn!(err = %err.message(), "worker facade");
    json_status(worker_infra_status(&err), worker_unavailable_body(&err))
}

pub async fn forward_mining(state: &AppState, path: &str, body: Value) -> Response {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

pub async fn forward_hardware(state: &AppState, path: &str, body: Value) -> Response {
    match post_hardware(&state.cfg, &state.http, path, &body).await {
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

pub async fn forward_wallet(state: &AppState, path: &str, body: Value) -> Response {
    match post_wallet(&state.cfg, &state.http, path, &body).await {
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

/// Catalog twins wrap arrays as `{ ok, items }` so flatten stays an object.
const HTTP_OK: u16 = 200;

pub async fn forward_hardware_items(state: &AppState, path: &str, body: Value) -> Response {
    match post_hardware(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, items)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

/// Black-market state: the worker nests the V1 payload under `state`, but the
/// client (`parseBlackMarketStateBody`) reads `version` / `listings` / `custody`
/// at the top level. Unwrap it.
pub async fn forward_hardware_bm_state(state: &AppState, path: &str, body: Value) -> Response {
    match post_hardware(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK => {
            let inner = r.body.get("state").cloned().unwrap_or(r.body);
            json_status(HTTP_OK, inner)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

/// Black-market listings page: the client requires `version: 1` and echoed
/// `limit` / `offset`; the worker returns only `{ ok, items, total }`.
pub async fn forward_hardware_bm_listings(
    state: &AppState,
    path: &str,
    body: Value,
    limit: i64,
    offset: i64,
) -> Response {
    match post_hardware(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK => {
            let mut out = r.body;
            if let Value::Object(ref mut m) = out {
                m.insert("version".into(), json!(1));
                m.insert("limit".into(), json!(limit));
                m.insert("offset".into(), json!(offset));
                m.entry("items").or_insert_with(|| json!([]));
                m.entry("total").or_insert_with(|| json!(0));
            }
            json_status(HTTP_OK, out)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}

pub async fn forward_wallet_items(state: &AppState, path: &str, body: Value) -> Response {
    match post_wallet(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, items)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err(e),
    }
}
