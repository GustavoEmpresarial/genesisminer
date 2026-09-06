//! Admin leftover tabs (`/api/*` writes outside the `/api/admin` prefix).
//!
//! `require_admin` + forward, mirroring the Express controllers these replace:
//! - `POST /api/upgrades` → `server/modules/catalog/controllers/catalog.controller.ts`
//! - `POST /api/economy-settings` / `exchange` / `monetization` →
//!   `server/modules/admin/*-settings/controllers/`
//! - `POST /api/upload-image` → `server/modules/admin/image-asset/controllers/`

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::{require_admin, require_is_admin};
use crate::config::AppState;
use crate::facade::{forward_hardware, forward_mining, worker_to_response};
use crate::session::json_status;
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

/// Public paths owned here (also the keys of the admin permission table).
const UPGRADES_PATH: &str = "/api/upgrades";
const ECONOMY_SETTINGS_PATH: &str = "/api/economy-settings";
const EXCHANGE_SETTINGS_PATH: &str = "/api/exchange-settings";
const MONETIZATION_SETTINGS_PATH: &str = "/api/monetization-settings";
const UPLOAD_IMAGE_PATH: &str = "/api/upload-image";

/// Worker twins.
const CATALOG_UPGRADES_REPLACE_PATH: &str = "/v1/catalog/upgrades/replace";
const ECONOMY_SETTINGS_PERSIST_PATH: &str = "/v1/settings/economy/persist";
const EXCHANGE_SETTINGS_PERSIST_PATH: &str = "/v1/settings/exchange/persist";
const MONETIZATION_SETTINGS_PERSIST_PATH: &str = "/v1/settings/monetization/persist";
const UPLOAD_ADMIN_IMAGE_DATA_URL_PATH: &str = "/v1/uploads/admin-image-data-url";

/// Node `HTTP_BAD_REQUEST` in catalog.controller.ts.
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_OK: u16 = 200;

/// Node `DEFAULT_BODY_LIMIT` in `server/bootstrap/app.ts` ('5mb') — the cap the
/// data-URL upload used on Express, so keep the same ceiling here.
const DEFAULT_BODY_LIMIT_MB: usize = 5;
const BYTES_PER_KB: usize = 1024;
const KB_PER_MB: usize = 1024;
const DEFAULT_BODY_LIMIT_BYTES: usize = DEFAULT_BODY_LIMIT_MB * KB_PER_MB * BYTES_PER_KB;

/// Node catalog.controller messages / codes.
const ERR_LEGACY_ARRAY_PAYLOAD: &str =
    "Payload inválido: envie { upgrades, expectedCatalogRevision }. Array legado não é aceite.";
const ERR_CATALOG_PAYLOAD_INVALID: &str = "Payload inválido.";
const CODE_CATALOG_REVISION_REQUIRED: &str = "CATALOG_REVISION_REQUIRED";
const CODE_CATALOG_PAYLOAD_INVALID: &str = "CATALOG_PAYLOAD_INVALID";

fn bad_request(error: &str, code: &str) -> Response {
    json_status(HTTP_BAD_REQUEST, json!({ "error": error, "code": code }))
}

/// Node controller guard: the legacy bare-array body is rejected with its own
/// message so the panel knows to resend with `expectedCatalogRevision`.
fn upgrades_replace_body(body: &Value) -> Result<Value, Response> {
    if body.is_array() {
        return Err(bad_request(
            ERR_LEGACY_ARRAY_PAYLOAD,
            CODE_CATALOG_REVISION_REQUIRED,
        ));
    }
    let Some(obj) = body.as_object() else {
        return Err(bad_request(
            ERR_CATALOG_PAYLOAD_INVALID,
            CODE_CATALOG_PAYLOAD_INVALID,
        ));
    };
    let Some(upgrades) = obj.get("upgrades").filter(|v| v.is_array()) else {
        return Err(bad_request(
            ERR_CATALOG_PAYLOAD_INVALID,
            CODE_CATALOG_PAYLOAD_INVALID,
        ));
    };
    // `expectedCatalogRevision` stays raw: the hardware twin owns the
    // `CATALOG_REVISION_REQUIRED` parse, including the absent case.
    Ok(json!({
        "upgrades": upgrades,
        "expectedCatalogRevision": obj.get("expectedCatalogRevision").cloned().unwrap_or(Value::Null),
    }))
}

async fn post_upgrades(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, UPGRADES_PATH).await {
        return e;
    }
    let forwarded = match upgrades_replace_body(&body) {
        Ok(v) => v,
        Err(e) => return e,
    };
    forward_hardware(&state, CATALOG_UPGRADES_REPLACE_PATH, forwarded).await
}

/// The Node services read `req.body` raw (arrays and `null` included), so the
/// twin carries it under `payload` instead of spreading it.
fn persist_body(body: Value) -> Value {
    json!({ "payload": body })
}

async fn post_economy_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ECONOMY_SETTINGS_PATH).await {
        return e;
    }
    forward_mining(&state, ECONOMY_SETTINGS_PERSIST_PATH, persist_body(body)).await
}

async fn post_exchange_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, EXCHANGE_SETTINGS_PATH).await {
        return e;
    }
    forward_mining(&state, EXCHANGE_SETTINGS_PERSIST_PATH, persist_body(body)).await
}

async fn post_monetization_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, MONETIZATION_SETTINGS_PATH).await
    {
        return e;
    }
    forward_mining(
        &state,
        MONETIZATION_SETTINGS_PERSIST_PATH,
        persist_body(body),
    )
    .await
}

/// Node reads the three fields off `req.body || {}`; a non-object body just
/// yields `undefined` everywhere and lands on "Missing dataUrl".
fn upload_image_body(body: &Value) -> Value {
    json!({
        "dataUrl": body.get("dataUrl").cloned().unwrap_or(Value::Null),
        "originalName": body.get("originalName").cloned().unwrap_or(Value::Null),
        "assetFolder": body.get("assetFolder").cloned().unwrap_or(Value::Null),
    })
}

/// Node answers `{ path }` on success and `{ error }` on failure; the worker
/// twin speaks the shared `{ ok, publicUrl, error, code }` upload envelope.
fn upload_image_response(worker: crate::workers::WorkerJson) -> Response {
    if worker.status == HTTP_OK && worker.body["ok"] == true {
        if let Some(public_url) = worker.body["publicUrl"].as_str() {
            return json_status(HTTP_OK, json!({ "path": public_url }));
        }
    }
    worker_to_response(worker)
}

/// `POST /api/upload-image` — the Express handler checked `users.is_admin`
/// inline (no `isAdmin` middleware, so no tab requirement); `require_is_admin`
/// keeps that contract instead of the default-deny `Super` a route rule
/// would imply.
async fn post_upload_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_is_admin(&state, &headers).await {
        return e;
    }
    match post_mining(
        &state.cfg,
        &state.http,
        UPLOAD_ADMIN_IMAGE_DATA_URL_PATH,
        &upload_image_body(&body),
    )
    .await
    {
        Ok(r) => upload_image_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(UPGRADES_PATH, post(post_upgrades))
        .route(ECONOMY_SETTINGS_PATH, post(post_economy_settings))
        .route(EXCHANGE_SETTINGS_PATH, post(post_exchange_settings))
        .route(MONETIZATION_SETTINGS_PATH, post(post_monetization_settings))
        .route(
            UPLOAD_IMAGE_PATH,
            post(post_upload_image).layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT_BYTES)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_match_twins() {
        assert_eq!(
            CATALOG_UPGRADES_REPLACE_PATH,
            "/v1/catalog/upgrades/replace"
        );
        assert_eq!(
            ECONOMY_SETTINGS_PERSIST_PATH,
            "/v1/settings/economy/persist"
        );
        assert_eq!(
            EXCHANGE_SETTINGS_PERSIST_PATH,
            "/v1/settings/exchange/persist"
        );
        assert_eq!(
            MONETIZATION_SETTINGS_PERSIST_PATH,
            "/v1/settings/monetization/persist"
        );
    }

    #[test]
    fn legacy_array_body_is_rejected_with_revision_code() {
        let err = upgrades_replace_body(&json!([])).unwrap_err();
        assert_eq!(err.status().as_u16(), HTTP_BAD_REQUEST);
    }

    #[test]
    fn non_object_and_missing_upgrades_are_rejected() {
        assert!(upgrades_replace_body(&json!("x")).is_err());
        assert!(upgrades_replace_body(&json!(null)).is_err());
        assert!(upgrades_replace_body(&json!({})).is_err());
        assert!(upgrades_replace_body(&json!({ "upgrades": 3 })).is_err());
    }

    #[test]
    fn valid_body_forwards_revision_and_upgrades() {
        let out = upgrades_replace_body(&json!({
            "upgrades": [{ "id": "rack_basic" }],
            "expectedCatalogRevision": 7
        }))
        .unwrap();
        assert_eq!(out["expectedCatalogRevision"], 7);
        assert_eq!(out["upgrades"][0]["id"], "rack_basic");
    }

    #[test]
    fn missing_revision_forwards_null_for_worker_parse() {
        let out = upgrades_replace_body(&json!({ "upgrades": [] })).unwrap();
        assert_eq!(out["expectedCatalogRevision"], Value::Null);
    }

    #[test]
    fn upload_image_paths_and_limit_match_node() {
        assert_eq!(
            UPLOAD_ADMIN_IMAGE_DATA_URL_PATH,
            "/v1/uploads/admin-image-data-url"
        );
        assert_eq!(DEFAULT_BODY_LIMIT_BYTES, 5_242_880);
    }

    #[test]
    fn upload_image_body_normalizes_non_objects() {
        let out = upload_image_body(&json!({
            "dataUrl": "data:image/png;base64,aGk=",
            "originalName": "logo.png",
            "assetFolder": "miner",
            "ignored": 1
        }));
        assert_eq!(out["dataUrl"], "data:image/png;base64,aGk=");
        assert_eq!(out["originalName"], "logo.png");
        assert_eq!(out["assetFolder"], "miner");
        assert!(out.get("ignored").is_none());
        for raw in [json!([]), json!("x"), Value::Null] {
            let out = upload_image_body(&raw);
            assert_eq!(out["dataUrl"], Value::Null);
            assert_eq!(out["assetFolder"], Value::Null);
        }
    }

    #[test]
    fn upload_image_response_unwraps_public_url() {
        let ok = upload_image_response(crate::workers::WorkerJson {
            status: HTTP_OK,
            body: json!({ "ok": true, "publicUrl": "/img/1_a_logo.png" }),
        });
        assert_eq!(ok.status().as_u16(), HTTP_OK);
        let failed = upload_image_response(crate::workers::WorkerJson {
            status: HTTP_BAD_REQUEST,
            body: json!({ "ok": false, "error": "Missing dataUrl" }),
        });
        assert_eq!(failed.status().as_u16(), HTTP_BAD_REQUEST);
    }

    #[test]
    fn persist_body_keeps_raw_payload() {
        assert_eq!(persist_body(json!([1]))["payload"], json!([1]));
        assert_eq!(persist_body(Value::Null)["payload"], Value::Null);
        assert_eq!(
            persist_body(json!({ "marketTaxPercent": 5 }))["payload"]["marketTaxPercent"],
            5
        );
    }
}
