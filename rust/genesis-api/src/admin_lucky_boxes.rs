//! Admin lucky-box / loot-box management (`/api/admin/loot-boxes*`,
//! `/api/admin/user-boxes`, `/api/admin/delete-user-box`,
//! `/api/admin/loot-box-redemptions/{boxId}`).
//!
//! Replaces `server/modules/admin/loot-boxes` (Express). `require_admin` gates on
//! tab `lootboxes` (route table in [`crate::admin_auth`]); catalog + inventory
//! writes run in `genesis-hardware`. Player `/api/lucky-boxes/*` stays in
//! [`crate::player`]; the catalog upsert on `/api/loot-boxes` stays in
//! [`crate::admin_catalog`].

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_hardware;
use crate::session::json_status;

const ADMIN_LOOT_BOXES_PATH: &str = "/api/admin/loot-boxes";
const ADMIN_LOOT_BOX_ITEM_PATH: &str = "/api/admin/loot-boxes/{box_id}";
const ADMIN_LOOT_BOX_REDEMPTIONS_PATH: &str = "/api/admin/loot-box-redemptions/{box_id}";
const ADMIN_USER_BOXES_PATH: &str = "/api/admin/user-boxes";
const ADMIN_DELETE_USER_BOX_PATH: &str = "/api/admin/delete-user-box";

// genesis-hardware twins.
const W_UPSERT: &str = "/v1/catalog/loot-boxes/upsert";
const W_DELETE: &str = "/v1/catalog/loot-boxes/delete";
const W_REDEMPTIONS: &str = "/v1/lucky-boxes/admin/redemptions";
const W_USER_BOXES: &str = "/v1/lucky-boxes/admin/user-boxes";
const W_DELETE_USER_BOX: &str = "/v1/lucky-boxes/admin/delete-user-box";

#[derive(Debug, Default, Deserialize)]
struct BrokenOnlyQ {
    #[serde(default)]
    broken_only: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct EmailQ {
    #[serde(default)]
    email: Option<String>,
}

fn truthy(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Node accepts a bare array (legacy) or `{ boxes: [...], replaceCatalog?: bool }`.
fn shape_upsert(body: &Value) -> Result<Value, Response> {
    match body {
        Value::Array(a) => Ok(json!({ "boxes": a, "replaceCatalog": false })),
        Value::Object(m) => match m.get("boxes") {
            Some(Value::Array(a)) => Ok(json!({
                "boxes": a,
                "replaceCatalog": m.get("replaceCatalog") == Some(&Value::Bool(true)),
            })),
            _ => Err(json_status(
                400,
                json!({ "error": "Body inválido: use { boxes: [], replaceCatalog?: boolean } ou um array (legado)." }),
            )),
        },
        _ => Err(json_status(
            400,
            json!({ "error": "Body inválido: use { boxes: [], replaceCatalog?: boolean } ou um array (legado)." }),
        )),
    }
}

async fn upsert(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ADMIN_LOOT_BOXES_PATH).await {
        return e;
    }
    match shape_upsert(&body) {
        Ok(v) => forward_hardware(&state, W_UPSERT, v).await,
        Err(e) => e,
    }
}

async fn delete_box(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(box_id): Path<String>,
    Query(q): Query<BrokenOnlyQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, ADMIN_LOOT_BOXES_PATH).await {
        return e;
    }
    if box_id.trim().is_empty() {
        return json_status(400, json!({ "error": "ID da caixa inválido." }));
    }
    forward_hardware(
        &state,
        W_DELETE,
        json!({ "boxId": box_id, "brokenOnly": truthy(q.broken_only.as_deref()) }),
    )
    .await
}

async fn redemptions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(box_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(
        &state,
        &headers,
        &Method::GET,
        "/api/admin/loot-box-redemptions/x",
    )
    .await
    {
        return e;
    }
    if box_id.trim().is_empty() {
        return json_status(400, json!({ "error": "ID da caixa inválido." }));
    }
    forward_hardware(&state, W_REDEMPTIONS, json!({ "boxId": box_id })).await
}

async fn user_boxes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<EmailQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_USER_BOXES_PATH).await {
        return e;
    }
    forward_hardware(
        &state,
        W_USER_BOXES,
        json!({ "email": q.email.unwrap_or_default() }),
    )
    .await
}

async fn delete_user_box(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::POST, ADMIN_DELETE_USER_BOX_PATH).await
    {
        return e;
    }
    forward_hardware(
        &state,
        W_DELETE_USER_BOX,
        json!({
            "email": body.get("email").and_then(Value::as_str).unwrap_or(""),
            "boxId": body.get("boxId").and_then(Value::as_str).unwrap_or(""),
        }),
    )
    .await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ADMIN_LOOT_BOXES_PATH, post(upsert))
        .route(ADMIN_LOOT_BOX_ITEM_PATH, axum::routing::delete(delete_box))
        .route(ADMIN_LOOT_BOX_REDEMPTIONS_PATH, get(redemptions))
        .route(ADMIN_USER_BOXES_PATH, get(user_boxes))
        .route(ADMIN_DELETE_USER_BOX_PATH, post(delete_user_box))
}
