//! Public axum surface — game HTTP (auth + player facades) + admin Express proxy.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use genesis_core::auth::constants::{EMAIL_ADDRESS_MAX_LENGTH, SESSION_TTL_SECONDS};
use genesis_core::{validate_login_email, validate_login_fields_present, validate_login_password};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;
use tower_http::trace::TraceLayer;
use tracing::warn;

use crate::client_ip::get_client_ip;
use crate::config::{AppState, COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_SID, TICKET_ID_MAX_LENGTH};
use crate::download::{
    content_type_for_ext, download_basename, is_support_reply_stored_name,
    support_stored_file_owned_by_user,
};
use crate::facade::not_implemented;
use crate::img::serve_img;
use crate::owned::should_proxy_express;
use crate::proxy::proxy_to_express;
use crate::session::{auth_infra_response, cookies_from_req, json_status, resolve_user_id};
use crate::spa::{is_spa_candidate, serve_spa};
use crate::workers::{ping_url, post_auth, post_mining, worker_infra_status};

const TURNSTILE_VERIFY_PATH: &str = "/v1/auth/turnstile/verify";
const JWT_VERIFY_PATH: &str = "/v1/auth/jwt/verify";
const JWT_SIGN_PATH: &str = "/v1/auth/jwt/sign";
const SESSION_HYDRATE_PATH: &str = "/v1/auth/session/hydrate";
const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
const SESSION_DELETE_PATH: &str = "/v1/auth/session/delete";
const LOGIN_COMPLETE_PATH: &str = "/v1/auth/login/complete";
const AUTH_REGISTER_PATH: &str = "/v1/auth/register";
const AUTH_PASSWORD_RESET_REQUEST_PATH: &str = "/v1/auth/password-reset/request";
const AUTH_PASSWORD_RESET_COMPLETE_PATH: &str = "/v1/auth/password-reset/complete";
const AUTH_EMAIL_VERIFY_REQUEST_PATH: &str = "/v1/auth/email-verify/request";
const AUTH_EMAIL_VERIFY_COMPLETE_PATH: &str = "/v1/auth/email-verify/complete";
const REFRESH_ROTATE_PATH: &str = "/v1/auth/refresh/rotate";
const REFRESH_REVOKE_PATH: &str = "/v1/auth/refresh/revoke";
const SUPPORT_TICKET_FOR_PLAYER_PATH: &str = "/v1/support/ticket-for-player";
const SUPPORT_ATTACHMENT_REFERENCED_PATH: &str = "/v1/support/attachment-referenced";
const USERS_ASSERT_ACTIVE_PATH: &str = "/v1/users/assert-active";

const ERR_CAPTCHA_REQUIRED: &str = "Complete the captcha before continuing.";

fn router_arc(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_live))
        .route("/health/live", get(health_live))
        .route("/health/ready", get(health_ready))
        .route("/api/security/turnstile-config", get(turnstile_config))
        .route("/api/login", post(post_login))
        .route("/api/register", post(post_register))
        .route(
            "/api/request-password-reset",
            post(post_request_password_reset),
        )
        .route(
            "/api/reset-password-secure",
            post(post_reset_password_secure),
        )
        .route(
            "/api/request-email-verification",
            post(post_request_email_verification),
        )
        .route("/api/verify-email", post(post_verify_email))
        .route("/api/session", get(get_session))
        .route("/api/site-status", get(site_status))
        .route("/api/auth/refresh", post(post_refresh))
        .route("/api/logout", post(post_logout))
        .route(
            "/api/support/attachments/download",
            get(get_attachment_download),
        )
        .merge(crate::player::router())
        .merge(crate::admin_tabs::router())
        .merge(crate::admin_catalog::router())
        .merge(crate::admin_wallet_tabs::router())
        .merge(crate::admin_users::router())
        .merge(crate::admin_lucky_boxes::router())
        .merge(crate::admin_announcements::router())
        .merge(crate::admin_backup::router())
        .merge(crate::admin_dashboard::router())
        .merge(crate::admin_economy::router())
        .merge(crate::admin_market::router())
        .merge(crate::admin_mining_dist::router())
        .merge(crate::admin_partners::router())
        .merge(crate::admin_quests::router())
        .merge(crate::admin_support::router())
        .merge(crate::admin_ranking::router())
        .merge(crate::admin_referral::router())
        .merge(crate::admin_wallet_ops::router())
        .merge(crate::admin_wheel::router())
        .merge(crate::admin_transparency::router())
        .merge(crate::admin_treasury::router())
        .merge(crate::partner_games::router())
        .merge(crate::dashboard::router())
        .merge(crate::partners::router())
        .merge(crate::gerente::router())
        .fallback(fallback)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub fn router(state: AppState) -> Router {
    router_arc(Arc::new(state))
}

async fn fallback(State(state): State<Arc<AppState>>, req: axum::http::Request<Body>) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if should_proxy_express(&method, &path) {
        return match proxy_to_express(State(state), req).await {
            Ok(r) => r,
            Err(s) => s.into_response(),
        };
    }
    if path == "/img" || path.starts_with("/img/") {
        return serve_img(State(state), req).await;
    }
    if is_spa_candidate(&method, &path) {
        return serve_spa(State(state), req).await;
    }
    not_implemented("No genesis-api handler and not an admin Express route.")
}

/// Public site kill-switch probe (`client/src/shared/api/site-maintenance.ts`).
/// No admin writer exists yet, so this always reports "not in maintenance" —
/// it just needs to answer 200 JSON instead of falling through to 501.
async fn site_status() -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({ "maintenance": false })))
}

async fn health_live() -> (StatusCode, Json<Value>) {
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "status": "live" })),
    )
}

async fn health_ready(State(state): State<Arc<AppState>>) -> (StatusCode, Json<Value>) {
    let Some(express) = state.cfg.express_url.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "status": "not_ready", "reason": "express_unset" })),
        );
    };
    let Some(auth) = state.cfg.auth_url.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "status": "not_ready", "reason": "auth_unset" })),
        );
    };
    let express_ok = ping_url(&state.http, &format!("{express}/health/ready")).await;
    if !express_ok {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "status": "not_ready", "reason": "express" })),
        );
    }
    let auth_ok = ping_url(&state.http, &format!("{auth}/health")).await;
    if !auth_ok {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "status": "not_ready", "reason": "auth" })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "status": "ready" })),
    )
}

async fn turnstile_config(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "enabled": state.cfg.turnstile_enabled,
        "siteKey": state.cfg.turnstile_site_key,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    turnstile_token: Option<String>,
}

fn append_cookie(res: &mut Response, value: String) {
    if let Ok(hv) = header::HeaderValue::from_str(&value) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
}

async fn post_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let email = body.email.as_deref().unwrap_or("");
    let password = body.password.as_deref().unwrap_or("");
    let present = validate_login_fields_present(Some(email), Some(password));
    if !present.is_ok() {
        return json_status(
            400,
            json!({ "error": present.error.unwrap_or_else(|| "Enter your email and password.".into()) }),
        );
    }
    let email_check = validate_login_email(Some(email));
    if !email_check.is_ok() {
        return json_status(
            400,
            json!({ "error": email_check.error.unwrap_or_else(|| "Invalid email.".into()) }),
        );
    }
    let password_check = validate_login_password(Some(password));
    if !password_check.is_ok() {
        return json_status(
            400,
            json!({ "error": password_check.error.unwrap_or_else(|| "Enter your password.".into()) }),
        );
    }

    let token = body.turnstile_token.as_deref().unwrap_or("").trim();
    if state.cfg.turnstile_enabled && token.is_empty() {
        return json_status(
            400,
            json!({ "error": ERR_CAPTCHA_REQUIRED, "code": "TURNSTILE_FAILED" }),
        );
    }
    let ip = get_client_ip(&state.cfg, &headers, None);
    let remoteip = if ip != "unknown" {
        Some(ip.as_str())
    } else {
        None
    };
    match post_auth(
        &state.cfg,
        &state.http,
        TURNSTILE_VERIFY_PATH,
        &json!({ "token": token, "remoteip": remoteip }),
    )
    .await
    {
        Ok(r) if r.status == 200 && r.body["ok"] == true => {}
        Ok(r) => {
            return json_status(
                r.status,
                json!({
                    "error": r.body["error"].as_str().unwrap_or("captcha failed"),
                    "code": "TURNSTILE_FAILED"
                }),
            );
        }
        Err(e) => return auth_infra_response(&e),
    }

    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    match post_auth(
        &state.cfg,
        &state.http,
        LOGIN_COMPLETE_PATH,
        &json!({
            "email": email,
            "password": password,
            "ip": ip,
            "userAgent": ua,
        }),
    )
    .await
    {
        Ok(r) if r.status == 200 && r.body["ok"] == true => {
            let profile = r.body.get("profile").cloned().unwrap_or(Value::Null);
            let sid = r.body["sessionId"].as_str().unwrap_or("");
            let token = r.body["token"].as_str().unwrap_or("");
            let access_ttl = r.body["expiresInSec"].as_u64().unwrap_or(0);
            let refresh = r.body["refreshToken"].as_str().unwrap_or("");
            let refresh_ttl = r.body["refreshExpiresInSec"]
                .as_u64()
                .or_else(|| r.body["expiresInSec"].as_u64())
                .unwrap_or(0);
            if sid.is_empty() || token.is_empty() || refresh.is_empty() || access_ttl == 0 {
                return json_status(
                    500,
                    json!({ "error": "Could not establish session. Try again." }),
                );
            }
            let mut res = Json(profile).into_response();
            append_cookie(
                &mut res,
                state.cfg.cookie.sid_cookie(sid, SESSION_TTL_SECONDS),
            );
            append_cookie(&mut res, state.cfg.cookie.access_cookie(token, access_ttl));
            append_cookie(
                &mut res,
                state.cfg.cookie.refresh_cookie(refresh, refresh_ttl),
            );
            res
        }
        Ok(r) => {
            let mut body = r.body.clone();
            if body.get("error").is_none() {
                body["error"] = json!("Could not sign in.");
            }
            json_status(r.status, body)
        }
        Err(e) => auth_infra_response(&e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    polygon_wallet: Option<String>,
    #[serde(default)]
    referred_by: Option<String>,
    #[serde(default)]
    turnstile_token: Option<String>,
    #[serde(default)]
    device_fingerprint: Option<Value>,
}

/// Node `EMAIL_PATTERN` on reset / verify request controllers.
fn node_public_email_ok(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > EMAIL_ADDRESS_MAX_LENGTH {
        return false;
    }
    if raw.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = raw.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.is_empty() || local.contains('@') || domain.contains('@') {
        return false;
    }
    let Some(dot) = domain.find('.') else {
        return false;
    };
    if dot == 0 {
        return false;
    }
    let after = &domain[dot + 1..];
    !after.is_empty() && !after.chars().any(|c| c.is_whitespace() || c == '@')
}

fn auth_status_body(r: crate::workers::WorkerJson) -> Response {
    json_status(r.status, r.body)
}

async fn post_register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> Response {
    let token = body.turnstile_token.as_deref().unwrap_or("").trim();
    if state.cfg.turnstile_enabled && token.is_empty() {
        return json_status(
            400,
            json!({ "error": ERR_CAPTCHA_REQUIRED, "code": "TURNSTILE_FAILED" }),
        );
    }
    let ip = get_client_ip(&state.cfg, &headers, None);
    let remoteip = if ip != "unknown" {
        Some(ip.as_str())
    } else {
        None
    };
    match post_auth(
        &state.cfg,
        &state.http,
        TURNSTILE_VERIFY_PATH,
        &json!({ "token": token, "remoteip": remoteip }),
    )
    .await
    {
        Ok(r) if r.status == 200 && r.body["ok"] == true => {}
        Ok(r) => {
            return json_status(
                r.status,
                json!({
                    "error": r.body["error"].as_str().unwrap_or("captcha failed"),
                    "code": "TURNSTILE_FAILED"
                }),
            );
        }
        Err(e) => return auth_infra_response(&e),
    }

    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    match post_auth(
        &state.cfg,
        &state.http,
        AUTH_REGISTER_PATH,
        &json!({
            "email": body.email,
            "username": body.username,
            "password": body.password,
            "polygonWallet": body.polygon_wallet,
            "referredBy": body.referred_by,
            "deviceFingerprint": body.device_fingerprint,
            "ip": ip,
            "userAgent": ua,
        }),
    )
    .await
    {
        Ok(r) => auth_status_body(r),
        Err(e) => auth_infra_response(&e),
    }
}

#[derive(Deserialize)]
struct EmailOnlyBody {
    #[serde(default)]
    email: Option<String>,
}

async fn post_request_password_reset(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EmailOnlyBody>,
) -> Response {
    let raw = body.email.as_deref().unwrap_or("").trim();
    if !node_public_email_ok(raw) {
        return json_status(400, json!({ "error": "Enter a valid email." }));
    }
    match post_auth(
        &state.cfg,
        &state.http,
        AUTH_PASSWORD_RESET_REQUEST_PATH,
        &json!({ "email": raw }),
    )
    .await
    {
        Ok(r) => auth_status_body(r),
        Err(e) => auth_infra_response(&e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetPasswordBody {
    #[serde(default)]
    reset_token: Option<String>,
    #[serde(default)]
    new_password: Option<String>,
}

async fn post_reset_password_secure(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ResetPasswordBody>,
) -> Response {
    match post_auth(
        &state.cfg,
        &state.http,
        AUTH_PASSWORD_RESET_COMPLETE_PATH,
        &json!({
            "resetToken": body.reset_token,
            "newPassword": body.new_password,
        }),
    )
    .await
    {
        Ok(r) => auth_status_body(r),
        Err(e) => auth_infra_response(&e),
    }
}

async fn post_request_email_verification(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EmailOnlyBody>,
) -> Response {
    let raw = body
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !node_public_email_ok(&raw) {
        return json_status(400, json!({ "error": "Enter a valid email." }));
    }
    match post_auth(
        &state.cfg,
        &state.http,
        AUTH_EMAIL_VERIFY_REQUEST_PATH,
        &json!({ "email": raw }),
    )
    .await
    {
        Ok(r) => auth_status_body(r),
        Err(e) => auth_infra_response(&e),
    }
}

#[derive(Deserialize)]
struct VerifyEmailBody {
    #[serde(default)]
    token: Option<String>,
}

async fn post_verify_email(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VerifyEmailBody>,
) -> Response {
    match post_auth(
        &state.cfg,
        &state.http,
        AUTH_EMAIL_VERIFY_COMPLETE_PATH,
        &json!({ "token": body.token }),
    )
    .await
    {
        Ok(r) => auth_status_body(r),
        Err(e) => auth_infra_response(&e),
    }
}

async fn get_session(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let cookies = cookies_from_req(&headers);
    let resolved = match resolve_user_id(&state, &cookies).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some((user_id, sid)) = resolved else {
        return json_status(
            401,
            json!({ "error": "No session", "code": "AUTH_REQUIRED" }),
        );
    };
    let mut payload = json!({ "userId": user_id });
    if let Some(sid) = sid {
        payload["sessionId"] = json!(sid);
    }
    match post_auth(&state.cfg, &state.http, SESSION_HYDRATE_PATH, &payload).await {
        Ok(r) if r.status == 200 && r.body["ok"] == true => {
            let profile = r.body.get("profile").cloned().unwrap_or(Value::Null);
            Json(profile).into_response()
        }
        Ok(r) if r.status == 401 => {
            let mut res = json_status(
                401,
                json!({
                    "error": r.body["error"].as_str().unwrap_or("Invalid session or account no longer exists. Please sign in again."),
                    "code": r.body["code"].as_str().unwrap_or("USER_NOT_FOUND")
                }),
            );
            append_cookie(&mut res, state.cfg.cookie.clear_access());
            append_cookie(&mut res, state.cfg.cookie.clear_refresh());
            res
        }
        Ok(r) => json_status(
            r.status,
            json!({ "error": r.body["error"].as_str().unwrap_or("Could not load session.") }),
        ),
        Err(e) => auth_infra_response(&e),
    }
}

async fn post_refresh(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let cookies = cookies_from_req(&headers);
    let Some(raw) = cookies
        .get(COOKIE_REFRESH)
        .cloned()
        .filter(|s| !s.is_empty())
    else {
        let mut res = json_status(
            401,
            json!({ "error": "Refresh token missing.", "code": "AUTH_REFRESH_MISSING" }),
        );
        append_cookie(&mut res, state.cfg.cookie.clear_access());
        append_cookie(&mut res, state.cfg.cookie.clear_refresh());
        return res;
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    match post_auth(
        &state.cfg,
        &state.http,
        REFRESH_ROTATE_PATH,
        &json!({ "refreshToken": raw, "userAgent": ua, "ip": ip }),
    )
    .await
    {
        Ok(r) if r.status == 200 && r.body["ok"] == true => {
            let uid = r.body["userId"].as_i64().unwrap_or(0);
            let refresh = r.body["refreshToken"].as_str().unwrap_or("");
            let refresh_ttl = r.body["expiresInSec"].as_u64().unwrap_or(0);
            if uid <= 0 || refresh.is_empty() || refresh_ttl == 0 {
                return fail_refresh(&state, 401, "Invalid or revoked refresh token.");
            }
            let signed = match post_auth(
                &state.cfg,
                &state.http,
                JWT_SIGN_PATH,
                &json!({ "userId": uid }),
            )
            .await
            {
                Ok(s) if s.status == 200 && s.body["ok"] == true => s,
                Ok(_) => return fail_refresh(&state, 500, "Could not renew session."),
                Err(e) => {
                    let mut res = auth_infra_response(&e);
                    append_cookie(&mut res, state.cfg.cookie.clear_access());
                    append_cookie(&mut res, state.cfg.cookie.clear_refresh());
                    return res;
                }
            };
            let access = signed.body["token"].as_str().unwrap_or("");
            let access_ttl = signed.body["expiresInSec"].as_u64().unwrap_or(0);
            if access.is_empty() || access_ttl == 0 {
                return fail_refresh(&state, 500, "Could not renew session.");
            }
            let mut res = Json(json!({ "ok": true })).into_response();
            append_cookie(&mut res, state.cfg.cookie.access_cookie(access, access_ttl));
            append_cookie(
                &mut res,
                state.cfg.cookie.refresh_cookie(refresh, refresh_ttl),
            );
            res
        }
        Ok(r) => {
            let expired = r.body["code"] == "expired";
            fail_refresh(
                &state,
                401,
                if expired {
                    "Session expired. Please sign in again."
                } else {
                    "Invalid or revoked refresh token."
                },
            )
        }
        Err(e) => {
            let mut res = auth_infra_response(&e);
            append_cookie(&mut res, state.cfg.cookie.clear_access());
            append_cookie(&mut res, state.cfg.cookie.clear_refresh());
            res
        }
    }
}

fn fail_refresh(state: &AppState, status: u16, error: &str) -> Response {
    let mut res = json_status(
        status,
        json!({ "error": error, "code": if status == 401 { "AUTH_REFRESH_INVALID" } else { "AUTH_REFRESH_ERROR" } }),
    );
    append_cookie(&mut res, state.cfg.cookie.clear_access());
    append_cookie(&mut res, state.cfg.cookie.clear_refresh());
    res
}

async fn post_logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let cookies = cookies_from_req(&headers);
    let sid = cookies.get(COOKIE_SID).cloned().filter(|s| !s.is_empty());
    let mut uid: Option<i64> = None;
    if let Some(access) = cookies.get(COOKIE_ACCESS).filter(|s| !s.is_empty()) {
        if let Ok(r) = post_auth(
            &state.cfg,
            &state.http,
            JWT_VERIFY_PATH,
            &json!({ "token": access }),
        )
        .await
        {
            uid = r.body["userId"].as_i64().filter(|i| *i > 0);
        }
    }
    if uid.is_none() {
        if let Some(sid) = sid.as_deref() {
            if let Ok(r) = post_auth(
                &state.cfg,
                &state.http,
                SESSION_LOAD_PATH,
                &json!({ "sessionId": sid, "includeExpired": true }),
            )
            .await
            {
                uid = r.body["userId"].as_i64().filter(|i| *i > 0);
            }
        }
    }
    if let Some(uid) = uid {
        let _ = post_auth(
            &state.cfg,
            &state.http,
            REFRESH_REVOKE_PATH,
            &json!({ "userId": uid }),
        )
        .await;
    }
    if let Some(sid) = sid {
        let _ = post_auth(
            &state.cfg,
            &state.http,
            SESSION_DELETE_PATH,
            &json!({ "sessionId": sid }),
        )
        .await;
    }
    let mut res = Json(json!({ "ok": true })).into_response();
    append_cookie(&mut res, state.cfg.cookie.clear_access());
    append_cookie(&mut res, state.cfg.cookie.clear_refresh());
    append_cookie(&mut res, state.cfg.cookie.clear_sid());
    res
}

#[derive(Deserialize)]
struct DownloadQuery {
    #[serde(default)]
    file: String,
    #[serde(default)]
    ticket: String,
}

async fn get_attachment_download(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> Response {
    let cookies = cookies_from_req(&headers);
    let resolved = match resolve_user_id(&state, &cookies).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some((uid, _)) = resolved else {
        return json_status(
            401,
            json!({ "error": "Not authenticated", "code": "AUTH_REQUIRED" }),
        );
    };
    match post_mining(
        &state.cfg,
        &state.http,
        USERS_ASSERT_ACTIVE_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => {}
        Ok(r) => {
            return json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({
                    "error": r.body["error"].as_str().unwrap_or("Account check failed."),
                    "code": r.body["code"].as_str().unwrap_or("FORBIDDEN")
                }),
            );
        }
        Err(e) => {
            warn!(err = %e.message(), "assert-active");
            return json_status(
                worker_infra_status(&e),
                json!({
                    "error": "Account check failed.",
                    "code": "FORBIDDEN"
                }),
            );
        }
    }

    let Some(file) = download_basename(&q.file) else {
        return json_status(
            400,
            json!({ "error": "Invalid file.", "code": "INVALID_FILE" }),
        );
    };
    let ticket_id: String = q.ticket.trim().chars().take(TICKET_ID_MAX_LENGTH).collect();

    let mut allowed = false;
    if support_stored_file_owned_by_user(&file, uid) {
        allowed = true;
    } else if is_support_reply_stored_name(&file) {
        if ticket_id.is_empty() {
            return json_status(
                400,
                json!({ "error": "Missing ticket parameter.", "code": "TICKET_REQUIRED" }),
            );
        }
        let ticket = match post_mining(
            &state.cfg,
            &state.http,
            SUPPORT_TICKET_FOR_PLAYER_PATH,
            &json!({ "ticketId": ticket_id }),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(err = ?e, "ticket-for-player");
                return json_status(502, json!({ "error": "Not found.", "code": "NOT_FOUND" }));
            }
        };
        let owner = ticket.body["ticket"]["userId"]
            .as_i64()
            .or_else(|| ticket.body["ticket"]["user_id"].as_i64());
        if ticket.body["ok"] != true || owner != Some(uid) {
            return json_status(404, json!({ "error": "Not found.", "code": "NOT_FOUND" }));
        }
        match post_mining(
            &state.cfg,
            &state.http,
            SUPPORT_ATTACHMENT_REFERENCED_PATH,
            &json!({ "ticketId": ticket_id, "storedName": file }),
        )
        .await
        {
            Ok(r) if r.body["ok"] == true && r.body["referenced"] == true => allowed = true,
            Ok(_) => {}
            Err(e) => {
                warn!(err = ?e, "attachment-referenced");
                return json_status(502, json!({ "error": "Not found.", "code": "NOT_FOUND" }));
            }
        }
    }

    if !allowed {
        return json_status(404, json!({ "error": "Not found.", "code": "NOT_FOUND" }));
    }

    let root = PathBuf::from(&state.cfg.support_upload_dir);
    let resolved_path = root.join(&file);
    let Ok(canon_root) = tokio::fs::canonicalize(&root).await else {
        return json_status(
            404,
            json!({ "error": "File not found.", "code": "NOT_FOUND" }),
        );
    };
    let Ok(canon_file) = tokio::fs::canonicalize(&resolved_path).await else {
        return json_status(
            404,
            json!({ "error": "File not found.", "code": "NOT_FOUND" }),
        );
    };
    if !canon_file.starts_with(&canon_root) {
        return json_status(
            400,
            json!({ "error": "Invalid path.", "code": "INVALID_PATH" }),
        );
    }

    let file_handle = match tokio::fs::File::open(&canon_file).await {
        Ok(f) => f,
        Err(_) => {
            return json_status(
                404,
                json!({ "error": "File not found.", "code": "NOT_FOUND" }),
            )
        }
    };
    let stream = ReaderStream::new(file_handle);
    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = StatusCode::OK;
    if let Ok(ct) = header::HeaderValue::from_str(content_type_for_ext(&file)) {
        res.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    res
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let port = state.cfg.api_port;
    if state.cfg.express_url.is_none() {
        warn!("GENESIS_EXPRESS_URL unset — admin proxy returns 503");
    }
    let state = Arc::new(state);
    let (sio_layer, handle) = crate::realtime::build_socketio(state.clone()).await;
    let _ = state.realtime.set(handle);
    let cors = crate::realtime::cors_layer_for_socket();
    let app = router_arc(state).layer(cors).layer(sio_layer);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "genesis-api listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use crate::config::ApiConfig;
    use crate::cookies::CookieConfig;

    fn test_cfg() -> ApiConfig {
        ApiConfig {
            api_port: crate::config::API_DEFAULT_PORT,
            is_production: false,
            express_url: None,
            auth_url: None,
            mining_worker_url: None,
            hardware_url: None,
            wallet_url: None,
            mining_worker_auth_token: None,
            turnstile_enabled: false,
            turnstile_site_key: String::new(),
            cookie: CookieConfig {
                secure: false,
                domain_attr: None,
            },
            img_uploads_dir: "storage/uploads".into(),
            img_dir: "storage/media-seed".into(),
            support_upload_dir: "storage/uploads".into(),
            backup_dir: "storage/backups".into(),
            client_dist: "client/dist".into(),
            trust_cf_connecting_ip: false,
        }
    }

    fn test_state() -> AppState {
        AppState::new(test_cfg(), reqwest::Client::new())
    }

    #[tokio::test]
    async fn health_is_200() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    async fn spawn_ok_app(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn ready_without_express_is_503() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn ready_without_auth_is_503() {
        let mut cfg = test_cfg();
        cfg.express_url = Some("http://127.0.0.1:1".into());
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["reason"], "auth_unset");
    }

    #[tokio::test]
    async fn ready_auth_ping_fail_is_503() {
        let express = spawn_ok_app(Router::new().route(
            "/health/ready",
            get(|| async { Json(json!({ "ok": true })) }),
        ))
        .await;
        let mut cfg = test_cfg();
        cfg.express_url = Some(express);
        cfg.auth_url = Some("http://127.0.0.1:1".into());
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["reason"], "auth");
    }

    #[tokio::test]
    async fn ready_express_and_auth_ok_is_200() {
        let express = spawn_ok_app(Router::new().route(
            "/health/ready",
            get(|| async { Json(json!({ "ok": true })) }),
        ))
        .await;
        let auth = spawn_ok_app(
            Router::new().route("/health", get(|| async { Json(json!({ "ok": true })) })),
        )
        .await;
        let mut cfg = test_cfg();
        cfg.express_url = Some(express);
        cfg.auth_url = Some(auth);
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn download_assert_active_err_no_file() {
        let auth = spawn_ok_app(Router::new().route(
            JWT_VERIFY_PATH,
            post(|| async { Json(json!({ "ok": true, "userId": 1 })) }),
        ))
        .await;
        let tmp = std::env::temp_dir().join(format!("genesis-api-dl-err-{}", std::process::id()));
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        let file_name = "support-1-1000-500.png";
        tokio::fs::write(tmp.join(file_name), b"PNGSECRET")
            .await
            .unwrap();
        let mut cfg = test_cfg();
        cfg.auth_url = Some(auth);
        cfg.support_upload_dir = tmp.to_string_lossy().into_owned();
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/support/attachments/download?file={file_name}"
                    ))
                    .header("cookie", format!("{COOKIE_ACCESS}=tok"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(!bytes.windows(b"PNGSECRET".len()).any(|w| w == b"PNGSECRET"));
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["code"], "FORBIDDEN");
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn download_assert_active_worker_status_no_file() {
        let auth = spawn_ok_app(Router::new().route(
            JWT_VERIFY_PATH,
            post(|| async { Json(json!({ "ok": true, "userId": 1 })) }),
        ))
        .await;
        let mining = spawn_ok_app(Router::new().route(
            USERS_ASSERT_ACTIVE_PATH,
            post(|| async {
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "ok": false,
                        "error": "Account blocked.",
                        "code": "FORBIDDEN"
                    })),
                )
            }),
        ))
        .await;
        let tmp = std::env::temp_dir().join(format!("genesis-api-dl-403-{}", std::process::id()));
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        let file_name = "support-1-1000-500.png";
        tokio::fs::write(tmp.join(file_name), b"PNGSECRET")
            .await
            .unwrap();
        let mut cfg = test_cfg();
        cfg.auth_url = Some(auth);
        cfg.mining_worker_url = Some(mining);
        cfg.support_upload_dir = tmp.to_string_lossy().into_owned();
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/support/attachments/download?file={file_name}"
                    ))
                    .header("cookie", format!("{COOKIE_ACCESS}=tok"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(!bytes.windows(b"PNGSECRET".len()).any(|w| w == b"PNGSECRET"));
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn download_assert_active_transport_is_502_no_file() {
        let auth = spawn_ok_app(Router::new().route(
            JWT_VERIFY_PATH,
            post(|| async { Json(json!({ "ok": true, "userId": 1 })) }),
        ))
        .await;
        let tmp = std::env::temp_dir().join(format!("genesis-api-dl-502-{}", std::process::id()));
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        let file_name = "support-1-1000-500.png";
        tokio::fs::write(tmp.join(file_name), b"PNGSECRET")
            .await
            .unwrap();
        let mut cfg = test_cfg();
        cfg.auth_url = Some(auth);
        cfg.mining_worker_url = Some("http://127.0.0.1:1".into());
        cfg.support_upload_dir = tmp.to_string_lossy().into_owned();
        let app = router(AppState::new(cfg, reqwest::Client::new()));
        let res = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/support/attachments/download?file={file_name}"
                    ))
                    .header("cookie", format!("{COOKIE_ACCESS}=tok"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(!bytes.windows(b"PNGSECRET".len()).any(|w| w == b"PNGSECRET"));
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn turnstile_config_has_no_secret() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/security/turnstile-config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(json.get("secret").is_none());
        assert!(json.get("siteKey").is_some());
        assert_eq!(json["enabled"], false);
    }

    #[tokio::test]
    async fn img_owned_missing_file_is_404() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/img/foo.png")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn shop_checkout_not_proxied_without_express() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/shop/checkout")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"idempotencyKey":"abcdefgh"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_ne!(res.status().as_u16(), 502);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "EXPRESS_UNAVAILABLE");
    }

    #[tokio::test]
    async fn admin_users_without_express_is_503_proxy() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/admin/users")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["code"], "EXPRESS_UNAVAILABLE");
    }

    #[tokio::test]
    async fn admin_tab_writes_owned_and_gated() {
        for path in [
            "/api/upgrades",
            "/api/economy-settings",
            "/api/exchange-settings",
            "/api/monetization-settings",
        ] {
            let app = router(test_state());
            let res = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"marketTaxPercent":5}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{path}");
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["code"], "AUTH_REQUIRED", "{path}");
        }
    }

    #[tokio::test]
    async fn admin_catalog_and_wallet_tab_writes_owned_and_gated() {
        for (method, path) in [
            ("POST", "/api/access-levels"),
            ("POST", "/api/loot-boxes"),
            ("POST", "/api/news"),
            ("DELETE", "/api/news/abc"),
            ("POST", "/api/news-fee"),
            ("POST", "/api/news-expire-days"),
            ("POST", "/api/mining-coins"),
            ("POST", "/api/season-passes"),
            ("POST", "/api/rig-rooms"),
            ("POST", "/api/web3-settings"),
            ("POST", "/api/wallet-labels"),
            ("GET", "/api/wallet-labels"),
        ] {
            let app = router(test_state());
            let res = app
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from("[]"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{method} {path}");
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["code"], "AUTH_REQUIRED", "{method} {path}");
        }
    }

    #[tokio::test]
    async fn admin_catalog_get_twins_still_reachable() {
        // The write facades share their path with a player GET; merging the
        // routers must keep the GET on `crate::player`.
        for path in [
            "/api/news",
            "/api/news-fee",
            "/api/news-expire-days",
            "/api/access-levels",
            "/api/loot-boxes",
            "/api/mining-coins",
            "/api/season-passes",
            "/api/rig-rooms",
            "/api/web3-settings",
        ] {
            let app = router(test_state());
            let res = app
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_ne!(res.status(), StatusCode::METHOD_NOT_ALLOWED, "{path}");
            assert_ne!(res.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
    }

    #[tokio::test]
    async fn admin_tab_write_get_twin_still_reachable() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/economy-settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["code"], "MINING_WORKER_UNAVAILABLE");
    }

    #[tokio::test]
    async fn news_get_owned_not_express() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/news")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "EXPRESS_UNAVAILABLE");
        assert_ne!(json["code"], "NOT_IMPLEMENTED");
    }

    #[tokio::test]
    async fn game_state_me_owned_not_express() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/game-state/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "EXPRESS_UNAVAILABLE");
    }

    /// A leitura admin por email é do genesis-api (`admin_users`), já não passa
    /// pelo Express: sem cookie de sessão para o `isAdmin`, para em 401.
    #[tokio::test]
    async fn game_state_email_owned_and_gated() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/game-state/foo@bar")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "EXPRESS_UNAVAILABLE");
    }

    #[tokio::test]
    async fn liquidate_without_min_usdc_is_not_501() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/wallet/exchange/liquidate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"mode":"PERCENTAGE","percentage":100,"coinId":"btc"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res.status().as_u16(), 501);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "NOT_IMPLEMENTED");
    }

    #[tokio::test]
    async fn quests_claim_and_deposit_verify_not_501() {
        for (path, body) in [
            ("/api/quests/claim", r#"{"questId":"daily_checkin"}"#),
            (
                "/api/deposit/verify",
                r#"{"txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            ),
        ] {
            let app = router(test_state());
            let res = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_ne!(res.status().as_u16(), 501, "{path}");
        }
    }

    #[tokio::test]
    async fn login_empty_fields_400_owned() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"email":"","password":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn register_not_proxied_without_express() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/register")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"email":"user@gmail.com","username":"abc","password":"Aa1!aaaa"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(json["code"], "EXPRESS_UNAVAILABLE");
        assert_eq!(json["code"], "AUTH_WORKER_UNAVAILABLE");
    }

    #[tokio::test]
    async fn password_reset_request_invalid_email_400_owned() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/request-password-reset")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"email":"not-an-email"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "Enter a valid email.");
    }
}
