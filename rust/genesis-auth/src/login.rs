//! Login domain after Turnstile — Node `login.controller.ts` PG + crypto (no cookies).

use deadpool_postgres::Pool;
use serde::Deserialize;
use tokio_postgres::Row;

use crate::config::WorkerConfig;
use crate::db::current_unix_ms;
use crate::errors::AuthPgError;
use crate::hydrate::{
    assemble_public_profile, list_access_level_ids, resolve_merge_enabled, PublicProfile,
    SessionFlagState,
};
use crate::pg_types::pg_user_id;
use crate::refresh::{run_refresh_issue, run_refresh_revoke};
use crate::session::run_session_create;
use genesis_core::auth::access_jwt::sign_access_token;
use genesis_core::auth::constants::{
    LOGIN_LOCKOUT_MS, LOGIN_MAX_FAILURES, REFERRAL_CODE_CLASH_RETRY_MAX, SESSION_TTL_SECONDS,
};
use genesis_core::auth::password::verify_password;
use genesis_core::generate_referral_code;
use genesis_core::time::MS_PER_SECOND;
use genesis_core::{
    is_account_locked, lockout_status, user_requires_email_verification,
    validate_login_email, validate_login_fields_present, validate_login_password,
};

pub const LOGIN_COMPLETE_PATH: &str = "/v1/auth/login/complete";

/// Node `DUMMY_BCRYPT_HASH` — unknown-email timing pad (bcrypt cost 12).
pub const DUMMY_BCRYPT_HASH: &str =
    "$2b$12$LZUbIvLtEnFKPqXhUGXwkuszLtVDFW9AcE/OeIQH.9y17O/wIFUIC";

const BCRYPT_PREFIX_2A: &str = "$2a$";
const BCRYPT_PREFIX_2B: &str = "$2b$";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCompleteRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

impl std::fmt::Debug for LoginCompleteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginCompleteRequest")
            .field("email", &self.email)
            .field("password", &"<redacted>")
            .field("ip", &self.ip)
            .field("user_agent", &self.user_agent)
            .finish()
    }
}

#[derive(Debug)]
pub struct LoginCompleteOk {
    pub session_id: String,
    pub token: String,
    pub expires_in_sec: u64,
    pub refresh_token: String,
    pub refresh_expires_in_sec: u64,
    pub profile: PublicProfile,
}

#[derive(Debug)]
pub enum LoginCompleteError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden { error: String, code: Option<String> },
    Locked { seconds: u64 },
    Transport(anyhow::Error),
}

impl LoginCompleteError {
    fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden { .. } => StatusCode::FORBIDDEN,
            Self::Locked { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Transport(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest(m) | Self::Unauthorized(m) => m.clone(),
            Self::Forbidden { error, .. } => error.clone(),
            Self::Locked { seconds } => format!(
                "Account temporarily locked due to too many failed attempts. Try again in {seconds} seconds."
            ),
            Self::Transport(_) => "Could not sign in.".into(),
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Forbidden { code, .. } => code.as_deref(),
            Self::Locked { .. } => Some("ACCOUNT_LOCKED"),
            _ => None,
        }
    }

    pub fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            Self::Locked { seconds } => Some(*seconds),
            _ => None,
        }
    }
}

fn hash_looks_bcrypt(pwd: &str) -> bool {
    pwd.starts_with(BCRYPT_PREFIX_2A) || pwd.starts_with(BCRYPT_PREFIX_2B)
}

fn usable_registration_ip(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some((first, _)) = s.split_once(',') {
        s = first.trim();
    }
    const V4_MAP: &str = "::ffff:";
    let n = if let Some(rest) = s.strip_prefix(V4_MAP) {
        rest
    } else {
        s
    };
    if n == "unknown" || n == "::1" || n == "127.0.0.1" {
        return None;
    }
    if let Some(octets) = parse_ipv4(n) {
        let [a, b, _, _] = octets;
        if a == 10 || a == 127 || a == 0 {
            return None;
        }
        if a == 172 && (16..=31).contains(&b) {
            return None;
        }
        if a == 192 && b == 168 {
            return None;
        }
        if a == 169 && b == 254 {
            return None;
        }
        return Some(n.to_string());
    }
    let lower = n.to_ascii_lowercase();
    if lower == "::1" || lower.starts_with("fe80:") || lower.starts_with("fc") || lower.starts_with("fd")
    {
        return None;
    }
    Some(n.to_string())
}

fn parse_ipv4(ip: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    for (i, p) in parts.iter().enumerate() {
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n as u8;
    }
    Some(out)
}

struct LoginUserRow {
    id: i64,
    username: String,
    email: String,
    password: String,
    is_admin: Option<i32>,
    is_super_admin: i32,
    polygon_wallet: Option<String>,
    is_blocked: Option<i32>,
    access_level_id: Option<String>,
    referral_code: Option<String>,
    referred_by: Option<String>,
    admin_permissions: Option<String>,
    email_verification_required: i32,
    email_verified: i32,
    login_locked_until_ms: Option<i64>,
}

fn login_user_from_row(row: &Row) -> LoginUserRow {
    let id: i32 = row.get("id");
    LoginUserRow {
        id: i64::from(id),
        username: row.get("username"),
        email: row.get("email"),
        password: row.get("password"),
        is_admin: row.get("is_admin"),
        is_super_admin: row.get("is_super_admin"),
        polygon_wallet: row.get("polygon_wallet"),
        is_blocked: row.get("is_blocked"),
        access_level_id: row.get("access_level_id"),
        referral_code: row.get("referral_code"),
        referred_by: row.get("referred_by"),
        admin_permissions: row.get("admin_permissions"),
        email_verification_required: row.get("email_verification_required"),
        email_verified: row.get("email_verified"),
        login_locked_until_ms: row.get("login_locked_until"),
    }
}

async fn find_user_by_email(pool: &Pool, email: &str) -> Result<Option<LoginUserRow>, LoginCompleteError> {
    let client = pool.get().await.map_err(LoginCompleteError::transport)?;
    let row = client
        .query_opt(
            "SELECT id, username, email, password, is_admin, is_super_admin,
                    polygon_wallet, is_blocked, access_level_id, referral_code,
                    referred_by, admin_permissions, email_verification_required,
                    email_verified, login_locked_until
               FROM users WHERE lower(email) = $1",
            &[&email],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    Ok(row.map(|r| login_user_from_row(&r)))
}

async fn record_login_failure(pool: &Pool, user_id: i64) -> Result<(), LoginCompleteError> {
    let uid = pg_user_id(user_id).map_err(LoginCompleteError::transport)?;
    let client = pool.get().await.map_err(LoginCompleteError::transport)?;
    let row = client
        .query_one(
            "UPDATE users SET login_failure_count = login_failure_count + 1
              WHERE id = $1 RETURNING login_failure_count",
            &[&uid],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    let count: i32 = row.get(0);
    if count as u32 >= LOGIN_MAX_FAILURES {
        let until = current_unix_ms().saturating_add(LOGIN_LOCKOUT_MS as i64);
        client
            .execute(
                "UPDATE users SET login_locked_until = $2 WHERE id = $1",
                &[&uid, &until],
            )
            .await
            .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    }
    Ok(())
}

async fn clear_login_failures(pool: &Pool, user_id: i64) -> Result<(), LoginCompleteError> {
    let uid = pg_user_id(user_id).map_err(LoginCompleteError::transport)?;
    let client = pool.get().await.map_err(LoginCompleteError::transport)?;
    client
        .execute(
            "UPDATE users SET login_failure_count = 0, login_locked_until = NULL WHERE id = $1",
            &[&uid],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    Ok(())
}

async fn record_login_ip(pool: &Pool, user_id: i64, ip: &str) -> Result<(), LoginCompleteError> {
    let Some(ip) = usable_registration_ip(ip) else {
        return Ok(());
    };
    let uid = pg_user_id(user_id).map_err(LoginCompleteError::transport)?;
    let now = current_unix_ms();
    let client = pool.get().await.map_err(LoginCompleteError::transport)?;
    client
        .execute(
            "UPDATE users SET registration_ip = $2 WHERE id = $1 AND registration_ip IS NULL",
            &[&uid, &ip],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    client
        .execute(
            "INSERT INTO user_history_ips (user_id, ip, last_used_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, ip) DO UPDATE SET last_used_at = EXCLUDED.last_used_at",
            &[&uid, &ip, &now],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    Ok(())
}

async fn ensure_referral_code(
    pool: &Pool,
    user_id: i64,
    username: &str,
    existing: Option<&str>,
) -> Result<String, LoginCompleteError> {
    if let Some(c) = existing.filter(|s| !s.is_empty()) {
        return Ok(c.to_string());
    }
    let uid = pg_user_id(user_id).map_err(LoginCompleteError::transport)?;
    let client = pool.get().await.map_err(LoginCompleteError::transport)?;
    let mut code = generate_referral_code(username);
    let mut tries = 0u32;
    while tries < REFERRAL_CODE_CLASH_RETRY_MAX {
        let clash = client
            .query_opt("SELECT id FROM users WHERE referral_code = $1", &[&code])
            .await
            .map_err(|e| LoginCompleteError::Transport(e.into()))?;
        if clash.is_none() {
            break;
        }
        code = generate_referral_code(username);
        tries += 1;
    }
    client
        .execute(
            "UPDATE users SET referral_code = $2 WHERE id = $1",
            &[&uid, &code],
        )
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    Ok(code)
}

fn validate_login_input(email: &str, password: &str) -> Result<String, LoginCompleteError> {
    let present = validate_login_fields_present(Some(email), Some(password));
    if !present.is_ok() {
        return Err(LoginCompleteError::BadRequest(
            present.error.unwrap_or_else(|| "Enter your email and password.".into()),
        ));
    }
    let email_check = validate_login_email(Some(email));
    if !email_check.is_ok() {
        return Err(LoginCompleteError::BadRequest(
            email_check.error.unwrap_or_else(|| "Invalid email.".into()),
        ));
    }
    let password_check = validate_login_password(Some(password));
    if !password_check.is_ok() {
        return Err(LoginCompleteError::BadRequest(
            password_check.error.unwrap_or_else(|| "Enter your password.".into()),
        ));
    }
    Ok(email.trim().to_ascii_lowercase())
}

async fn verify_password_async(password: String, hash: String) -> Result<bool, LoginCompleteError> {
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .map_err(|e| LoginCompleteError::Transport(e.into()))?
        .or(Ok(false))
}

pub async fn run_login_complete(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: LoginCompleteRequest,
) -> Result<LoginCompleteOk, LoginCompleteError> {
    let normalized = validate_login_input(&body.email, &body.password)?;
    let password = body.password;
    let user = find_user_by_email(pool, &normalized).await?;

    let Some(user) = user else {
        let _ = verify_password_async(password, DUMMY_BCRYPT_HASH.to_string()).await;
        return Err(LoginCompleteError::Unauthorized(
            "Incorrect email or password.".into(),
        ));
    };

    if user.is_blocked.unwrap_or(0) != 0 {
        return Err(LoginCompleteError::Forbidden {
            error: "This account is blocked.".into(),
            code: None,
        });
    }

    let now = current_unix_ms();
    if is_account_locked(user.login_locked_until_ms, now) {
        let secs = lockout_status(user.login_locked_until_ms, now).remaining_seconds;
        return Err(LoginCompleteError::Locked { seconds: secs });
    }

    if user_requires_email_verification(
        i64::from(user.email_verified),
        i64::from(user.email_verification_required),
    ) {
        return Err(LoginCompleteError::Forbidden {
            error: "Confirm your account email using the link we sent before signing in.".into(),
            code: Some("EMAIL_NOT_VERIFIED".into()),
        });
    }

    let mut is_match = false;
    if !user.password.is_empty() && hash_looks_bcrypt(&user.password) {
        is_match = verify_password_async(password, user.password.clone()).await?;
    }

    if !is_match {
        if let Err(e) = record_login_failure(pool, user.id).await {
            tracing::warn!(err = ?e, "recordLoginFailure");
        }
        return Err(LoginCompleteError::Unauthorized(
            "Incorrect email or password.".into(),
        ));
    }

    if let Err(e) = clear_login_failures(pool, user.id).await {
        tracing::warn!(err = ?e, "clearLoginFailures");
    }
    if let Some(ip) = body.ip.as_deref() {
        if let Err(e) = record_login_ip(pool, user.id, ip).await {
            tracing::warn!(err = ?e, "recordLoginIp");
        }
    }

    let referral = ensure_referral_code(
        pool,
        user.id,
        &user.username,
        user.referral_code.as_deref(),
    )
    .await
    .unwrap_or_else(|_| user.referral_code.clone().unwrap_or_default());

    let session_id = uuid::Uuid::new_v4().to_string();
    let ttl_ms = i64::try_from(SESSION_TTL_SECONDS.saturating_mul(MS_PER_SECOND))
        .map_err(|e| LoginCompleteError::Transport(e.into()))?;
    let expires_at_ms = current_unix_ms().saturating_add(ttl_ms);
    run_session_create(pool, user.id, &session_id, expires_at_ms)
        .await
        .map_err(|e| match e {
            AuthPgError::Transport(err) => LoginCompleteError::Transport(err),
            other => LoginCompleteError::Transport(anyhow::anyhow!(other.error_message())),
        })?;

    if let Err(e) = run_refresh_revoke(pool, user.id).await {
        return Err(match e {
            AuthPgError::Transport(err) => LoginCompleteError::Transport(err),
            other => LoginCompleteError::Transport(anyhow::anyhow!(other.error_message())),
        });
    }
    let issued = run_refresh_issue(
        pool,
        cfg,
        user.id,
        body.user_agent.as_deref(),
        body.ip.as_deref(),
    )
    .await
    .map_err(|e| match e {
        AuthPgError::Transport(err) => LoginCompleteError::Transport(err),
        other => LoginCompleteError::Transport(anyhow::anyhow!(other.error_message())),
    })?;

    let token = sign_access_token(&cfg.jwt, &user.id.to_string())
        .map_err(|e| LoginCompleteError::Transport(anyhow::anyhow!(e.to_string())))?;

    let access_levels = list_access_level_ids(pool, user.id, user.access_level_id.as_deref())
        .await
        .map_err(|e| LoginCompleteError::Transport(anyhow::anyhow!(e.error_message())))?;
    let merge_enabled = resolve_merge_enabled(pool).await;
    let profile = assemble_public_profile(
        user.id,
        &user.username,
        &user.email,
        user.is_admin,
        user.is_super_admin,
        user.admin_permissions.as_deref(),
        user.is_blocked,
        user.polygon_wallet,
        user.access_level_id,
        access_levels,
        Some(referral).filter(|s| !s.is_empty()).or(user.referral_code),
        user.referred_by,
        user.email_verified,
        user.email_verification_required,
        SessionFlagState::default(),
        false,
        cfg.account_manager_enabled,
        merge_enabled,
    );

    Ok(LoginCompleteOk {
        session_id,
        token,
        expires_in_sec: cfg.jwt.access_ttl_sec,
        refresh_token: issued.refresh_token,
        refresh_expires_in_sec: issued.expires_in_sec,
        profile,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dummy_hash_is_bcrypt() {
        assert!(hash_looks_bcrypt(DUMMY_BCRYPT_HASH));
    }

    #[test]
    fn validate_rejects_empty() {
        let err = validate_login_input("", "").unwrap_err();
        assert!(matches!(err, LoginCompleteError::BadRequest(_)));
    }

    #[test]
    fn validate_normalizes_email() {
        let e = validate_login_input("  A@B.Com ", "secret1").unwrap();
        assert_eq!(e, "a@b.com");
    }

    #[test]
    fn private_ip_not_recorded() {
        assert!(usable_registration_ip("127.0.0.1").is_none());
        assert!(usable_registration_ip("10.0.0.2").is_none());
        assert!(usable_registration_ip("192.168.1.1").is_none());
        assert_eq!(
            usable_registration_ip("8.8.8.8").as_deref(),
            Some("8.8.8.8")
        );
    }
}
