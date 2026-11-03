//! TopIdle vote webhook (public POST, raw body) + player status.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use genesis_core::topidle::{
    TOPIDLE_HEADER_SIGNATURE, TOPIDLE_HEADER_TIMESTAMP, TOPIDLE_PUBLIC_STATUS_PATH,
    TOPIDLE_PUBLIC_WEBHOOK_PATH, TOPIDLE_WORKER_STATUS_PATH, TOPIDLE_WORKER_WEBHOOK_PATH,
};
use serde_json::json;

use crate::config::AppState;
use crate::facade::forward_mining;
use crate::session::{json_status, require_player};

const HTTP_BAD_REQUEST: u16 = 400;
const _: () = assert!(HTTP_BAD_REQUEST == 400);
const ERR_INVALID_BODY: &str = "Invalid body.";

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(TOPIDLE_PUBLIC_WEBHOOK_PATH, post(post_webhook))
        .route(TOPIDLE_PUBLIC_STATUS_PATH, get(get_status))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &'static str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

async fn post_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = match std::str::from_utf8(&body) {
        Ok(s) => s,
        Err(_) => {
            return json_status(
                HTTP_BAD_REQUEST,
                json!({ "ok": false, "error": ERR_INVALID_BODY }),
            )
        }
    };
    let timestamp = header_str(&headers, TOPIDLE_HEADER_TIMESTAMP);
    let signature = header_str(&headers, TOPIDLE_HEADER_SIGNATURE);
    forward_mining(
        &state,
        TOPIDLE_WORKER_WEBHOOK_PATH,
        json!({
            "rawBody": raw,
            "timestamp": timestamp,
            "signature": signature,
        }),
    )
    .await
}

async fn get_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(&state, TOPIDLE_WORKER_STATUS_PATH, json!({ "userId": uid })).await
}
