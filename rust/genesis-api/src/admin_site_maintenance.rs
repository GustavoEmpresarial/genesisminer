//! Admin site kill-switch (`POST /api/admin/site-maintenance`).
//!
//! Tab `settings`. Persist runs in genesis-mining-worker
//! (`POST /v1/site-maintenance`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::Value;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;

const ADMIN_SITE_MAINTENANCE_PATH: &str = "/api/admin/site-maintenance";
const W_SET: &str = "/v1/site-maintenance";

async fn set(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::POST, ADMIN_SITE_MAINTENANCE_PATH).await
    {
        return e;
    }
    forward_mining(&state, W_SET, body).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(ADMIN_SITE_MAINTENANCE_PATH, post(set))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match_client_and_worker() {
        assert_eq!(ADMIN_SITE_MAINTENANCE_PATH, "/api/admin/site-maintenance");
        assert_eq!(W_SET, "/v1/site-maintenance");
    }
}
