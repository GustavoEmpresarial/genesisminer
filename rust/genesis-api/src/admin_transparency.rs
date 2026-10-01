//! Admin transparency CRUD (`POST/PUT/DELETE /api/admin/transparency`).
//!
//! Replaces `server/modules/admin/transparency` (Express). `require_admin` gates
//! on tab `transparency` (route table in [`crate::admin_auth`]); the writes run
//! in `genesis-mining-worker` (`/v1/transparency/admin/*`). The public
//! `GET /api/transparency` list stays in [`crate::player`].

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;

/// Admin permission key (also the Node route path).
const TRANSPARENCY_ADMIN_PATH: &str = "/api/admin/transparency";

/// Worker twins.
const CREATE_PATH: &str = "/v1/transparency/admin/create";
const UPDATE_PATH: &str = "/v1/transparency/admin/update";
const DELETE_PATH: &str = "/v1/transparency/admin/delete";
const HEALTH_GET_PATH: &str = "/v1/transparency/admin/health-settings/get";
const HEALTH_UPDATE_PATH: &str = "/v1/transparency/admin/health-settings/update";

fn with_id(body: Value, id: &str) -> Value {
    let mut obj = match body {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("id".into(), json!(id));
    Value::Object(obj)
}

async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, TRANSPARENCY_ADMIN_PATH).await {
        return e;
    }
    forward_mining(&state, CREATE_PATH, body).await
}

async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::PUT, TRANSPARENCY_ADMIN_PATH).await {
        return e;
    }
    forward_mining(&state, UPDATE_PATH, with_id(body, &id)).await
}

async fn remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, TRANSPARENCY_ADMIN_PATH).await {
        return e;
    }
    forward_mining(&state, DELETE_PATH, json!({ "id": id })).await
}

/// Health-index knobs (weights / floor / period scope / manual score).
///
/// Same `transparency` tab as the CRUD. The actor is taken from the verified admin
/// context and **overwrites** anything the client sent, so `actorUserId` cannot be
/// spoofed into the audit trail.
async fn health_settings_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, TRANSPARENCY_ADMIN_PATH).await {
        return e;
    }
    forward_mining(&state, HEALTH_GET_PATH, json!({})).await
}

async fn health_settings_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::PUT, TRANSPARENCY_ADMIN_PATH).await {
        Ok(ctx) => ctx,
        Err(e) => return e,
    };
    let mut obj = match body {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("actorUserId".into(), json!(ctx.user_id));
    forward_mining(&state, HEALTH_UPDATE_PATH, Value::Object(obj)).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/admin/transparency", post(create))
        // Static segment before the `{id}` param so it is never read as an entry id.
        .route(
            "/api/admin/transparency/health-settings",
            get(health_settings_get).put(health_settings_put),
        )
        .route("/api/admin/transparency/{id}", put(update).delete(remove))
}
