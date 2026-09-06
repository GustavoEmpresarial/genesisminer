//! `/api/partner-games/*` → mining-worker `/v1/partner-games/*`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

/// Lenient body parse — the client posts these with a JSON content-type but an
/// empty body, so `Json<Value>` would reject with 400. Treat empty/invalid as `{}`.
fn body_or_empty(bytes: &Bytes) -> Value {
    if bytes.is_empty() {
        return json!({});
    }
    serde_json::from_slice(bytes).unwrap_or_else(|_| json!({}))
}

use crate::client_ip::get_client_ip;
use crate::config::AppState;
use crate::facade::{forward_mining, merge_user_id};
use crate::rate_limit::{
    enforce, scoped_actor_key, PARTNER_GAMES_RATE_LIMIT_MAX, PARTNER_GAMES_WINDOW_MS,
};
use crate::session::require_player;

const CONFIG_PATH: &str = "/v1/partner-games/config";
const VISIT_PATH: &str = "/v1/partner-games/visit";
const HEARTBEAT_PATH: &str = "/v1/partner-games/heartbeat";
const STOP_PATH: &str = "/v1/partner-games/stop";

/// Node `partner-games.controller.ts` key scope / message.
const SCOPE_PARTNER_GAMES: &str = "partner-games";
const PARTNER_GAMES_RATE_MSG: &str = "Too many partner-games requests. Wait a minute.";

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/partner-games/config", get(config))
        .route("/api/partner-games/visit", post(visit))
        .route("/api/partner-games/heartbeat", post(heartbeat))
        .route("/api/partner-games/stop", post(stop))
}

async fn enforce_partner_games(
    state: &AppState,
    headers: &HeaderMap,
    uid: i64,
) -> Option<Response> {
    let ip = get_client_ip(&state.cfg, headers, None);
    let key = scoped_actor_key(SCOPE_PARTNER_GAMES, Some(uid), &ip);
    enforce(
        state,
        &key,
        PARTNER_GAMES_RATE_LIMIT_MAX,
        PARTNER_GAMES_WINDOW_MS,
        PARTNER_GAMES_RATE_MSG,
    )
    .await
}

async fn config(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if let Some(limited) = enforce_partner_games(&state, &headers, uid).await {
        return limited;
    }
    forward_mining(&state, CONFIG_PATH, json!({ "userId": uid })).await
}

async fn visit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if let Some(limited) = enforce_partner_games(&state, &headers, uid).await {
        return limited;
    }
    forward_mining(&state, VISIT_PATH, merge_user_id(body_or_empty(&body), uid)).await
}

async fn heartbeat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if let Some(limited) = enforce_partner_games(&state, &headers, uid).await {
        return limited;
    }
    forward_mining(&state, HEARTBEAT_PATH, merge_user_id(body_or_empty(&body), uid)).await
}

async fn stop(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if let Some(limited) = enforce_partner_games(&state, &headers, uid).await {
        return limited;
    }
    forward_mining(&state, STOP_PATH, merge_user_id(body_or_empty(&body), uid)).await
}
