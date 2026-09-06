//! Public `/api/account-manager/*` facades → mining-worker `/v1/gerente/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tracing::warn;

use crate::client_ip::get_client_ip;
use crate::config::{AppState, COOKIE_SID};
use crate::facade::{forward_mining, worker_to_response};
use crate::session::{
    auth_infra_response, cookies_from_req, json_status, require_player, resolve_user_id,
};
use crate::workers::{
    post_auth, post_mining, worker_infra_status, worker_unavailable_body, WorkerCallError,
};

const GERENTE_ME_PATH: &str = "/v1/gerente/me";
const GERENTE_HIRE_PATH: &str = "/v1/gerente/hire";
const GERENTE_APPLY_PATH: &str = "/v1/gerente/apply";
const GERENTE_ACCEPT_PATH: &str = "/v1/gerente/accept";
const GERENTE_DECLINE_PATH: &str = "/v1/gerente/decline";
const GERENTE_FIRE_PATH: &str = "/v1/gerente/fire";
const GERENTE_RESIGN_PATH: &str = "/v1/gerente/resign";
const GERENTE_ENTER_PATH: &str = "/v1/gerente/enter";
const GERENTE_LEAVE_PATH: &str = "/v1/gerente/leave";

const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
const JWT_SIGN_PATH: &str = "/v1/auth/jwt/sign";
const REFRESH_ISSUE_PATH: &str = "/v1/auth/refresh/issue";
const REFRESH_REVOKE_PATH: &str = "/v1/auth/refresh/revoke";

const HTTP_OK: u16 = 200;
const HTTP_UNAUTHORIZED: u16 = 401;
const SESSION_MANAGER_MODE_ON: i64 = 1;

struct ManagerCtx {
    session_user_id: i64,
    manager_mode: bool,
    manager_user_id: Option<i64>,
    session_id: Option<String>,
}

async fn load_manager_ctx(state: &AppState, headers: &HeaderMap) -> Result<ManagerCtx, Response> {
    let cookies = cookies_from_req(headers);
    let resolved = resolve_user_id(state, &cookies).await?;
    let Some((session_user_id, sid)) = resolved else {
        return Err(json_status(
            HTTP_UNAUTHORIZED,
            json!({ "error": "AUTH_REQUIRED", "code": "AUTH_REQUIRED" }),
        ));
    };
    let _ = require_player(state, headers).await?;

    let mut manager_mode = false;
    let mut manager_user_id = None;
    if let Some(ref session_id) = sid {
        match post_auth(
            &state.cfg,
            &state.http,
            SESSION_LOAD_PATH,
            &json!({ "sessionId": session_id, "includeExpired": true }),
        )
        .await
        {
            Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
                let mode = r.body["managerMode"].as_i64().unwrap_or(0);
                if mode == SESSION_MANAGER_MODE_ON {
                    manager_mode = true;
                    manager_user_id = r.body["originalUserId"].as_i64().filter(|i| *i > 0);
                }
            }
            Ok(_) => {}
            Err(e) => {
                warn!(err = %e.message(), "gerente session load");
                return Err(auth_infra_response(&e));
            }
        }
    }

    Ok(ManagerCtx {
        session_user_id,
        manager_mode,
        manager_user_id,
        session_id: sid.or_else(|| cookies.get(COOKIE_SID).cloned().filter(|s| !s.is_empty())),
    })
}

fn append_cookie(res: &mut Response, value: String) {
    if let Ok(hv) = header::HeaderValue::from_str(&value) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
}

async fn issue_jwt_auth_cookies(
    state: &AppState,
    headers: &HeaderMap,
    user_id: i64,
) -> Result<(String, u64, String, u64), Response> {
    match post_auth(
        &state.cfg,
        &state.http,
        REFRESH_REVOKE_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => return Err(auth_infra_response(&e)),
    }
    let ip = get_client_ip(&state.cfg, headers, None);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    let issued = match post_auth(
        &state.cfg,
        &state.http,
        REFRESH_ISSUE_PATH,
        &json!({ "userId": user_id, "userAgent": ua, "ip": ip }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => r,
        Ok(r) => {
            return Err(json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({ "error": "Could not renew session." }),
            ));
        }
        Err(e) => return Err(auth_infra_response(&e)),
    };
    let refresh = issued.body["refreshToken"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let refresh_ttl = issued.body["expiresInSec"].as_u64().unwrap_or(0);
    let signed = match post_auth(
        &state.cfg,
        &state.http,
        JWT_SIGN_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => r,
        Ok(r) => {
            return Err(json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({ "error": "Could not renew session." }),
            ));
        }
        Err(e) => return Err(auth_infra_response(&e)),
    };
    let access = signed.body["token"].as_str().unwrap_or("").to_string();
    let access_ttl = signed.body["expiresInSec"].as_u64().unwrap_or(0);
    if access.is_empty() || refresh.is_empty() || access_ttl == 0 || refresh_ttl == 0 {
        return Err(json_status(
            500,
            json!({ "error": "Could not renew session." }),
        ));
    }
    Ok((access, access_ttl, refresh, refresh_ttl))
}

fn ensure_object(body: Value) -> Value {
    match body {
        Value::Object(_) => body,
        _ => json!({}),
    }
}

fn with_manager_fields(body: Value, ctx: &ManagerCtx) -> Value {
    let mut obj = match ensure_object(body) {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("userId".into(), json!(ctx.session_user_id));
    obj.insert("managerMode".into(), json!(ctx.manager_mode));
    if let Some(mid) = ctx.manager_user_id {
        obj.insert("managerUserId".into(), json!(mid));
    }
    if let Some(sid) = ctx.session_id.as_ref() {
        obj.insert("sessionId".into(), json!(sid));
    }
    Value::Object(obj)
}

fn worker_err(err: WorkerCallError) -> Response {
    warn!(err = %err.message(), "gerente facade");
    json_status(worker_infra_status(&err), worker_unavailable_body(&err))
}

async fn maybe_reissue_cookies(
    state: &AppState,
    headers: &HeaderMap,
    worker_body: &Value,
    mut res: Response,
) -> Response {
    let Some(uid) = worker_body
        .get("reissueUserId")
        .and_then(|v| v.as_i64())
        .filter(|i| *i > 0)
        .or_else(|| {
            worker_body
                .get("ownerUserId")
                .and_then(|v| v.as_i64())
                .filter(|i| *i > 0)
        })
        .or_else(|| {
            worker_body
                .get("managerUserId")
                .and_then(|v| v.as_i64())
                .filter(|i| *i > 0)
        })
        .or_else(|| {
            worker_body
                .get("leftManagerUserId")
                .and_then(|v| v.as_i64())
                .filter(|i| *i > 0)
        })
    else {
        return res;
    };
    match issue_jwt_auth_cookies(state, headers, uid).await {
        Ok((access, access_ttl, refresh, refresh_ttl)) => {
            append_cookie(
                &mut res,
                state.cfg.cookie.access_cookie(&access, access_ttl),
            );
            append_cookie(
                &mut res,
                state.cfg.cookie.refresh_cookie(&refresh, refresh_ttl),
            );
            res
        }
        Err(e) => {
            warn!(user_id = uid, "gerente jwt reissue failed");
            e
        }
    }
}

async fn forward_simple(state: &AppState, path: &str, body: Value) -> Response {
    forward_mining(state, path, body).await
}

async fn forward_with_reissue(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    body: Value,
) -> Response {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) => {
            let mut res = worker_to_response(r.clone());
            if r.status == HTTP_OK && r.body["ok"] == true {
                res = maybe_reissue_cookies(state, headers, &r.body, res).await;
            }
            res
        }
        Err(e) => worker_err(e),
    }
}

async fn am_me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(
        &state,
        GERENTE_ME_PATH,
        with_manager_fields(json!({}), &ctx),
    )
    .await
}

async fn am_hire(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(&state, GERENTE_HIRE_PATH, with_manager_fields(body, &ctx)).await
}

async fn am_apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(&state, GERENTE_APPLY_PATH, with_manager_fields(body, &ctx)).await
}

async fn am_accept(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(&state, GERENTE_ACCEPT_PATH, with_manager_fields(body, &ctx)).await
}

async fn am_decline(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(
        &state,
        GERENTE_DECLINE_PATH,
        with_manager_fields(body, &ctx),
    )
    .await
}

async fn am_fire(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_simple(&state, GERENTE_FIRE_PATH, with_manager_fields(body, &ctx)).await
}

async fn am_resign(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let body = with_manager_fields(body, &ctx);
    match post_mining(&state.cfg, &state.http, GERENTE_RESIGN_PATH, &body).await {
        Ok(r) => {
            let mut res = worker_to_response(r.clone());
            if r.status == HTTP_OK && r.body["ok"] == true {
                let hint = if r.body.get("reissueUserId").is_some()
                    || r.body.get("leftManagerUserId").is_some()
                {
                    r.body.clone()
                } else if ctx.manager_mode {
                    json!({ "reissueUserId": ctx.manager_user_id })
                } else {
                    r.body.clone()
                };
                res = maybe_reissue_cookies(&state, &headers, &hint, res).await;
            }
            res
        }
        Err(e) => worker_err(e),
    }
}

async fn am_enter(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_with_reissue(
        &state,
        &headers,
        GERENTE_ENTER_PATH,
        with_manager_fields(body, &ctx),
    )
    .await
}

async fn am_leave(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let ctx = match load_manager_ctx(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    forward_with_reissue(
        &state,
        &headers,
        GERENTE_LEAVE_PATH,
        with_manager_fields(json!({}), &ctx),
    )
    .await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/account-manager/me", get(am_me))
        .route("/api/account-manager/hire", post(am_hire))
        .route("/api/account-manager/apply", post(am_apply))
        .route("/api/account-manager/accept", post(am_accept))
        .route("/api/account-manager/decline", post(am_decline))
        .route("/api/account-manager/fire", post(am_fire))
        .route("/api/account-manager/resign", post(am_resign))
        .route("/api/account-manager/enter", post(am_enter))
        .route("/api/account-manager/leave", post(am_leave))
}
