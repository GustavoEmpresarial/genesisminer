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
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_hardware;
use crate::session::json_status;

const ECONOMY_SETTINGS_PATH: &str = "/api/admin/economy-settings";
const SYNC_LIVE_PRICES_PATH: &str = "/api/admin/mining-coins/sync-live-prices";
const W_ECONOMY_SETTINGS: &str = "/v1/catalog/mining-coins/economy-settings";

const SYNC_NOT_IMPLEMENTED_MSG: &str = "Sincronização de preços ao vivo (CoinGecko) não está \
     disponível nesta build — enriquecimento cosmético não portado.";

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

async fn sync_live_prices(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, SYNC_LIVE_PRICES_PATH).await {
        return e;
    }
    json_status(
        501,
        json!({ "ok": false, "updated": 0, "error": SYNC_NOT_IMPLEMENTED_MSG }),
    )
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ECONOMY_SETTINGS_PATH, post(economy_settings))
        .route(SYNC_LIVE_PRICES_PATH, post(sync_live_prices))
}
