//! Admin Partners/Streamer YouTube panel
//! (`/api/admin/partner-youtube-*`, `/api/admin/partner-videos*`,
//! `/api/admin/streamer-room-users*`).
//!
//! Replaces `server/modules/partners/controllers/partners-admin.controller.ts`
//! (Express). `require_admin` gates on tab `partners` (route table in
//! [`crate::admin_auth`]); the SQL runs in `genesis-mining-worker`
//! (`partners_admin.rs`). The streamer-room rack teardown runs in
//! `genesis-hardware` (`partners_streamer.rs`); `partner-videos/{id}/approve`
//! is forwarded to `genesis-wallet`. Player `/api/partners/*` stays in
//! [`crate::partners`].

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::{forward_hardware, forward_mining, forward_wallet};
use crate::session::json_status;

// Client paths.
const P_APPLICATIONS: &str = "/api/admin/partner-youtube-applications";
const P_APPLICATION_APPROVE: &str = "/api/admin/partner-youtube-applications/{id}/approve";
const P_APPLICATION_REJECT: &str = "/api/admin/partner-youtube-applications/{id}/reject";
const P_PARTNERS: &str = "/api/admin/partner-youtube-partners";
const P_DEACTIVATE_NFT_ROOM: &str =
    "/api/admin/partner-youtube-partners/{user_id}/deactivate-nft-room";
const P_STREAMER_USERS: &str = "/api/admin/streamer-room-users";
const P_STREAMER_DEACTIVATE: &str = "/api/admin/streamer-room-users/{user_id}/deactivate";
const P_ALLOWLIST: &str = "/api/admin/partner-youtube-allowlist";
const P_ALLOWLIST_REMOVE: &str = "/api/admin/partner-youtube-allowlist/{user_id}";
const P_VIDEOS: &str = "/api/admin/partner-videos";
const P_VIDEO_APPROVE: &str = "/api/admin/partner-videos/{id}/approve";
const P_VIDEO_REJECT: &str = "/api/admin/partner-videos/{id}/reject";
const P_VIDEO_DELETE: &str = "/api/admin/partner-videos/{id}";
const P_CREATOR: &str = "/api/admin/partner-youtube-creators/{user_id}";

// genesis-mining-worker twins.
const W_APPLICATIONS_LIST: &str = "/v1/partners/admin/applications/list";
const W_APPLICATION_APPROVE: &str = "/v1/partners/admin/applications/approve";
const W_APPLICATION_REJECT: &str = "/v1/partners/admin/applications/reject";
const W_PARTNERS_LIST: &str = "/v1/partners/admin/partners/list";
const W_STREAMER_USERS: &str = "/v1/partners/admin/streamer-room-users/list";
const W_ALLOWLIST_ADD: &str = "/v1/partners/admin/allowlist/add";
const W_ALLOWLIST_REMOVE: &str = "/v1/partners/admin/allowlist/remove";
const W_SUBMISSIONS_LIST: &str = "/v1/partners/admin/submissions/list";
const W_SUBMISSION_REJECT: &str = "/v1/partners/admin/submissions/reject";
const W_SUBMISSION_DELETE: &str = "/v1/partners/admin/submissions/delete";
const W_CREATOR_GET: &str = "/v1/partners/admin/creator/get";
const W_CREATOR_PUT: &str = "/v1/partners/admin/creator/put";
// genesis-hardware / genesis-wallet twins.
const W_STREAMER_DEACTIVATE: &str = "/v1/partners/streamer-room/deactivate";
const W_VIDEO_APPROVE: &str = "/v1/partners/youtube/submissions/approve";

const ID_MAX_LENGTH: usize = 120;
const REJECT_REASON_MAX_LENGTH: usize = 500;

#[derive(Debug, Default, Deserialize)]
struct StatusQ {
    #[serde(default)]
    status: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clean_id(raw: &str) -> String {
    raw.trim().chars().take(ID_MAX_LENGTH).collect()
}

fn parse_user_id(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok().filter(|n| *n >= 1)
}

fn reason_from_body(body: &Value) -> String {
    body.get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(REJECT_REASON_MAX_LENGTH)
        .collect()
}

// --- applications --------------------------------------------------------

async fn applications_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<StatusQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_APPLICATIONS).await {
        return e;
    }
    forward_mining(
        &state,
        W_APPLICATIONS_LIST,
        json!({ "status": q.status.unwrap_or_default() }),
    )
    .await
}

async fn application_approve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_APPLICATIONS).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let id = clean_id(&id);
    if id.is_empty() {
        return json_status(400, json!({ "error": "ID inválido." }));
    }
    forward_mining(
        &state,
        W_APPLICATION_APPROVE,
        json!({ "id": id, "adminUserId": ctx.user_id }),
    )
    .await
}

async fn application_reject(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_APPLICATIONS).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let id = clean_id(&id);
    if id.is_empty() {
        return json_status(400, json!({ "error": "ID inválido." }));
    }
    forward_mining(
        &state,
        W_APPLICATION_REJECT,
        json!({ "id": id, "adminUserId": ctx.user_id, "reason": reason_from_body(&body) }),
    )
    .await
}

// --- partners list / streamer room -------------------------------------

async fn partners_list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_PARTNERS).await {
        return e;
    }
    forward_mining(&state, W_PARTNERS_LIST, json!({})).await
}

async fn streamer_users(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_STREAMER_USERS).await {
        return e;
    }
    forward_mining(&state, W_STREAMER_USERS, json!({})).await
}

async fn streamer_deactivate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_STREAMER_USERS).await {
        return e;
    }
    let Some(uid) = parse_user_id(&user_id) else {
        return json_status(400, json!({ "error": "ID de utilizador inválido." }));
    };
    forward_hardware(&state, W_STREAMER_DEACTIVATE, json!({ "userId": uid })).await
}

async fn deactivate_nft_room(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_PARTNERS).await {
        return e;
    }
    let Some(uid) = parse_user_id(&user_id) else {
        return json_status(400, json!({ "error": "ID de utilizador inválido." }));
    };
    forward_hardware(&state, W_STREAMER_DEACTIVATE, json!({ "userId": uid })).await
}

// --- allowlist --------------------------------------------------------

async fn allowlist_add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_ALLOWLIST).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        W_ALLOWLIST_ADD,
        json!({
            "userId": body.get("userId").cloned().unwrap_or(Value::Null),
            "username": body.get("username").and_then(Value::as_str).unwrap_or(""),
            "adminUserId": ctx.user_id,
        }),
    )
    .await
}

async fn allowlist_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, P_ALLOWLIST).await {
        return e;
    }
    let Some(uid) = parse_user_id(&user_id) else {
        return json_status(400, json!({ "error": "ID de utilizador inválido." }));
    };
    forward_mining(&state, W_ALLOWLIST_REMOVE, json!({ "userId": uid })).await
}

// --- submissions (partner-videos) -----------------------------------

async fn submissions_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<StatusQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_VIDEOS).await {
        return e;
    }
    forward_mining(
        &state,
        W_SUBMISSIONS_LIST,
        json!({ "status": q.status.unwrap_or_default() }),
    )
    .await
}

async fn video_approve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_VIDEOS).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let id = clean_id(&id);
    if id.is_empty() {
        return json_status(400, json!({ "error": "ID inválido." }));
    }
    forward_wallet(
        &state,
        W_VIDEO_APPROVE,
        json!({ "id": id, "adminUserId": ctx.user_id, "reviewedAt": now_ms() }),
    )
    .await
}

async fn video_reject(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_VIDEOS).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let id = clean_id(&id);
    if id.is_empty() {
        return json_status(400, json!({ "error": "ID inválido." }));
    }
    forward_mining(
        &state,
        W_SUBMISSION_REJECT,
        json!({ "id": id, "adminUserId": ctx.user_id, "reason": reason_from_body(&body) }),
    )
    .await
}

async fn video_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, P_VIDEOS).await {
        return e;
    }
    let id = clean_id(&id);
    if id.is_empty() {
        return json_status(400, json!({ "error": "ID inválido." }));
    }
    forward_mining(&state, W_SUBMISSION_DELETE, json!({ "id": id })).await
}

// --- creator profile ------------------------------------------------

async fn creator_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_PARTNERS).await {
        return e;
    }
    let Some(uid) = parse_user_id(&user_id) else {
        return json_status(400, json!({ "error": "ID de utilizador inválido." }));
    };
    forward_mining(&state, W_CREATOR_GET, json!({ "userId": uid })).await
}

async fn creator_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::PUT, P_PARTNERS).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(uid) = parse_user_id(&user_id) else {
        return json_status(400, json!({ "error": "ID de utilizador inválido." }));
    };
    let mut payload = json!({ "userId": uid, "adminUserId": ctx.user_id });
    if let Value::Object(ref mut m) = payload {
        for key in ["channelUrl", "avatarUrl", "channelName", "description"] {
            if let Some(v) = body.get(key) {
                m.insert(key.to_string(), v.clone());
            }
        }
    }
    forward_mining(&state, W_CREATOR_PUT, payload).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_APPLICATIONS, get(applications_list))
        .route(P_APPLICATION_APPROVE, post(application_approve))
        .route(P_APPLICATION_REJECT, post(application_reject))
        .route(P_PARTNERS, get(partners_list))
        .route(P_DEACTIVATE_NFT_ROOM, post(deactivate_nft_room))
        .route(P_STREAMER_USERS, get(streamer_users))
        .route(P_STREAMER_DEACTIVATE, post(streamer_deactivate))
        .route(P_ALLOWLIST, post(allowlist_add))
        .route(P_ALLOWLIST_REMOVE, delete(allowlist_remove))
        .route(P_VIDEOS, get(submissions_list))
        .route(P_VIDEO_APPROVE, post(video_approve))
        .route(P_VIDEO_REJECT, post(video_reject))
        .route(P_VIDEO_DELETE, delete(video_delete))
        .route(P_CREATOR, get(creator_get).put(creator_put))
}
