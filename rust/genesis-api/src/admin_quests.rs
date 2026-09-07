//! Admin quest definitions (`GET`/`POST /api/admin/quests`).
//!
//! Replaces `server/modules/quests/controllers/quests.controller.ts` (Express).
//! `require_admin` gates on tab `settings:monetization` (route table in
//! [`crate::admin_auth`]); the SQL runs in `genesis-mining-worker`
//! (`quests_admin.rs`). Player `/api/quests/*` stays in [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;

const ADMIN_QUESTS_PATH: &str = "/api/admin/quests";
const W_LIST: &str = "/v1/quests/admin/list";
const W_SAVE: &str = "/v1/quests/admin/save";

async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_QUESTS_PATH).await {
        return e;
    }
    forward_mining(&state, W_LIST, json!({})).await
}

async fn save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ADMIN_QUESTS_PATH).await {
        return e;
    }
    forward_mining(&state, W_SAVE, body).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(ADMIN_QUESTS_PATH, get(list).post(save))
}
