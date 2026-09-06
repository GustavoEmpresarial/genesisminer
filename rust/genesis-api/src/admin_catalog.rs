//! Admin catalog / settings writes outside the `/api/admin` prefix.
//!
//! `require_admin` + forward, mirroring the Express controllers these replace:
//! - `POST /api/{access-levels,loot-boxes,news,news-fee,news-expire-days,mining-coins,season-passes}`
//!   and `DELETE /api/news/:id` → `server/modules/catalog/controllers/catalog.controller.ts`
//! - `POST /api/rig-rooms` → `server/modules/rooms/controllers/rooms.controller.ts`
//!
//! The body-shape checks below are the ones Node keeps in its controllers, so
//! the 400 payload stays byte-identical; the services' own validation (loot-box
//! prices) belongs to the hardware twin.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{delete, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_hardware;
use crate::session::json_status;

/// Public paths owned here (also the keys of the admin permission table).
const ACCESS_LEVELS_PATH: &str = "/api/access-levels";
const LOOT_BOXES_PATH: &str = "/api/loot-boxes";
const NEWS_PATH: &str = "/api/news";
const NEWS_ITEM_PATH: &str = "/api/news/{id}";
const NEWS_FEE_PATH: &str = "/api/news-fee";
const NEWS_EXPIRE_DAYS_PATH: &str = "/api/news-expire-days";
const MINING_COINS_PATH: &str = "/api/mining-coins";
const SEASON_PASSES_PATH: &str = "/api/season-passes";
const RIG_ROOMS_PATH: &str = "/api/rig-rooms";

/// Worker twins (genesis-hardware).
const ACCESS_LEVELS_REPLACE_PATH: &str = "/v1/catalog/access-levels/replace";
const LOOT_BOXES_UPSERT_PATH: &str = "/v1/catalog/loot-boxes/upsert";
const NEWS_UPSERT_PATH: &str = "/v1/catalog/news/upsert";
const NEWS_DELETE_PATH: &str = "/v1/catalog/news/delete";
const NEWS_FEE_PERSIST_PATH: &str = "/v1/settings/news-fee/persist";
const NEWS_EXPIRE_DAYS_PERSIST_PATH: &str = "/v1/settings/news-expire-days/persist";
const MINING_COINS_UPSERT_PATH: &str = "/v1/catalog/mining-coins/upsert";
const SEASON_PASSES_REPLACE_PATH: &str = "/v1/catalog/season-passes/replace";
const RIG_ROOMS_UPSERT_PATH: &str = "/v1/rooms/catalog/upsert";

/// Node `HTTP_BAD_REQUEST` in catalog.controller.ts.
const HTTP_BAD_REQUEST: u16 = 400;

/// Node controller messages.
const ERR_BODY_MUST_BE_ARRAY: &str = "Body must be an array";
const ERR_LOOT_BOXES_BODY_INVALID: &str =
    "Body inválido: use { boxes: [], replaceCatalog?: boolean } ou um array (legado).";
const ERR_NEWS_ID_AND_TEXT_REQUIRED: &str = "id e text obrigatórios.";

fn bad_request(error: &str) -> Response {
    json_status(HTTP_BAD_REQUEST, json!({ "error": error }))
}

/// Node `if (!Array.isArray(body)) 400` — used by access-levels and season-passes.
fn require_array(body: &Value) -> Result<&Vec<Value>, Response> {
    body.as_array()
        .ok_or_else(|| bad_request(ERR_BODY_MUST_BE_ARRAY))
}

/// Node accepts the legacy bare array or `{ boxes, replaceCatalog }`.
fn loot_boxes_body(body: &Value) -> Result<Value, Response> {
    if let Some(boxes) = body.as_array() {
        return Ok(json!({ "boxes": boxes, "replaceCatalog": false }));
    }
    let Some(obj) = body.as_object() else {
        return Err(bad_request(ERR_LOOT_BOXES_BODY_INVALID));
    };
    let Some(boxes) = obj.get("boxes").and_then(Value::as_array) else {
        return Err(bad_request(ERR_LOOT_BOXES_BODY_INVALID));
    };
    Ok(json!({
        "boxes": boxes,
        "replaceCatalog": obj.get("replaceCatalog") == Some(&Value::Bool(true)),
    }))
}

/// Node `if (typeof id !== 'string' || !id.trim() || typeof text !== 'string') 400`.
fn news_body(body: &Value) -> Result<Value, Response> {
    let obj = body.as_object();
    let id = obj.and_then(|m| m.get("id")).and_then(Value::as_str);
    let text_is_string = obj
        .and_then(|m| m.get("text"))
        .is_some_and(Value::is_string);
    match id {
        Some(id) if !id.trim().is_empty() && text_is_string => {}
        _ => return Err(bad_request(ERR_NEWS_ID_AND_TEXT_REQUIRED)),
    }
    Ok(json!({ "payload": body }))
}

/// The Node services read `req.body` raw (arrays and `null` included), so the
/// twin carries it under `payload` instead of spreading it.
fn persist_body(body: Value) -> Value {
    json!({ "payload": body })
}

async fn post_access_levels(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ACCESS_LEVELS_PATH).await {
        return e;
    }
    let levels = match require_array(&body) {
        Ok(v) => v,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        ACCESS_LEVELS_REPLACE_PATH,
        json!({ "levels": levels }),
    )
    .await
}

async fn post_loot_boxes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, LOOT_BOXES_PATH).await {
        return e;
    }
    let forwarded = match loot_boxes_body(&body) {
        Ok(v) => v,
        Err(e) => return e,
    };
    forward_hardware(&state, LOOT_BOXES_UPSERT_PATH, forwarded).await
}

async fn post_news(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, NEWS_PATH).await {
        return e;
    }
    let forwarded = match news_body(&body) {
        Ok(v) => v,
        Err(e) => return e,
    };
    forward_hardware(&state, NEWS_UPSERT_PATH, forwarded).await
}

async fn delete_news(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let path = format!("{NEWS_PATH}/{id}");
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, &path).await {
        return e;
    }
    forward_hardware(&state, NEWS_DELETE_PATH, json!({ "id": id })).await
}

async fn post_news_fee(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, NEWS_FEE_PATH).await {
        return e;
    }
    forward_hardware(&state, NEWS_FEE_PERSIST_PATH, persist_body(body)).await
}

async fn post_news_expire_days(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, NEWS_EXPIRE_DAYS_PATH).await {
        return e;
    }
    forward_hardware(&state, NEWS_EXPIRE_DAYS_PERSIST_PATH, persist_body(body)).await
}

async fn post_mining_coins(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, MINING_COINS_PATH).await {
        return e;
    }
    forward_hardware(&state, MINING_COINS_UPSERT_PATH, persist_body(body)).await
}

async fn post_season_passes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, SEASON_PASSES_PATH).await {
        return e;
    }
    let passes = match require_array(&body) {
        Ok(v) => v,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        SEASON_PASSES_REPLACE_PATH,
        json!({ "passes": passes }),
    )
    .await
}

async fn post_rig_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, RIG_ROOMS_PATH).await {
        return e;
    }
    // Node `Array.isArray(req.body) ? req.body : []` — a non-array body prunes
    // every unreferenced room instead of failing.
    let rooms = body.as_array().cloned().unwrap_or_default();
    forward_hardware(&state, RIG_ROOMS_UPSERT_PATH, json!({ "rooms": rooms })).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ACCESS_LEVELS_PATH, post(post_access_levels))
        .route(LOOT_BOXES_PATH, post(post_loot_boxes))
        .route(NEWS_PATH, post(post_news))
        .route(NEWS_ITEM_PATH, delete(delete_news))
        .route(NEWS_FEE_PATH, post(post_news_fee))
        .route(NEWS_EXPIRE_DAYS_PATH, post(post_news_expire_days))
        .route(MINING_COINS_PATH, post(post_mining_coins))
        .route(SEASON_PASSES_PATH, post(post_season_passes))
        .route(RIG_ROOMS_PATH, post(post_rig_rooms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_match_twins() {
        assert_eq!(
            ACCESS_LEVELS_REPLACE_PATH,
            "/v1/catalog/access-levels/replace"
        );
        assert_eq!(LOOT_BOXES_UPSERT_PATH, "/v1/catalog/loot-boxes/upsert");
        assert_eq!(NEWS_UPSERT_PATH, "/v1/catalog/news/upsert");
        assert_eq!(NEWS_DELETE_PATH, "/v1/catalog/news/delete");
        assert_eq!(NEWS_FEE_PERSIST_PATH, "/v1/settings/news-fee/persist");
        assert_eq!(
            NEWS_EXPIRE_DAYS_PERSIST_PATH,
            "/v1/settings/news-expire-days/persist"
        );
        assert_eq!(MINING_COINS_UPSERT_PATH, "/v1/catalog/mining-coins/upsert");
        assert_eq!(
            SEASON_PASSES_REPLACE_PATH,
            "/v1/catalog/season-passes/replace"
        );
        assert_eq!(RIG_ROOMS_UPSERT_PATH, "/v1/rooms/catalog/upsert");
    }

    #[test]
    fn array_bodies_are_required_for_levels_and_passes() {
        assert!(require_array(&json!([])).is_ok());
        for bad in [json!({}), json!(null), json!("x"), json!(3)] {
            let err = require_array(&bad).unwrap_err();
            assert_eq!(err.status().as_u16(), HTTP_BAD_REQUEST);
        }
    }

    #[test]
    fn loot_boxes_accept_legacy_array_and_wrapped_object() {
        let out = loot_boxes_body(&json!([{ "id": "b" }])).unwrap();
        assert_eq!(out["boxes"][0]["id"], "b");
        assert_eq!(out["replaceCatalog"], false);

        let out = loot_boxes_body(&json!({ "boxes": [], "replaceCatalog": true })).unwrap();
        assert_eq!(out["replaceCatalog"], true);

        // Only a strict `true` replaces the catalog.
        let out = loot_boxes_body(&json!({ "boxes": [], "replaceCatalog": 1 })).unwrap();
        assert_eq!(out["replaceCatalog"], false);
    }

    #[test]
    fn loot_boxes_reject_bodies_without_a_boxes_array() {
        for bad in [json!({}), json!({ "boxes": 3 }), json!(null), json!("x")] {
            let err = loot_boxes_body(&bad).unwrap_err();
            assert_eq!(err.status().as_u16(), HTTP_BAD_REQUEST);
        }
    }

    #[test]
    fn news_requires_a_non_blank_id_and_a_string_text() {
        let out = news_body(&json!({ "id": "n1", "text": "" })).unwrap();
        assert_eq!(out["payload"]["id"], "n1");

        for bad in [
            json!({ "text": "t" }),
            json!({ "id": "", "text": "t" }),
            json!({ "id": "   ", "text": "t" }),
            json!({ "id": 7, "text": "t" }),
            json!({ "id": "n1" }),
            json!({ "id": "n1", "text": 7 }),
            json!(null),
            json!([]),
        ] {
            let err = news_body(&bad).unwrap_err();
            assert_eq!(err.status().as_u16(), HTTP_BAD_REQUEST, "{bad}");
        }
    }

    #[test]
    fn persist_body_keeps_raw_payload() {
        assert_eq!(persist_body(json!([1]))["payload"], json!([1]));
        assert_eq!(persist_body(Value::Null)["payload"], Value::Null);
        assert_eq!(persist_body(json!({ "days": 3 }))["payload"]["days"], 3);
    }
}
