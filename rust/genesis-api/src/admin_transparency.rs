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
use axum::routing::{post, put};
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

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/admin/transparency", post(create))
        .route("/api/admin/transparency/{id}", put(update).delete(remove))
}
