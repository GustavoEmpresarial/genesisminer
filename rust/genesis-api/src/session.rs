//! Cookie → userId + active-account gate (fail-closed workers).

use std::collections::HashMap;

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::{AppState, COOKIE_ACCESS, COOKIE_SID};
use crate::cookies::parse_cookies;
use crate::workers::{
    auth_unavailable_body, post_auth, post_mining, worker_infra_status, WorkerCallError,
};

const JWT_VERIFY_PATH: &str = "/v1/auth/jwt/verify";
const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
const USERS_ASSERT_ACTIVE_PATH: &str = "/v1/users/assert-active";

pub fn cookies_from_req(headers: &HeaderMap) -> HashMap<String, String> {
    parse_cookies(headers.get(header::COOKIE).and_then(|v| v.to_str().ok()))
}

pub fn json_status(status: u16, body: Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(body)).into_response()
}

pub fn auth_infra_response(err: &WorkerCallError) -> Response {
    warn!(err = %err.message(), "auth worker");
    json_status(worker_infra_status(err), auth_unavailable_body())
}

pub async fn resolve_user_id(
    state: &AppState,
    cookies: &HashMap<String, String>,
) -> Result<Option<(i64, Option<String>)>, Response> {
    let sid = cookies.get(COOKIE_SID).cloned().filter(|s| !s.is_empty());
    if let Some(access) = cookies.get(COOKIE_ACCESS).filter(|s| !s.is_empty()) {
        match post_auth(
            &state.cfg,
            &state.http,
            JWT_VERIFY_PATH,
            &json!({ "token": access }),
        )
        .await
        {
            Ok(r) if r.status == 200 && r.body["ok"] == true => {
                if let Some(uid) = r.body["userId"].as_i64().filter(|i| *i > 0) {
                    return Ok(Some((uid, sid)));
                }
            }
            Ok(_) => {}
            Err(e) => return Err(auth_infra_response(&e)),
        }
    }
    if let Some(sid) = sid.clone() {
        match post_auth(
            &state.cfg,
            &state.http,
            SESSION_LOAD_PATH,
            &json!({ "sessionId": sid }),
        )
        .await
        {
            Ok(r) if r.status == 200 && r.body["ok"] == true => {
                if let Some(uid) = r.body["userId"].as_i64().filter(|i| *i > 0) {
                    return Ok(Some((uid, Some(sid))));
                }
            }
            Ok(_) => {}
            Err(e) => return Err(auth_infra_response(&e)),
        }
    }
    Ok(None)
}

pub async fn require_player(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    let cookies = cookies_from_req(headers);
    let resolved = resolve_user_id(state, &cookies).await?;
    let Some((uid, _)) = resolved else {
        return Err(json_status(
            401,
            json!({ "error": "Not authenticated", "code": "AUTH_REQUIRED" }),
        ));
    };
    match post_mining(
        &state.cfg,
        &state.http,
        USERS_ASSERT_ACTIVE_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => Ok(uid),
        Ok(r) => Err(json_status(
            if r.status == 0 { 502 } else { r.status },
            json!({
                "error": r.body["error"].as_str().unwrap_or("Account check failed."),
                "code": r.body["code"].as_str().unwrap_or("FORBIDDEN")
            }),
        )),
        Err(e) => {
            warn!(err = %e.message(), "assert-active");
            Err(json_status(
                worker_infra_status(&e),
                json!({
                    "error": "Account check failed.",
                    "code": "FORBIDDEN"
                }),
            ))
        }
    }
}
