//! Admin coin economy (`POST /api/admin/economy-settings`,
//! `POST /api/admin/mining-coins/sync-live-prices`).
//!
//! Replaces `server/modules/admin/economy-stats/controllers/coin-economy.controller.ts`
//! (Express). `require_admin` gates `Super` (route table in [`crate::admin_auth`]).
//! The per-coin hashrate/reward update runs in `genesis-hardware`
//! (`admin_catalog/mining_coins.rs`); live-price sync (CoinGecko) is not built
//! yet and returns the same explicit 501 the Node stub did — a real
//! implementation is planned separately. The mining-coin CRUD lives in
//! [`crate::admin_catalog`] and the read in [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::{forward_hardware, forward_mining};
use crate::session::json_status;
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

const ECONOMY_SETTINGS_PATH: &str = "/api/admin/economy-settings";
const SYNC_LIVE_PRICES_PATH: &str = "/api/admin/mining-coins/sync-live-prices";
const SET_ACTIVE_PATH: &str = "/api/mining-coins/set-active";
const ECONOMY_STATS_PATH: &str = "/api/admin/economy-stats";
const RUNTIME_SUMMARY_PATH: &str = "/api/admin/mining-runtime-summary";
const DISTRIBUTION_PREVIEW_PATH: &str = "/api/admin/economy/distribution-preview";
const W_ECONOMY_SETTINGS: &str = "/v1/catalog/mining-coins/economy-settings";
const W_SET_ACTIVE: &str = "/v1/catalog/mining-coins/set-active";
const W_ECONOMY_STATS: &str = "/v1/admin/economy/coin-stats";
const W_RUNTIME_SUMMARY: &str = "/v1/admin/economy/runtime-summary";
const W_SYNC_LIVE_PRICES: &str = "/v1/admin/economy/sync-live-prices";
const W_DISTRIBUTION_PREVIEW: &str = "/v1/admin/economy/distribution-preview";

async fn economy_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ECONOMY_SETTINGS_PATH).await {
        return e;
    }
    forward_hardware(&state, W_ECONOMY_SETTINGS, json!({ "payload": body })).await
}

/// Single-coin activate / deactivate — replaces the old client-side
/// "load whole list, flip `is_active`, re-POST the list" pattern.
async fn set_active(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, SET_ACTIVE_PATH).await {
        return e;
    }
    forward_hardware(&state, W_SET_ACTIVE, json!({ "payload": body })).await
}

/// On-demand CoinGecko pull for the "Atualizar preços" button. The scheduled
/// 10-min sync runs in `genesis-mining-worker` (`price_sync_loop.rs`).
async fn sync_live_prices(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, SYNC_LIVE_PRICES_PATH).await {
        return e;
    }
    forward_mining(&state, W_SYNC_LIVE_PRICES, json!({})).await
}

/// Per-coin real active miners + hashrate from `placed_racks`. Node returns a
/// bare array; the worker wraps it as `{ ok, rows }`.
async fn economy_stats(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ECONOMY_STATS_PATH).await {
        return e;
    }
    match post_mining(&state.cfg, &state.http, W_ECONOMY_STATS, &json!({})).await {
        Ok(w) => {
            let rows = w.body.get("rows").cloned().unwrap_or_else(|| json!([]));
            json_status(if w.status == 0 { 502 } else { w.status }, rows)
        }
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

/// Last yield-tick snapshot from `app_cache.network_stats`.
async fn runtime_summary(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, RUNTIME_SUMMARY_PATH).await {
        return e;
    }
    forward_mining(&state, W_RUNTIME_SUMMARY, json!({})).await
}

/// Projects a `usd_month` distribution for one coin using the last tick's real
/// active hashrate (same value the boundary formula divides by).
async fn distribution_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, DISTRIBUTION_PREVIEW_PATH).await {
        return e;
    }
    let coin_id = body
        .get("coinId")
        .or_else(|| body.get("coin_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if coin_id.is_empty() {
        return json_status(400, json!({ "ok": false, "error": "coinId obrigatório." }));
    }
    let usd_month = body
        .get("distributionUsdMonth")
        .or_else(|| body.get("distribution_usd_month"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    forward_mining(
        &state,
        W_DISTRIBUTION_PREVIEW,
        json!({ "coinId": coin_id, "distributionUsdMonth": usd_month }),
    )
    .await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ECONOMY_SETTINGS_PATH, post(economy_settings))
        .route(SET_ACTIVE_PATH, post(set_active))
        .route(SYNC_LIVE_PRICES_PATH, post(sync_live_prices))
        .route(ECONOMY_STATS_PATH, get(economy_stats))
        .route(RUNTIME_SUMMARY_PATH, get(runtime_summary))
        .route(DISTRIBUTION_PREVIEW_PATH, post(distribution_preview))
}
