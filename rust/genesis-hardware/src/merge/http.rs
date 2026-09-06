//! Axum handler for `POST /v1/merge/execute`.
//!
//! Contract: `{ userId, itemId, count }` (client sends only these). All catalog
//! validation, result-stat computation, FIFO stock planning and result-upgrade
//! resolution happen in [`super::resolve`]; the USDC fee + stock adjust +
//! `merge_history` write is [`super::execute`].

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::http::AppState;

use super::execute::MergeError;
use super::resolve::run_merge;

fn default_count() -> i32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeExecuteRequest {
    pub user_id: i64,
    /// Client field is `itemId`; accept `sourceItemId` too for older callers.
    #[serde(alias = "sourceItemId")]
    pub item_id: String,
    #[serde(default = "default_count")]
    pub count: i32,
}

fn merge_fail(e: MergeError) -> Response {
    match e {
        MergeError::Domain {
            status,
            error,
            code,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (sc, Json(json!({ "ok": false, "error": error, "code": code }))).into_response()
        }
        MergeError::Transport(err) => {
            warn!(err = %err, "merge transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response()
        }
    }
}

pub async fn post_execute(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MergeExecuteRequest>,
) -> Response {
    match run_merge(&state.pool, body.user_id, &body.item_id, body.count).await {
        Ok(payload) => (StatusCode::OK, Json::<Value>(payload)).into_response(),
        Err(e) => merge_fail(e),
    }
}
