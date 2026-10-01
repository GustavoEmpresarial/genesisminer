//! Admin shop checkout history — `GET /api/admin/shop/checkouts`.
//!
//! Debits are in-game USDC (`shop_checkout_idempotency`), not the OpenSea treasury wallet.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::worker_to_response;
use crate::session::json_status;
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

const ADMIN_SHOP_CHECKOUTS_PATH: &str = "/api/admin/shop/checkouts";
const WORKER_SHOP_CHECKOUTS_PATH: &str = "/v1/admin/shop/checkouts";
const ADMIN_PURCHASES_REPORT_PATH: &str = "/api/admin/purchases/report";
const WORKER_PURCHASES_REPORT_PATH: &str = "/v1/admin/purchases/report";
const HTTP_OK: u16 = 200;

const _: () = assert!(HTTP_OK == 200);

async fn get_shop_checkouts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_SHOP_CHECKOUTS_PATH).await
    {
        return e;
    }
    let body = json!({
        "itemId": params.get("itemId").cloned().unwrap_or_default(),
        "userId": params.get("userId").cloned().unwrap_or_default(),
        "q": params.get("q").cloned().unwrap_or_default(),
    });
    match post_mining(&state.cfg, &state.http, WORKER_SHOP_CHECKOUTS_PATH, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut out = r.body.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, out)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_purchases_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_PURCHASES_REPORT_PATH).await
    {
        return e;
    }
    let body = json!({
        "itemId": params.get("itemId").cloned().unwrap_or_default(),
        "userId": params.get("userId").cloned().unwrap_or_default(),
        "q": params.get("q").cloned().unwrap_or_default(),
        "fromMs": params.get("fromMs").cloned().unwrap_or_default(),
        "toMs": params.get("toMs").cloned().unwrap_or_default(),
    });
    match post_mining(&state.cfg, &state.http, WORKER_PURCHASES_REPORT_PATH, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut out = r.body.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, out)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ADMIN_SHOP_CHECKOUTS_PATH, get(get_shop_checkouts))
        .route(ADMIN_PURCHASES_REPORT_PATH, get(get_purchases_report))
}

