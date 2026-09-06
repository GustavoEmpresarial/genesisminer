//! `/api/partners/*` player → mining-worker `/v1/partners/*` (+ avatar multipart).

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::client_ip::get_client_ip;
use crate::config::{AppState, MINING_WORKER_PROGRESS_TIMEOUT_MS};
use crate::facade::{forward_mining, merge_user_id, worker_to_response};
use crate::rate_limit::{
    enforce, scoped_actor_key, PARTNERS_APPLY_RATE_LIMIT_MAX, PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS,
    PARTNERS_ME_RATE_LIMIT_MAX, PARTNERS_MINUTE_WINDOW_MS, PARTNERS_SUBMIT_RATE_LIMIT_MAX,
};
use crate::session::{cookies_from_req, json_status, require_player, resolve_user_id};
use crate::workers::{post_mining_multipart, worker_infra_status, WorkerCallError};

/// Node `partners.controller.ts` submit limiter scope / message.
const SCOPE_PARTNERS_SUBMIT: &str = "partners-submit";
const PARTNERS_SUBMIT_RATE_MSG: &str = "Too many submissions. Wait a minute.";
/// Node me limiter (my-submissions / avatar / my-profile).
const SCOPE_PARTNERS_ME: &str = "partners-me";
const PARTNERS_ME_RATE_MSG: &str = "Too many requests. Wait a minute.";
/// Node apply limiter.
const SCOPE_PARTNERS_APPLY: &str = "partners-apply";
const PARTNERS_APPLY_RATE_MSG: &str = "Too many applications. Wait a moment.";

const PARTNERS_STATE_PATH: &str = "/v1/partners/state";
const PARTNERS_VIDEOS_PATH: &str = "/v1/partners/videos";
const PARTNERS_VIDEO_BY_ID_PATH: &str = "/v1/partners/video-by-id";
const PARTNERS_MY_SUBMISSIONS_PATH: &str = "/v1/partners/my-submissions";
const PARTNERS_SUBMIT_PATH: &str = "/v1/partners/videos/submit";
const PARTNERS_APPLY_PATH: &str = "/v1/partners/youtube/apply";
const PARTNERS_PROFILE_PATH: &str = "/v1/partners/youtube/my-profile";
const UPLOAD_PARTNER_AVATAR_PATH: &str = "/v1/uploads/partner-avatar";

/// Node `AVATAR_UPLOAD_MAX_MB` × KB × B + envelope slack (same order as chat audio facade).
const AVATAR_UPLOAD_MAX_MB: usize = 5;
const BYTES_PER_KB: usize = 1024;
const AVATAR_UPLOAD_MAX_BYTES: usize = AVATAR_UPLOAD_MAX_MB * BYTES_PER_KB * BYTES_PER_KB;
/// Multipart envelope — mirror mining-worker support+chat slack formula with avatar file max.
const CHAT_AUDIO_MAX_BYTES: usize = 1_500_000;
const UPLOAD_HTTP_BODY_LIMIT_BYTES: usize = AVATAR_UPLOAD_MAX_BYTES + CHAT_AUDIO_MAX_BYTES;

const _: () = assert!(AVATAR_UPLOAD_MAX_BYTES == 5_242_880);
const _: () =
    assert!(UPLOAD_HTTP_BODY_LIMIT_BYTES == AVATAR_UPLOAD_MAX_BYTES + CHAT_AUDIO_MAX_BYTES);

#[derive(Debug, Deserialize)]
struct LimitCursorQ {
    limit: Option<String>,
    cursor: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/partners/state", get(partners_state))
        .route("/api/partners/videos", get(partners_videos))
        .route(
            "/api/partners/videos/{public_id}",
            get(partners_video_by_id),
        )
        .route("/api/partners/my-submissions", get(my_submissions))
        .route("/api/partners/videos/submit", post(submit_video))
        .route("/api/partners/youtube/apply", post(apply))
        .route(
            "/api/partners/youtube/avatar-upload",
            post(avatar_upload).layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route("/api/partners/youtube/my-profile", put(my_profile))
}

fn worker_err(err: WorkerCallError) -> Response {
    json_status(
        worker_infra_status(&err),
        json!({
            "error": "Worker unavailable.",
            "code": "WORKER_UNAVAILABLE",
        }),
    )
}

async fn optional_uid(state: &AppState, headers: &HeaderMap) -> Result<Option<i64>, Response> {
    let cookies = cookies_from_req(headers);
    match resolve_user_id(state, &cookies).await {
        Ok(Some((id, _))) => Ok(Some(id)),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    }
}

async fn partners_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> Response {
    let uid = match optional_uid(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut body = json!({});
    if let Some(id) = uid {
        body = json!({ "userId": id });
    }
    if let Value::Object(ref mut m) = body {
        if let Some(lim) = q.limit {
            m.insert("limit".into(), json!(lim));
        }
        if let Some(cur) = q.cursor {
            m.insert("cursor".into(), json!(cur));
        }
    }
    forward_mining(&state, PARTNERS_STATE_PATH, body).await
}

async fn partners_videos(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LimitCursorQ>,
) -> Response {
    let mut body = json!({});
    if let Value::Object(ref mut m) = body {
        if let Some(lim) = q.limit {
            m.insert("limit".into(), json!(lim));
        }
        if let Some(cur) = q.cursor {
            m.insert("cursor".into(), json!(cur));
        }
    }
    forward_mining(&state, PARTNERS_VIDEOS_PATH, body).await
}

async fn partners_video_by_id(
    State(state): State<Arc<AppState>>,
    Path(public_id): Path<String>,
) -> Response {
    forward_mining(
        &state,
        PARTNERS_VIDEO_BY_ID_PATH,
        json!({ "publicId": public_id }),
    )
    .await
}

async fn my_submissions(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_PARTNERS_ME, Some(uid), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        PARTNERS_ME_RATE_LIMIT_MAX,
        PARTNERS_MINUTE_WINDOW_MS,
        PARTNERS_ME_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_mining(
        &state,
        PARTNERS_MY_SUBMISSIONS_PATH,
        json!({ "userId": uid }),
    )
    .await
}

async fn submit_video(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_PARTNERS_SUBMIT, Some(uid), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        PARTNERS_SUBMIT_RATE_LIMIT_MAX,
        PARTNERS_MINUTE_WINDOW_MS,
        PARTNERS_SUBMIT_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_mining(&state, PARTNERS_SUBMIT_PATH, merge_user_id(body, uid)).await
}

async fn apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_PARTNERS_APPLY, Some(uid), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        PARTNERS_APPLY_RATE_LIMIT_MAX,
        PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS,
        PARTNERS_APPLY_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_mining(&state, PARTNERS_APPLY_PATH, merge_user_id(body, uid)).await
}

async fn my_profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_PARTNERS_ME, Some(uid), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        PARTNERS_ME_RATE_LIMIT_MAX,
        PARTNERS_MINUTE_WINDOW_MS,
        PARTNERS_ME_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_mining(&state, PARTNERS_PROFILE_PATH, merge_user_id(body, uid)).await
}

async fn avatar_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(SCOPE_PARTNERS_ME, Some(uid), &ip);
    if let Some(limited) = enforce(
        &state,
        &key,
        PARTNERS_ME_RATE_LIMIT_MAX,
        PARTNERS_MINUTE_WINDOW_MS,
        PARTNERS_ME_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    let mut avatar_bytes: Option<bytes::Bytes> = None;
    let mut original_name = String::from("avatar.png");
    let mut mime = String::new();
    while let Some(field) = match multipart.next_field().await {
        Ok(f) => f,
        Err(e) => {
            return json_status(400, json!({ "error": e.to_string() }));
        }
    } {
        let name = field.name().unwrap_or("").to_string();
        if name == "avatar" || name == "file" {
            if let Some(fnm) = field.file_name() {
                original_name = fnm.to_string();
            }
            if let Some(ct) = field.content_type() {
                mime = ct.to_string();
            }
            match field.bytes().await {
                Ok(b) => avatar_bytes = Some(b),
                Err(e) => {
                    return json_status(400, json!({ "error": e.to_string() }));
                }
            }
        } else {
            let _ = field.bytes().await;
        }
    }
    let Some(bytes) = avatar_bytes.filter(|b| !b.is_empty()) else {
        return json_status(
            400,
            json!({ "error": "File missing.", "code": "VALIDATION" }),
        );
    };
    if bytes.len() > AVATAR_UPLOAD_MAX_BYTES {
        return json_status(400, json!({ "error": "Invalid upload." }));
    }
    let part = match reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(original_name.clone())
        .mime_str(if mime.is_empty() {
            "application/octet-stream"
        } else {
            mime.as_str()
        }) {
        Ok(p) => p,
        Err(_) => reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(original_name.clone()),
    };
    let form = reqwest::multipart::Form::new()
        .part("avatar", part)
        .text("originalName", original_name)
        .text("mime", mime);
    let uploaded = match post_mining_multipart(
        &state.cfg,
        &state.http,
        UPLOAD_PARTNER_AVATAR_PATH,
        form,
        MINING_WORKER_PROGRESS_TIMEOUT_MS,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return worker_err(e),
    };
    if uploaded.body["ok"] != true {
        return worker_to_response(uploaded);
    }
    let avatar_url = uploaded.body["publicUrl"]
        .as_str()
        .unwrap_or("")
        .to_string();
    json_status(200, json!({ "ok": true, "avatarUrl": avatar_url }))
}
