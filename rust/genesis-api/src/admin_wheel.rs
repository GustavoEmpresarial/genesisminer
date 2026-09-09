//! Admin Roleta / Wheel editor (`/api/admin/wheel/*`).
//!
//! Replaces `server/modules/wheel/` (Express). `require_admin` gates on tab
//! `games` (route table in [`crate::admin_auth`]); the SQL runs in
//! `genesis-hardware` (`wheel/admin.rs`). Player `/api/wheel/*` + `/api/roleta/*`
//! stay in [`crate::player`].

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_hardware;

const P_CONFIG: &str = "/api/admin/wheel/config";
const P_RUNTIME: &str = "/api/admin/wheel/runtime-config";
const P_PLAYERS: &str = "/api/admin/wheel/players";
const P_PLAYERS_ONE: &str = "/api/admin/wheel/players/{username}";

const W_PRIZES: &str = "/v1/wheel/admin/prizes";
const W_PRIZES_REPLACE: &str = "/v1/wheel/admin/prizes/replace";
const W_RUNTIME: &str = "/v1/wheel/admin/runtime-config";
const W_RUNTIME_SET: &str = "/v1/wheel/admin/runtime-config/set";
const W_PLAYERS: &str = "/v1/wheel/admin/players";
const W_PLAYERS_ADD: &str = "/v1/wheel/admin/players/add";
const W_PLAYERS_REMOVE: &str = "/v1/wheel/admin/players/remove";

async fn prizes_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_CONFIG).await {
        return e;
    }
    forward_hardware(&state, W_PRIZES, json!({})).await
}

async fn prizes_replace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_CONFIG).await {
        return e;
    }
    // Client posts a bare JSON array of prizes.
    forward_hardware(&state, W_PRIZES_REPLACE, json!({ "prizes": body })).await
}

async fn runtime_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_RUNTIME).await {
        return e;
    }
    forward_hardware(&state, W_RUNTIME, json!({})).await
}

async fn runtime_set(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_RUNTIME).await {
        return e;
    }
    forward_hardware(&state, W_RUNTIME_SET, body).await
}

async fn players_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_PLAYERS).await {
        return e;
    }
    forward_hardware(&state, W_PLAYERS, json!({})).await
}

async fn players_add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_PLAYERS).await {
        return e;
    }
    forward_hardware(&state, W_PLAYERS_ADD, body).await
}

async fn players_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, P_PLAYERS).await {
        return e;
    }
    forward_hardware(&state, W_PLAYERS_REMOVE, json!({ "username": username })).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_CONFIG, get(prizes_get).post(prizes_replace))
        .route(P_RUNTIME, get(runtime_get).post(runtime_set))
        .route(P_PLAYERS, get(players_get).post(players_add))
        .route(P_PLAYERS_ONE, axum::routing::delete(players_remove))
}
