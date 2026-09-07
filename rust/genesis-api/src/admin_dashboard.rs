//! Admin Dashboard / "Hub" (`/api/admin/dashboard-stats`, `/api/admin/metrics`,
//! `/api/admin/ranking-exclusion`, `/api/admin/users/map`).
//!
//! Replaces `server/modules/admin/dashboard/` (Express). `require_admin` gates
//! on the tabs already wired in [`crate::admin_auth`] (`dashboard`,
//! `AnyOf([metrics,dashboard])`, `users`); the SQL runs in
//! `genesis-mining-worker` (`admin_dashboard.rs`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;
use crate::session::json_status;
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

const P_STATS: &str = "/api/admin/dashboard-stats";
const P_METRICS: &str = "/api/admin/metrics";
const P_RANKING_EXCLUSION: &str = "/api/admin/ranking-exclusion";
const P_USERS_MAP: &str = "/api/admin/users/map";

const W_STATS: &str = "/v1/admin/dashboard/stats";
const W_METRICS: &str = "/v1/admin/dashboard/metrics";
const W_RANKING_EXCLUSION: &str = "/v1/admin/dashboard/ranking-exclusion";
const W_USERS_MAP: &str = "/v1/admin/dashboard/users-map";

async fn stats(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_STATS).await {
        return e;
    }
    forward_mining(&state, W_STATS, json!({})).await
}

async fn metrics(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_METRICS).await {
        return e;
    }
    forward_mining(&state, W_METRICS, json!({})).await
}

async fn ranking_exclusion(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_RANKING_EXCLUSION).await {
        return e;
    }
    forward_mining(&state, W_RANKING_EXCLUSION, body).await
}

/// Node returns a bare array; the worker wraps it as `{ ok, rows }`.
async fn users_map(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_USERS_MAP).await {
        return e;
    }
    match post_mining(&state.cfg, &state.http, W_USERS_MAP, &json!({})).await {
        Ok(w) => {
            let rows = w
                .body
                .get("rows")
                .cloned()
                .unwrap_or_else(|| json!([]));
            json_status(if w.status == 0 { 502 } else { w.status }, rows)
        }
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_STATS, get(stats))
        .route(P_METRICS, get(metrics))
        .route(P_RANKING_EXCLUSION, post(ranking_exclusion))
        .route(P_USERS_MAP, get(users_map))
}
