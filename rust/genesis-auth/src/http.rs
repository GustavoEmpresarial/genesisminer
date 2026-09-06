//! Axum HTTP surface for Node → Rust auth (bcrypt + JWT + Turnstile + SMTP + PG session/refresh).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use deadpool_postgres::Pool;
use genesis_core::auth::access_jwt::{sign_access_token, verify_access_token, AccessJwtError};
use genesis_core::auth::password::{hash_password, verify_password, PasswordCryptoError};
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::config::{WorkerConfig, MINING_WORKER_AUTH_HEADER};
use crate::errors::AuthPgError;
use crate::mail::{self, DEFAULT_RESET_LINK_VALIDITY_MINUTES, DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS};
use crate::refresh::{
    run_refresh_issue, run_refresh_revoke, run_refresh_rotate, REFRESH_ISSUE_PATH, REFRESH_REVOKE_PATH,
    REFRESH_ROTATE_PATH,
};
use crate::hydrate::{
    parse_hydrate_ids, run_session_hydrate, PublicProfile, SESSION_HYDRATE_PATH,
};
use crate::email_verify::{
    run_email_verify_complete, run_email_verify_request, EmailVerifyCompleteBody,
    EmailVerifyCompleteError, EmailVerifyRequestBody, EMAIL_VERIFY_COMPLETE_PATH,
    EMAIL_VERIFY_GENERIC_MESSAGE, EMAIL_VERIFY_REQUEST_PATH,
};
use crate::login::{run_login_complete, LoginCompleteError, LoginCompleteRequest, LOGIN_COMPLETE_PATH};
use crate::password_reset::{
    run_password_reset_complete, run_password_reset_request, PasswordResetCompleteBody,
    PasswordResetCompleteError, PasswordResetRequestBody, PASSWORD_RESET_COMPLETE_PATH,
    PASSWORD_RESET_GENERIC_MESSAGE, PASSWORD_RESET_REQUEST_PATH,
};
use crate::register::{run_register, RegisterError, RegisterRequest, REGISTER_PATH};
use crate::session::{
    run_session_create, run_session_delete, run_session_delete_by_user, run_session_load,
    run_session_restore_from_original, run_session_update_flags, SessionUserBody, SESSION_CREATE_PATH,
    SESSION_DELETE_BY_USER_PATH, SESSION_DELETE_PATH, SESSION_LOAD_PATH, SESSION_UPDATE_FLAGS_PATH,
};
use crate::turnstile::{self, TurnstileVerifyOutcome};

const PASSWORD_HASH_PATH: &str = "/v1/auth/password/hash";
const PASSWORD_VERIFY_PATH: &str = "/v1/auth/password/verify";
const JWT_SIGN_PATH: &str = "/v1/auth/jwt/sign";
const JWT_VERIFY_PATH: &str = "/v1/auth/jwt/verify";
const TURNSTILE_VERIFY_PATH: &str = "/v1/auth/turnstile/verify";
const MAIL_RESET_PATH: &str = "/v1/auth/mail/reset";
const MAIL_VERIFY_PATH: &str = "/v1/auth/mail/verify";

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub cfg: WorkerConfig,
    pub http: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordHashRequest {
    pub password: String,
    pub rounds: u32,
}

impl std::fmt::Debug for PasswordHashRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordHashRequest")
            .field("password", &"<redacted>")
            .field("rounds", &self.rounds)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordVerifyRequest {
    pub password: String,
    pub hash: String,
}

impl std::fmt::Debug for PasswordVerifyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordVerifyRequest")
            .field("password", &"<redacted>")
            .field("hash", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtSignRequest {
    pub user_id: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtVerifyRequest {
    pub token: String,
}

impl std::fmt::Debug for JwtVerifyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JwtVerifyRequest")
            .field("token", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnstileVerifyRequest {
    pub token: String,
    #[serde(default)]
    pub remoteip: Option<String>,
}

impl std::fmt::Debug for TurnstileVerifyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnstileVerifyRequest")
            .field("token", &"<redacted>")
            .field("remoteip", &self.remoteip)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailResetRequest {
    pub email: String,
    pub reset_token: String,
    #[serde(default)]
    pub validity_minutes: Option<u32>,
}

impl std::fmt::Debug for MailResetRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailResetRequest")
            .field("email", &self.email)
            .field("reset_token", &"<redacted>")
            .field("validity_minutes", &self.validity_minutes)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailVerifyRequest {
    pub email: String,
    pub verification_token: String,
    #[serde(default)]
    pub validity_hours: Option<u32>,
}

impl std::fmt::Debug for MailVerifyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailVerifyRequest")
            .field("email", &self.email)
            .field("verification_token", &"<redacted>")
            .field("validity_hours", &self.validity_hours)
            .finish()
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(rename = "match", skip_serializing_if = "Option::is_none")]
    pub is_match: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_sec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_expires_in_sec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_mode: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acting_as_owner_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<SessionUserBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PublicProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verification_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_verified: Option<bool>,
}

impl std::fmt::Debug for OkBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OkBody")
            .field("ok", &self.ok)
            .field("error", &self.error)
            .field("error_name", &self.error_name)
            .field("code", &self.code)
            .field("hash", &self.hash.as_ref().map(|_| "<redacted>"))
            .field("is_match", &self.is_match)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_in_sec", &self.expires_in_sec)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("user_id", &self.user_id)
            .field("jti", &self.jti)
            .field("exp", &self.exp)
            .field("session_id", &self.session_id)
            .field("deleted_count", &self.deleted_count)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateRequest {
    pub user_id: serde_json::Value,
    pub session_id: String,
    pub expires_at_ms: i64,
    /// Accepted for contract parity; `sessions` has no ua/ip columns.
    #[serde(default)]
    #[allow(dead_code)]
    pub user_agent: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub ip: Option<String>,
}

impl std::fmt::Debug for SessionCreateRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCreateRequest")
            .field("user_id", &self.user_id)
            .field("session_id", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .field("user_agent", &self.user_agent)
            .field("ip", &self.ip)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadRequest {
    pub session_id: String,
    #[serde(default)]
    pub include_expired: bool,
}

impl std::fmt::Debug for SessionLoadRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionLoadRequest")
            .field("session_id", &"<redacted>")
            .field("include_expired", &self.include_expired)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteRequest {
    pub session_id: String,
}

impl std::fmt::Debug for SessionDeleteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionDeleteRequest")
            .field("session_id", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteByUserRequest {
    #[serde(default)]
    pub user_id: Option<serde_json::Value>,
    #[serde(default)]
    pub user_ids: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateFlagsRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<serde_json::Value>,
    #[serde(default)]
    pub original_user_id: Option<serde_json::Value>,
    #[serde(default)]
    pub manager_mode: Option<i32>,
    #[serde(default)]
    pub acting_as_owner_id: Option<serde_json::Value>,
    #[serde(default)]
    pub restore_user_id_from_original: bool,
    #[serde(default)]
    pub match_original_user_id: Option<serde_json::Value>,
    #[serde(default)]
    pub match_acting_as_owner_id: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshIssueRequest {
    pub user_id: serde_json::Value,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
}

impl std::fmt::Debug for RefreshIssueRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshIssueRequest")
            .field("user_id", &self.user_id)
            .field("user_agent", &self.user_agent)
            .field("ip", &self.ip)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRotateRequest {
    pub refresh_token: String,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
}

impl std::fmt::Debug for RefreshRotateRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshRotateRequest")
            .field("refresh_token", &"<redacted>")
            .field("user_agent", &self.user_agent)
            .field("ip", &self.ip)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRevokeRequest {
    pub user_id: serde_json::Value,
}

fn router(state: AppState) -> Router {
    let state = Arc::new(state);
    let protected = Router::new()
        .route(PASSWORD_HASH_PATH, post(post_password_hash))
        .route(PASSWORD_VERIFY_PATH, post(post_password_verify))
        .route(JWT_SIGN_PATH, post(post_jwt_sign))
        .route(JWT_VERIFY_PATH, post(post_jwt_verify))
        .route(TURNSTILE_VERIFY_PATH, post(post_turnstile_verify))
        .route(MAIL_RESET_PATH, post(post_mail_reset))
        .route(MAIL_VERIFY_PATH, post(post_mail_verify))
        .route(SESSION_CREATE_PATH, post(post_session_create))
        .route(SESSION_LOAD_PATH, post(post_session_load))
        .route(SESSION_DELETE_PATH, post(post_session_delete))
        .route(SESSION_DELETE_BY_USER_PATH, post(post_session_delete_by_user))
        .route(SESSION_UPDATE_FLAGS_PATH, post(post_session_update_flags))
        .route(REFRESH_ISSUE_PATH, post(post_refresh_issue))
        .route(REFRESH_ROTATE_PATH, post(post_refresh_rotate))
        .route(REFRESH_REVOKE_PATH, post(post_refresh_revoke))
        .route(SESSION_HYDRATE_PATH, post(post_session_hydrate))
        .route(LOGIN_COMPLETE_PATH, post(post_login_complete))
        .route(REGISTER_PATH, post(post_register))
        .route(PASSWORD_RESET_REQUEST_PATH, post(post_password_reset_request))
        .route(PASSWORD_RESET_COMPLETE_PATH, post(post_password_reset_complete))
        .route(EMAIL_VERIFY_REQUEST_PATH, post(post_email_verify_request))
        .route(EMAIL_VERIFY_COMPLETE_PATH, post(post_email_verify_complete))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_worker_auth,
        ));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn require_worker_auth(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    match state.cfg.mining_worker_auth_token.as_deref() {
        Some(expected) => {
            let provided = request
                .headers()
                .get(MINING_WORKER_AUTH_HEADER)
                .and_then(|v| v.to_str().ok());
            if provided != Some(expected) {
                return Err(StatusCode::UNAUTHORIZED);
            }
        }
        None => {}
    }
    Ok(next.run(request).await)
}

async fn post_password_hash(
    Json(body): Json<PasswordHashRequest>,
) -> (StatusCode, Json<OkBody>) {
    // bcrypt is CPU-bound — run off the async runtime.
    let password = body.password;
    let rounds = body.rounds;
    let result = tokio::task::spawn_blocking(move || hash_password(&password, rounds)).await;
    match result {
        Ok(Ok(hash)) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                hash: Some(hash),
                ..Default::default()
            }),
        ),
        Ok(Err(PasswordCryptoError::InvalidRounds)) => (
            StatusCode::BAD_REQUEST,
            Json(OkBody {
                ok: false,
                error: Some("invalid rounds".into()),
                ..Default::default()
            }),
        ),
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(OkBody {
                ok: false,
                error: Some("hash failed".into()),
                ..Default::default()
            }),
        ),
        Err(e) => {
            warn!(err = %e, "password hash join");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(OkBody {
                    ok: false,
                    error: Some("hash join".into()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_password_verify(
    Json(body): Json<PasswordVerifyRequest>,
) -> (StatusCode, Json<OkBody>) {
    let password = body.password;
    let hash = body.hash;
    let result = tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await;
    match result {
        Ok(Ok(is_match)) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                is_match: Some(is_match),
                ..Default::default()
            }),
        ),
        Ok(Err(_)) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                is_match: Some(false),
                ..Default::default()
            }),
        ),
        Err(e) => {
            warn!(err = %e, "password verify join");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(OkBody {
                    ok: false,
                    error: Some("verify join".into()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn user_id_i64_from_json(raw: &serde_json::Value) -> Result<i64, AuthPgError> {
    match raw {
        serde_json::Value::Number(n) => {
            let i = n.as_i64().ok_or_else(|| AuthPgError::bad("invalid userId"))?;
            if i <= 0 {
                return Err(AuthPgError::bad("invalid userId"));
            }
            Ok(i)
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            let i = trimmed
                .parse::<i64>()
                .map_err(|_| AuthPgError::bad("invalid userId"))?;
            if i <= 0 {
                return Err(AuthPgError::bad("invalid userId"));
            }
            Ok(i)
        }
        _ => Err(AuthPgError::bad("invalid userId")),
    }
}

fn pg_fail(e: AuthPgError) -> (StatusCode, Json<OkBody>) {
    if let AuthPgError::Transport(err) = &e {
        warn!(err = %err, "auth pg transport");
    }
    (
        e.status(),
        Json(OkBody {
            ok: false,
            error: Some(e.error_message()),
            code: e.code().map(str::to_string),
            ..Default::default()
        }),
    )
}

fn user_id_from_json(raw: &serde_json::Value) -> Result<String, AccessJwtError> {
    match raw {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i <= 0 {
                    return Err(AccessJwtError::InvalidUserId);
                }
                return Ok(i.to_string());
            }
            Err(AccessJwtError::InvalidUserId)
        }
        serde_json::Value::String(s) => Ok(s.trim().to_string()),
        _ => Err(AccessJwtError::InvalidUserId),
    }
}

async fn post_jwt_sign(
    State(state): State<Arc<AppState>>,
    Json(body): Json<JwtSignRequest>,
) -> (StatusCode, Json<OkBody>) {
    let sub = match user_id_from_json(&body.user_id) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(OkBody {
                    ok: false,
                    error: Some(e.to_string()),
                    error_name: Some(e.error_name().into()),
                    ..Default::default()
                }),
            );
        }
    };
    match sign_access_token(&state.cfg.jwt, &sub) {
        Ok(token) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                token: Some(token),
                expires_in_sec: Some(state.cfg.jwt.access_ttl_sec),
                ..Default::default()
            }),
        ),
        Err(e) => {
            let status = if e == AccessJwtError::InvalidUserId {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (
                status,
                Json(OkBody {
                    ok: false,
                    error: Some(e.to_string()),
                    error_name: Some(e.error_name().into()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_jwt_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<JwtVerifyRequest>,
) -> (StatusCode, Json<OkBody>) {
    match verify_access_token(&state.cfg.jwt, &body.token) {
        Ok(v) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(v.user_id),
                jti: v.jti,
                exp: v.exp,
                ..Default::default()
            }),
        ),
        Err(e) => (
            StatusCode::UNAUTHORIZED,
            Json(OkBody {
                ok: false,
                error: Some(e.to_string()),
                error_name: Some(e.error_name().into()),
                ..Default::default()
            }),
        ),
    }
}

async fn post_turnstile_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TurnstileVerifyRequest>,
) -> (StatusCode, Json<OkBody>) {
    let remoteip = body.remoteip.as_deref();
    match turnstile::verify_turnstile_token(
        &state.cfg.turnstile,
        &state.http,
        &body.token,
        remoteip,
    )
    .await
    {
        TurnstileVerifyOutcome::Ok => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                ..Default::default()
            }),
        ),
        TurnstileVerifyOutcome::BadRequest(msg) => (
            StatusCode::BAD_REQUEST,
            Json(OkBody {
                ok: false,
                error: Some(msg.into()),
                ..Default::default()
            }),
        ),
        TurnstileVerifyOutcome::BadGateway(msg) => (
            StatusCode::BAD_GATEWAY,
            Json(OkBody {
                ok: false,
                error: Some(msg.into()),
                ..Default::default()
            }),
        ),
        TurnstileVerifyOutcome::ServiceUnavailable(msg) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(OkBody {
                ok: false,
                error: Some(msg.into()),
                ..Default::default()
            }),
        ),
    }
}

async fn post_mail_reset(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MailResetRequest>,
) -> (StatusCode, Json<OkBody>) {
    let email = body.email.trim();
    let token = body.reset_token.trim();
    if email.is_empty() || token.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(OkBody {
                ok: false,
                error: Some("email and resetToken required".into()),
                ..Default::default()
            }),
        );
    }
    let minutes = body
        .validity_minutes
        .filter(|m| *m > 0)
        .unwrap_or(DEFAULT_RESET_LINK_VALIDITY_MINUTES);
    match mail::send_reset_email(&state.cfg.mail, email, token, Some(minutes)).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                ..Default::default()
            }),
        ),
        Err(e) => {
            warn!(err = %e, "mail reset send failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(OkBody {
                    ok: false,
                    error: Some("mail send failed".into()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_mail_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MailVerifyRequest>,
) -> (StatusCode, Json<OkBody>) {
    let email = body.email.trim();
    let token = body.verification_token.trim();
    if email.is_empty() || token.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(OkBody {
                ok: false,
                error: Some("email and verificationToken required".into()),
                ..Default::default()
            }),
        );
    }
    let hours = body
        .validity_hours
        .filter(|h| *h > 0)
        .unwrap_or(DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS);
    match mail::send_verification_email(&state.cfg.mail, email, token, Some(hours)).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                ..Default::default()
            }),
        ),
        Err(e) => {
            warn!(err = %e, "mail verify send failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(OkBody {
                    ok: false,
                    error: Some("mail send failed".into()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_session_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionCreateRequest>,
) -> (StatusCode, Json<OkBody>) {
    let user_id = match user_id_i64_from_json(&body.user_id) {
        Ok(id) => id,
        Err(e) => return pg_fail(e),
    };
    match run_session_create(&state.pool, user_id, &body.session_id, body.expires_at_ms).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(user_id),
                session_id: Some(body.session_id),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_session_load(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionLoadRequest>,
) -> (StatusCode, Json<OkBody>) {
    match run_session_load(&state.pool, &body.session_id, body.include_expired).await {
        Ok(loaded) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(loaded.user_id),
                session_id: Some(loaded.session_id),
                created_at_ms: Some(loaded.created_at_ms),
                expires_at_ms: Some(loaded.expires_at_ms),
                original_user_id: loaded.original_user_id,
                last_seen_at_ms: loaded.last_seen_at_ms,
                manager_mode: Some(loaded.manager_mode),
                acting_as_owner_id: loaded.acting_as_owner_id,
                user: Some(loaded.user),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_session_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionDeleteRequest>,
) -> (StatusCode, Json<OkBody>) {
    match run_session_delete(&state.pool, &body.session_id).await {
        Ok(deleted) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: deleted.user_id,
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

fn collect_delete_by_user_ids(body: &SessionDeleteByUserRequest) -> Result<Vec<i64>, AuthPgError> {
    let mut out: Vec<i64> = Vec::new();
    if let Some(v) = body.user_id.as_ref() {
        out.push(user_id_i64_from_json(v)?);
    }
    if let Some(arr) = body.user_ids.as_ref() {
        for v in arr {
            out.push(user_id_i64_from_json(v)?);
        }
    }
    if out.is_empty() {
        return Err(AuthPgError::bad("userId or userIds required"));
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn opt_user_id_from_json(raw: Option<&serde_json::Value>) -> Result<Option<i64>, AuthPgError> {
    match raw {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => user_id_i64_from_json(v).map(Some),
    }
}

async fn post_session_delete_by_user(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionDeleteByUserRequest>,
) -> (StatusCode, Json<OkBody>) {
    let user_ids = match collect_delete_by_user_ids(&body) {
        Ok(ids) => ids,
        Err(e) => return pg_fail(e),
    };
    match run_session_delete_by_user(&state.pool, &user_ids).await {
        Ok(deleted) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                deleted_count: Some(deleted.deleted_count),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_session_update_flags(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionUpdateFlagsRequest>,
) -> (StatusCode, Json<OkBody>) {
    if body.restore_user_id_from_original {
        let acting = match opt_user_id_from_json(body.match_acting_as_owner_id.as_ref()) {
            Ok(Some(id)) => id,
            Ok(None) => return pg_fail(AuthPgError::bad("matchActingAsOwnerId required")),
            Err(e) => return pg_fail(e),
        };
        let original = match opt_user_id_from_json(body.match_original_user_id.as_ref()) {
            Ok(v) => v,
            Err(e) => return pg_fail(e),
        };
        return match run_session_restore_from_original(&state.pool, acting, original).await {
            Ok(()) => (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    ..Default::default()
                }),
            ),
            Err(e) => pg_fail(e),
        };
    }
    let session_id = match body.session_id.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => return pg_fail(AuthPgError::bad("sessionId required")),
    };
    let user_id = match body.user_id.as_ref() {
        Some(v) => match user_id_i64_from_json(v) {
            Ok(id) => id,
            Err(e) => return pg_fail(e),
        },
        None => return pg_fail(AuthPgError::bad("userId required")),
    };
    let manager_mode = match body.manager_mode {
        Some(m) => m,
        None => return pg_fail(AuthPgError::bad("managerMode required")),
    };
    let original_user_id = match opt_user_id_from_json(body.original_user_id.as_ref()) {
        Ok(v) => v,
        Err(e) => return pg_fail(e),
    };
    let acting_as_owner_id = match opt_user_id_from_json(body.acting_as_owner_id.as_ref()) {
        Ok(v) => v,
        Err(e) => return pg_fail(e),
    };
    match run_session_update_flags(
        &state.pool,
        session_id,
        user_id,
        original_user_id,
        manager_mode,
        acting_as_owner_id,
    )
    .await
    {
        Ok(flags) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                session_id: Some(flags.session_id),
                user_id: Some(flags.user_id),
                original_user_id: flags.original_user_id,
                manager_mode: Some(flags.manager_mode),
                acting_as_owner_id: flags.acting_as_owner_id,
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_refresh_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RefreshIssueRequest>,
) -> (StatusCode, Json<OkBody>) {
    let user_id = match user_id_i64_from_json(&body.user_id) {
        Ok(id) => id,
        Err(e) => return pg_fail(e),
    };
    match run_refresh_issue(
        &state.pool,
        &state.cfg,
        user_id,
        body.user_agent.as_deref(),
        body.ip.as_deref(),
    )
    .await
    {
        Ok(issued) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(user_id),
                refresh_token: Some(issued.refresh_token),
                expires_at_ms: Some(issued.expires_at_ms),
                expires_in_sec: Some(issued.expires_in_sec),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_refresh_rotate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RefreshRotateRequest>,
) -> (StatusCode, Json<OkBody>) {
    match run_refresh_rotate(
        &state.pool,
        &state.cfg,
        &body.refresh_token,
        body.user_agent.as_deref(),
        body.ip.as_deref(),
    )
    .await
    {
        Ok(rotated) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(rotated.user_id),
                refresh_token: Some(rotated.refresh_token),
                expires_in_sec: Some(rotated.expires_in_sec),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_session_hydrate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<crate::hydrate::SessionHydrateRequest>,
) -> (StatusCode, Json<OkBody>) {
    let (user_id, session_id) = match parse_hydrate_ids(&body) {
        Ok(v) => v,
        Err(e) => return pg_fail(e),
    };
    match run_session_hydrate(
        &state.pool,
        state.cfg.account_manager_enabled,
        user_id,
        session_id.as_deref(),
    )
    .await
    {
        Ok(profile) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                profile: Some(profile),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

async fn post_login_complete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginCompleteRequest>,
) -> (StatusCode, Json<OkBody>) {
    match run_login_complete(&state.pool, &state.cfg, body).await {
        Ok(done) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                session_id: Some(done.session_id),
                token: Some(done.token),
                expires_in_sec: Some(done.expires_in_sec),
                refresh_token: Some(done.refresh_token),
                refresh_expires_in_sec: Some(done.refresh_expires_in_sec),
                expires_at_ms: None,
                profile: Some(done.profile),
                user_id: None,
                ..Default::default()
            }),
        ),
        Err(e) => {
            if let LoginCompleteError::Transport(err) = &e {
                warn!(err = %err, "login complete transport");
            }
            let email_verification_required = matches!(
                &e,
                LoginCompleteError::Forbidden {
                    code: Some(c),
                    ..
                } if c == "EMAIL_NOT_VERIFIED"
            )
            .then_some(true);
            (
                e.status(),
                Json(OkBody {
                    ok: false,
                    error: Some(e.error_message()),
                    code: e.code().map(str::to_string),
                    retry_after_seconds: e.retry_after_seconds(),
                    email_verification_required,
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterRequest>,
) -> (StatusCode, Json<OkBody>) {
    match run_register(&state.pool, &state.cfg, body).await {
        Ok(_) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                email_verification_required: Some(true),
                ..Default::default()
            }),
        ),
        Err(e) => {
            if let RegisterError::Transport(err) = &e {
                warn!(err = %err, "register transport");
            }
            (
                e.status(),
                Json(OkBody {
                    ok: false,
                    error: Some(e.error_message()),
                    code: e.code().map(str::to_string),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_password_reset_request(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PasswordResetRequestBody>,
) -> (StatusCode, Json<OkBody>) {
    match run_password_reset_request(&state.pool, &state.cfg, body).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                message: Some(PASSWORD_RESET_GENERIC_MESSAGE.into()),
                ..Default::default()
            }),
        ),
        Err(e) => (
            e.status(),
            Json(OkBody {
                ok: false,
                error: Some(e.error_message()),
                ..Default::default()
            }),
        ),
    }
}

async fn post_password_reset_complete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PasswordResetCompleteBody>,
) -> (StatusCode, Json<OkBody>) {
    match run_password_reset_complete(&state.pool, &state.cfg, body).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                ..Default::default()
            }),
        ),
        Err(e) => {
            if let PasswordResetCompleteError::Transport(err) = &e {
                warn!(err = %err, "password reset complete transport");
            }
            (
                e.status(),
                Json(OkBody {
                    ok: false,
                    error: Some(e.error_message()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_email_verify_request(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EmailVerifyRequestBody>,
) -> (StatusCode, Json<OkBody>) {
    match run_email_verify_request(&state.pool, &state.cfg, body).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                message: Some(EMAIL_VERIFY_GENERIC_MESSAGE.into()),
                ..Default::default()
            }),
        ),
        Err(e) => (
            e.status(),
            Json(OkBody {
                ok: false,
                error: Some(e.error_message()),
                ..Default::default()
            }),
        ),
    }
}

async fn post_email_verify_complete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EmailVerifyCompleteBody>,
) -> (StatusCode, Json<OkBody>) {
    match run_email_verify_complete(&state.pool, &state.cfg, &state.http, body).await {
        Ok(done) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                already_verified: if done.already_verified {
                    Some(true)
                } else {
                    None
                },
                message: Some(done.message),
                ..Default::default()
            }),
        ),
        Err(e) => {
            if let EmailVerifyCompleteError::Transport(err) = &e {
                warn!(err = %err, "email verify complete transport");
            }
            (
                e.status(),
                Json(OkBody {
                    ok: false,
                    error: Some(e.error_message()),
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_refresh_revoke(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RefreshRevokeRequest>,
) -> (StatusCode, Json<OkBody>) {
    let user_id = match user_id_i64_from_json(&body.user_id) {
        Ok(id) => id,
        Err(e) => return pg_fail(e),
    };
    match run_refresh_revoke(&state.pool, user_id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(OkBody {
                ok: true,
                user_id: Some(user_id),
                ..Default::default()
            }),
        ),
        Err(e) => pg_fail(e),
    }
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let port = state.cfg.auth_worker_port;
    if state.cfg.mining_worker_auth_token.is_none() {
        warn!(
            event = "auth_disabled",
            "MINING_WORKER_AUTH_TOKEN unset — auth HTTP auth disabled (dev only)"
        );
    } else {
        info!(
            event = "auth_enabled",
            "auth worker HTTP requires {}", MINING_WORKER_AUTH_HEADER
        );
    }
    let app = router(state);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "auth worker HTTP listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use genesis_core::auth::access_jwt::AccessJwtConfig;
    use genesis_core::auth::constants::BCRYPT_ROUNDS_REGISTER;
    use tower::ServiceExt;

    use crate::config::AUTH_WORKER_DEFAULT_PORT;
    use crate::mail::{MailConfig, SmtpTlsMode};
    use crate::refresh::{REFRESH_ISSUE_PATH, REFRESH_ROTATE_PATH, REFRESH_REVOKE_PATH};
    use crate::hydrate::SESSION_HYDRATE_PATH;
    use crate::login::LOGIN_COMPLETE_PATH;
    use crate::session::{
        SESSION_CREATE_PATH, SESSION_DELETE_BY_USER_PATH, SESSION_LOAD_PATH, SESSION_UPDATE_FLAGS_PATH,
    };
    use crate::turnstile::{TurnstileConfig, TURNSTILE_SITEVERIFY_URL};
    use genesis_core::auth::constants::REFRESH_JWT_TTL_DEFAULT_SEC;

    fn test_state() -> AppState {
        let mut pg = deadpool_postgres::Config::new();
        pg.url = Some("postgres://invalid:invalid@127.0.0.1:1/none".into());
        let pool = pg
            .create_pool(Some(deadpool_postgres::Runtime::Tokio1), tokio_postgres::NoTls)
            .expect("pool");
        AppState {
            pool,
            cfg: WorkerConfig {
                database_url: "postgres://invalid".into(),
                auth_worker_port: AUTH_WORKER_DEFAULT_PORT,
                mining_worker_auth_token: None,
                jwt: AccessJwtConfig::with_defaults("a".repeat(32)),
                refresh_ttl_sec: REFRESH_JWT_TTL_DEFAULT_SEC,
                turnstile: TurnstileConfig {
                    enabled_flag: false,
                    secret_key: String::new(),
                    siteverify_url: TURNSTILE_SITEVERIFY_URL.to_string(),
                },
                mail: MailConfig {
                    host: "127.0.0.1".into(),
                    port: 1025,
                    tls_mode: SmtpTlsMode::None,
                    user: None,
                    pass: None,
                    from: "\"Genesis Miner Dev\" <dev@localhost>".into(),
                    public_base_url: "http://localhost:5173".into(),
                },
                account_manager_enabled: false,
                auth_flow_token_secret: "a".repeat(32),
                wallet_url: None,
            },
            http: reqwest::Client::new(),
        }
    }

    #[tokio::test]
    async fn health_is_public() {
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

    #[tokio::test]
    async fn jwt_sign_verify_round_trip() {
        let app = router(test_state());
        let sign_res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(JWT_SIGN_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"userId":42}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sign_res.status(), StatusCode::OK);
        let sign_bytes = axum::body::to_bytes(sign_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let sign_json: serde_json::Value = serde_json::from_slice(&sign_bytes).unwrap();
        assert_eq!(sign_json["ok"], true);
        assert!(sign_json["expiresInSec"].as_u64().unwrap() > 0);
        let token = sign_json["token"].as_str().unwrap().to_string();

        let verify_body = serde_json::json!({ "token": token }).to_string();
        let verify_res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(JWT_VERIFY_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(verify_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(verify_res.status(), StatusCode::OK);
        let verify_bytes = axum::body::to_bytes(verify_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let verify_json: serde_json::Value = serde_json::from_slice(&verify_bytes).unwrap();
        assert_eq!(verify_json["ok"], true);
        assert_eq!(verify_json["userId"], 42);
    }

    #[tokio::test]
    async fn password_hash_verify_round_trip() {
        let app = router(test_state());
        let hash_body = serde_json::json!({
            "password": "senhaForte99",
            "rounds": BCRYPT_ROUNDS_REGISTER
        })
        .to_string();
        let hash_res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(PASSWORD_HASH_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(hash_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(hash_res.status(), StatusCode::OK);
        let hash_bytes = axum::body::to_bytes(hash_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let hash_json: serde_json::Value = serde_json::from_slice(&hash_bytes).unwrap();
        let hash = hash_json["hash"].as_str().unwrap().to_string();

        let verify_body = serde_json::json!({
            "password": "senhaForte99",
            "hash": hash
        })
        .to_string();
        let verify_res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(PASSWORD_VERIFY_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(verify_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(verify_res.status(), StatusCode::OK);
        let verify_bytes = axum::body::to_bytes(verify_res.into_body(), usize::MAX)
            .await
            .unwrap();
        let verify_json: serde_json::Value = serde_json::from_slice(&verify_bytes).unwrap();
        assert_eq!(verify_json["ok"], true);
        assert_eq!(verify_json["match"], true);
    }

    #[tokio::test]
    async fn turnstile_disabled_returns_ok() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(TURNSTILE_VERIFY_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"token":"anything"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["ok"], true);
    }

    #[tokio::test]
    async fn turnstile_enabled_empty_token_400() {
        let mut state = test_state();
        state.cfg.turnstile.enabled_flag = true;
        state.cfg.turnstile.secret_key = "secret".into();
        let app = router(state);
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(TURNSTILE_VERIFY_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"token":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["ok"], false);
        assert!(json["error"].as_str().unwrap().contains("captcha"));
    }

    #[tokio::test]
    async fn turnstile_enabled_without_secret_503() {
        let mut state = test_state();
        state.cfg.turnstile.enabled_flag = true;
        state.cfg.turnstile.secret_key = String::new();
        let app = router(state);
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(TURNSTILE_VERIFY_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"token":"anything"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["ok"], false);
        assert!(json["error"].as_str().unwrap().contains("misconfigured"));
    }

    #[tokio::test]
    async fn mail_reset_missing_fields_400() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(MAIL_RESET_PATH)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"email":"","resetToken":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    async fn json_status(app: axum::Router, path: &str, body: &str) -> (StatusCode, serde_json::Value) {
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, json)
    }

    #[tokio::test]
    async fn session_create_invalid_user_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_CREATE_PATH,
            r#"{"userId":0,"sessionId":"sid","expiresAtMs":1}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn session_load_empty_id_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_LOAD_PATH,
            r#"{"sessionId":"  "}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn session_delete_by_user_missing_ids_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_DELETE_BY_USER_PATH,
            r#"{"userIds":[]}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn session_delete_by_user_invalid_id_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_DELETE_BY_USER_PATH,
            r#"{"userId":0}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn session_update_flags_missing_session_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_UPDATE_FLAGS_PATH,
            r#"{"userId":1,"managerMode":0,"originalUserId":null,"actingAsOwnerId":null}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn session_update_flags_restore_missing_match_400() {
        let (status, json) = json_status(
            router(test_state()),
            SESSION_UPDATE_FLAGS_PATH,
            r#"{"restoreUserIdFromOriginal":true}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn refresh_issue_invalid_user_400() {
        let (status, json) = json_status(
            router(test_state()),
            REFRESH_ISSUE_PATH,
            r#"{"userId":-1}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn refresh_rotate_empty_token_401() {
        let (status, json) = json_status(
            router(test_state()),
            REFRESH_ROTATE_PATH,
            r#"{"refreshToken":""}"#,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["ok"], false);
        assert_eq!(json["code"], "invalid");
    }

    #[tokio::test]
    async fn session_hydrate_missing_ids_400() {
        let (status, json) = json_status(router(test_state()), SESSION_HYDRATE_PATH, r#"{}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn login_complete_empty_fields_400() {
        let (status, json) = json_status(
            router(test_state()),
            LOGIN_COMPLETE_PATH,
            r#"{"email":"","password":""}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn refresh_revoke_invalid_user_400() {
        let (status, json) = json_status(
            router(test_state()),
            REFRESH_REVOKE_PATH,
            r#"{"userId":0}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
    }

    #[tokio::test]
    async fn password_reset_request_invalid_email_400() {
        let (status, json) = json_status(
            router(test_state()),
            PASSWORD_RESET_REQUEST_PATH,
            r#"{"email":"not-an-email"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "Enter a valid email.");
    }

    #[tokio::test]
    async fn password_reset_request_unknown_email_is_generic_ok() {
        let (status, json) = json_status(
            router(test_state()),
            PASSWORD_RESET_REQUEST_PATH,
            r#"{"email":"nobody@gmail.com"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["ok"], true);
        assert_eq!(json["message"], PASSWORD_RESET_GENERIC_MESSAGE);
    }

    #[tokio::test]
    async fn register_missing_email_400() {
        let (status, json) = json_status(router(test_state()), REGISTER_PATH, r#"{}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "Email is required to register.");
    }

    #[tokio::test]
    async fn email_verify_request_invalid_email_400() {
        let (status, json) = json_status(
            router(test_state()),
            EMAIL_VERIFY_REQUEST_PATH,
            r#"{"email":"bad"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "Enter a valid email.");
    }
}
