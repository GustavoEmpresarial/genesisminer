//! Admin ranking (`GET /api/admin/ranking`).
//!
//! Replaces `server/modules/ranking` (Express). `require_admin` gates on tab
//! `users` (route table in [`crate::admin_auth`]); the payload is computed by
//! `genesis-mining-worker` (`GET /v1/ranking/admin`). Player `/api/ranking/*`
//! is owned by [`crate::player`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::Router;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::worker_to_response;
use crate::session::json_status;
use crate::workers::get_mining;

const ADMIN_RANKING_PATH: &str = "/api/admin/ranking";
const WORKER_ADMIN_RANKING_PATH: &str = "/v1/ranking/admin";

async fn admin_ranking(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_RANKING_PATH).await {
        return e;
    }
    match get_mining(&state.cfg, &state.http, WORKER_ADMIN_RANKING_PATH).await {
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(ADMIN_RANKING_PATH, get(admin_ranking))
}
