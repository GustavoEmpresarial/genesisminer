//! `GET /api/dashboard/state` → mining-worker `POST /v1/dashboard/state`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::config::AppState;
use crate::facade::forward_mining;
use crate::session::require_player;

const DASHBOARD_STATE_PATH: &str = "/v1/dashboard/state";

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/dashboard/state", get(dashboard_state))
}

async fn dashboard_state(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    forward_mining(&state, DASHBOARD_STATE_PATH, json!({ "userId": uid })).await
}
