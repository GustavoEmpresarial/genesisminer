//! Admin P2P market (`GET /api/admin/market/listings`).
//!
//! Replaces `server/modules/admin/market-listings` (Express). `require_admin`
//! gates on tab `shops` (route table in [`crate::admin_auth`]); the read runs in
//! `genesis-hardware` (`/v1/market/admin/listings`). Player `/api/black-market/*`
//! stays in [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_hardware;

const ADMIN_MARKET_LISTINGS_PATH: &str = "/api/admin/market/listings";
const W_ADMIN_MARKET_LISTINGS: &str = "/v1/market/admin/listings";

async fn listings(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_MARKET_LISTINGS_PATH).await {
        return e;
    }
    forward_hardware(&state, W_ADMIN_MARKET_LISTINGS, json!({})).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(ADMIN_MARKET_LISTINGS_PATH, get(listings))
}
