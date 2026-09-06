//! Password reset request + consume — Node `password-reset.ts`.

use deadpool_postgres::Pool;
use serde::Deserialize;

use crate::config::WorkerConfig;
use crate::db::current_unix_ms;
use crate::errors::AuthPgError;
use crate::pg_types::pg_user_id;
use crate::refresh::run_refresh_revoke;
use crate::session::run_session_delete_by_user;
use genesis_core::auth::constants::{
    EMAIL_ADDRESS_MAX_LENGTH, PASSWORD_RESET_TTL_MS, PASSWORD_RESET_VALIDITY_MINUTES,
};
use genesis_core::auth::password::hash_password_register;
use genesis_core::{
    build_signed_password_reset_token, hash_token_sha256, parse_signed_password_reset_token,
    timing_safe_token_hash_equal, validate_signup_password,
};

pub const PASSWORD_RESET_REQUEST_PATH: &str = "/v1/auth/password-reset/request";
pub const PASSWORD_RESET_COMPLETE_PATH: &str = "/v1/auth/password-reset/complete";

const _: () = assert!(PASSWORD_RESET_VALIDITY_MINUTES == 60);

pub const PASSWORD_RESET_GENERIC_MESSAGE: &str =
    "If an account exists for this email, we sent a link to reset your password.";

const ERR_ENTER_VALID_EMAIL: &str = "Enter a valid email.";
const ERR_INCOMPLETE: &str = "Incomplete data.";
const ERR_ACCOUNT_NOT_FOUND: &str = "Account not found.";
const ERR_LINK_USED: &str = "Recovery link already used or invalid.";
const ERR_SESSION_EXPIRED: &str = "Recovery session expired.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordResetRequestBody {
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordResetCompleteBody {
    #[serde(default)]
    pub reset_token: Option<String>,
    #[serde(default)]
    pub new_password: Option<String>,
}

impl std::fmt::Debug for PasswordResetCompleteBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordResetCompleteBody")
            .field("reset_token", &self.reset_token.as_ref().map(|_| "<redacted>"))
            .field(
                "new_password",
                &self.new_password.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Debug)]
pub enum PasswordResetRequestError {
    BadRequest(String),
}

impl PasswordResetRequestError {
    pub fn status(&self) -> axum::http::StatusCode {
        axum::http::StatusCode::BAD_REQUEST
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest(m) => m.clone(),
        }
    }
}

#[derive(Debug)]
pub enum PasswordResetCompleteError {
    BadRequest(String),
    Forbidden(String),
    Transport(anyhow::Error),
}

impl PasswordResetCompleteError {
    fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::Transport(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest(m) | Self::Forbidden(m) => m.clone(),
            Self::Transport(_) => "Could not reset password.".into(),
        }
    }
}

/// Node `EMAIL_PATTERN` `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
pub(crate) fn node_email_pattern_ok(s: &str) -> bool {
    if s.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.contains('@') {
        return false;
    }
    if domain.is_empty() || domain.contains('@') {
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

pub(crate) fn public_email_ok(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= EMAIL_ADDRESS_MAX_LENGTH && node_email_pattern_ok(raw)
}

fn map_parse_fail(status: u16, error: String) -> PasswordResetCompleteError {
    if status == 403 {
        PasswordResetCompleteError::Forbidden(error)
    } else {
        PasswordResetCompleteError::BadRequest(error)
    }
}

async fn hash_new_password(password: String) -> Result<String, PasswordResetCompleteError> {
    tokio::task::spawn_blocking(move || hash_password_register(&password))
        .await
        .map_err(PasswordResetCompleteError::transport)?
        .map_err(|e| PasswordResetCompleteError::transport(anyhow::anyhow!(e.to_string())))
}

/// Always generic after format check — does not enumerate accounts or SMTP failures.
pub async fn run_password_reset_request(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: PasswordResetRequestBody,
) -> Result<(), PasswordResetRequestError> {
    let raw = body.email.as_deref().unwrap_or("").trim();
    if !public_email_ok(raw) {
        return Err(PasswordResetRequestError::BadRequest(
            ERR_ENTER_VALID_EMAIL.into(),
        ));
    }
    if let Err(e) = try_issue_reset(pool, cfg, raw).await {
        tracing::error!(err = %e, "password-reset request");
    }
    Ok(())
}

async fn try_issue_reset(pool: &Pool, cfg: &WorkerConfig, raw_email: &str) -> Result<(), anyhow::Error> {
    let client = pool.get().await?;
    let row = client
        .query_opt(
            "SELECT id, email FROM users WHERE lower(email) = lower($1)",
            &[&raw_email],
        )
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let id: i32 = row.get("id");
    let email: String = row.get("email");
    let now = current_unix_ms();
    let ttl = i64::try_from(PASSWORD_RESET_TTL_MS)?;
    let expiry = now.saturating_add(ttl);
    let reset_token = build_signed_password_reset_token(&email, expiry, &cfg.auth_flow_token_secret);
    let token_hash = hash_token_sha256(&reset_token);
    client
        .execute(
            "UPDATE users SET
                password_reset_token_hash = $2,
                password_reset_token_expires_at = $3
              WHERE id = $1",
            &[&id, &token_hash, &expiry],
        )
        .await?;
    if let Err(e) = crate::mail::send_reset_email(
        &cfg.mail,
        &email,
        &reset_token,
        Some(u32::try_from(PASSWORD_RESET_VALIDITY_MINUTES).unwrap_or(u32::MAX)),
    )
    .await
    {
        tracing::error!(err = %e, "password-reset SMTP");
    }
    Ok(())
}

pub async fn run_password_reset_complete(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: PasswordResetCompleteBody,
) -> Result<(), PasswordResetCompleteError> {
    let reset_token = body.reset_token.as_deref().unwrap_or("");
    let new_password = body.new_password.as_deref().unwrap_or("");
    if reset_token.is_empty() || new_password.is_empty() {
        return Err(PasswordResetCompleteError::BadRequest(ERR_INCOMPLETE.into()));
    }
    let pv = validate_signup_password(Some(new_password), true);
    if !pv.is_ok() {
        return Err(PasswordResetCompleteError::BadRequest(
            pv.error.unwrap_or_else(|| "Set a password.".into()),
        ));
    }
    let now = current_unix_ms();
    let parsed = match parse_signed_password_reset_token(
        reset_token,
        &cfg.auth_flow_token_secret,
        now,
    ) {
        Ok(p) => p,
        Err(fail) => return Err(map_parse_fail(fail.status, fail.error)),
    };

    let token_hash = hash_token_sha256(reset_token);
    let client = pool.get().await.map_err(PasswordResetCompleteError::transport)?;
    let user_row = client
        .query_opt(
            "SELECT id, password_reset_token_hash, password_reset_token_expires_at
               FROM users WHERE lower(email) = $1",
            &[&parsed.email],
        )
        .await
        .map_err(PasswordResetCompleteError::transport)?;
    let Some(user_row) = user_row else {
        return Err(PasswordResetCompleteError::BadRequest(
            ERR_ACCOUNT_NOT_FOUND.into(),
        ));
    };
    let user_id: i32 = user_row.get("id");
    let stored_hash: Option<String> = user_row.get("password_reset_token_hash");
    let stored_expiry: Option<i64> = user_row.get("password_reset_token_expires_at");
    let Some(stored_hash) = stored_hash.filter(|s| !s.is_empty()) else {
        return Err(PasswordResetCompleteError::Forbidden(ERR_LINK_USED.into()));
    };
    if !timing_safe_token_hash_equal(&stored_hash, &token_hash) {
        return Err(PasswordResetCompleteError::Forbidden(ERR_LINK_USED.into()));
    }
    if stored_expiry.is_some_and(|exp| now > exp) {
        return Err(PasswordResetCompleteError::Forbidden(
            ERR_SESSION_EXPIRED.into(),
        ));
    }

    let hashed = hash_new_password(new_password.to_string()).await?;
    let uid = i64::from(user_id);
    run_session_delete_by_user(pool, &[uid])
        .await
        .map_err(|e| match e {
            AuthPgError::Transport(err) => PasswordResetCompleteError::Transport(err),
            other => PasswordResetCompleteError::transport(anyhow::anyhow!(other.error_message())),
        })?;
    if let Err(e) = run_refresh_revoke(pool, uid).await {
        tracing::error!(err = ?e, "reset-password revoke refresh");
    }
    let pg_uid = pg_user_id(uid).map_err(PasswordResetCompleteError::transport)?;
    let client = pool.get().await.map_err(PasswordResetCompleteError::transport)?;
    client
        .execute(
            "UPDATE users SET
                password = $2,
                password_reset_token_hash = NULL,
                password_reset_token_expires_at = NULL,
                login_failure_count = 0,
                login_locked_until = NULL
              WHERE id = $1",
            &[&pg_uid, &hashed],
        )
        .await
        .map_err(PasswordResetCompleteError::transport)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use genesis_core::parse_signed_password_reset_token;

    #[test]
    fn generic_ok_message_matches_node() {
        assert_eq!(
            PASSWORD_RESET_GENERIC_MESSAGE,
            "If an account exists for this email, we sent a link to reset your password."
        );
    }

    #[test]
    fn email_pattern_matches_node() {
        assert!(public_email_ok("user@gmail.com"));
        assert!(!public_email_ok(""));
        assert!(!public_email_ok("not-an-email"));
        assert!(!public_email_ok("a@.b"));
        assert!(!public_email_ok("a@b"));
    }

    #[test]
    fn parse_roundtrip_and_tamper() {
        let secret = "unit-test-auth-flow-secret";
        let token = build_signed_password_reset_token("User@Gmail.com", 9_999_999_999_999, secret);
        let parsed = parse_signed_password_reset_token(&token, secret, 1_000).unwrap();
        assert_eq!(parsed.email, "user@gmail.com");
        let mut bad = token;
        bad.push('x');
        let err = parse_signed_password_reset_token(&bad, secret, 1_000).unwrap_err();
        assert_eq!(err.status, 403);
    }

    #[test]
    fn parse_empty_is_400() {
        let secret = "unit-test-auth-flow-secret";
        let err = parse_signed_password_reset_token("", secret, 1_000).unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.error, ERR_INCOMPLETE);
    }
}
