//! Admin wallet ops — withdrawals list/status + coin-balance set/bulk.
//!
//! Replaces `server/modules/admin/withdrawals` and `server/modules/admin/coin-balance`
//! (Express). `require_admin` gates on tab `users` (route table in
//! [`crate::admin_auth`]); every money TX runs in `genesis-wallet`
//! (`/v1/wallet/admin/*`, fail-closed). Player wallet routes stay in [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_wallet;

const ADMIN_WITHDRAWALS_PATH: &str = "/api/admin/withdrawals";
const ADMIN_WITHDRAWALS_STATUS_PATH: &str = "/api/admin/withdrawals/status";
const ADMIN_UPDATE_COIN_BALANCE_PATH: &str = "/api/admin/update-coin-balance";
const ADMIN_BULK_UPDATE_COIN_BALANCE_PATH: &str = "/api/admin/bulk-update-coin-balance";

// genesis-wallet twins.
const W_WITHDRAWALS_LIST: &str = "/v1/wallet/admin/withdrawals/list";
const W_WITHDRAWALS_STATUS: &str = "/v1/wallet/admin/withdrawals/status";
const W_COIN_BALANCE_SET: &str = "/v1/wallet/admin/coin-balance/set";
const W_COIN_BALANCE_BULK: &str = "/v1/wallet/admin/coin-balance/bulk";

async fn withdrawals_list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_WITHDRAWALS_PATH).await {
        return e;
    }
    forward_wallet(&state, W_WITHDRAWALS_LIST, json!({})).await
}

async fn withdrawals_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::POST, ADMIN_WITHDRAWALS_STATUS_PATH).await
    {
        return e;
    }
    forward_wallet(&state, W_WITHDRAWALS_STATUS, body).await
}

async fn update_coin_balance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::POST, ADMIN_UPDATE_COIN_BALANCE_PATH).await
    {
        return e;
    }
    forward_wallet(&state, W_COIN_BALANCE_SET, body).await
}

async fn bulk_update_coin_balance(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(
        &state,
        &headers,
        &Method::POST,
        ADMIN_BULK_UPDATE_COIN_BALANCE_PATH,
    )
    .await
    {
        return e;
    }
    forward_wallet(&state, W_COIN_BALANCE_BULK, body).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ADMIN_WITHDRAWALS_PATH, get(withdrawals_list))
        .route(ADMIN_WITHDRAWALS_STATUS_PATH, post(withdrawals_status))
        .route(ADMIN_UPDATE_COIN_BALANCE_PATH, post(update_coin_balance))
        .route(
            ADMIN_BULK_UPDATE_COIN_BALANCE_PATH,
            post(bulk_update_coin_balance),
        )
}
