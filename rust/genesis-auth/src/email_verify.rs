//! Email verification request + activate — Node `email-verification.ts`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::json;

use crate::config::WorkerConfig;
use crate::db::current_unix_ms;
use crate::password_reset::public_email_ok;
use crate::pg_types::pg_user_id;
use genesis_core::auth::constants::{
    ANTI_TIMING_DELAY_MS, COOLDOWN_MAP_MAX_SIZE, EMAIL_RESEND_COOLDOWN_MS,
    EMAIL_RESEND_COOLDOWN_MINUTES, EMAIL_VERIFICATION_TTL_HOURS, EMAIL_VERIFICATION_TTL_MS,
};
use genesis_core::time::MS_PER_SECOND;
use genesis_core::{
    build_signed_email_verification_token, hash_token_sha256,
    parse_signed_email_verification_token, timing_safe_token_hash_equal,
    user_requires_email_verification,
};

pub const EMAIL_VERIFY_REQUEST_PATH: &str = "/v1/auth/email-verify/request";
pub const EMAIL_VERIFY_COMPLETE_PATH: &str = "/v1/auth/email-verify/complete";

const _: () = assert!(EMAIL_VERIFICATION_TTL_HOURS == 24);
const _: () = assert!(EMAIL_RESEND_COOLDOWN_MINUTES == 5);
const _: () = assert!(ANTI_TIMING_DELAY_MS == 100);
const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);

pub const EMAIL_VERIFY_GENERIC_MESSAGE: &str =
    "If the email belongs to a pending new account, we resent the confirmation link.";

const ERR_ENTER_VALID_EMAIL: &str = "Enter a valid email.";
const ERR_INVALID_LINK: &str = "Invalid verification link.";
const ERR_EXPIRED_LINK: &str = "Verification link expired. Request a new one.";
const ERR_ACCOUNT_NOT_FOUND: &str = "Account not found for this link.";
const ERR_STALE_LINK: &str =
    "Verification link expired. Use the most recent link sent to your email.";
const MSG_ALREADY: &str = "Your email was already confirmed.";
const MSG_CONFIRMED: &str = "Email confirmed successfully. You can sign in now.";

const REFERRAL_CREDIT_PATH: &str = "/v1/wallet/referral/credit-on-email-verified";
const PROGRESS_TX_TIMEOUT_SEC: u64 = 5;
const WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER: u64 = 6;
const WALLET_HTTP_TIMEOUT_MS: u64 =
    PROGRESS_TX_TIMEOUT_SEC * MS_PER_SECOND * WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER;

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_SERVICE_UNAVAILABLE: u16 = 503;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailVerifyRequestBody {
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailVerifyCompleteBody {
    #[serde(default)]
    pub token: Option<String>,
}

impl std::fmt::Debug for EmailVerifyCompleteBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailVerifyCompleteBody")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug)]
pub enum EmailVerifyRequestError {
    BadRequest(String),
}

impl EmailVerifyRequestError {
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
pub struct EmailVerifyCompleteOk {
    pub already_verified: bool,
    pub message: String,
}

#[derive(Debug)]
pub enum EmailVerifyCompleteError {
    BadRequest(String),
    Forbidden(String),
    NotFound(String),
    Transport(anyhow::Error),
}

impl EmailVerifyCompleteError {
    fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::BadRequest(_) => {
                StatusCode::from_u16(HTTP_BAD_REQUEST).unwrap_or(StatusCode::BAD_REQUEST)
            }
            Self::Forbidden(_) => {
                StatusCode::from_u16(HTTP_FORBIDDEN).unwrap_or(StatusCode::FORBIDDEN)
            }
            Self::NotFound(_) => {
                StatusCode::from_u16(HTTP_NOT_FOUND).unwrap_or(StatusCode::NOT_FOUND)
            }
            Self::Transport(_) => StatusCode::from_u16(HTTP_SERVICE_UNAVAILABLE)
                .unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
        }
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest(m) | Self::Forbidden(m) | Self::NotFound(m) => m.clone(),
            Self::Transport(_) => "Could not confirm the email.".into(),
        }
    }
}

fn cooldown_map() -> &'static Mutex<HashMap<String, i64>> {
    static MAP: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_email_on_cooldown(email: &str, now: i64) -> bool {
    let Ok(mut map) = cooldown_map().lock() else {
        return true;
    };
    match map.get(email).copied() {
        Some(last) if now.saturating_sub(last) < EMAIL_RESEND_COOLDOWN_MS as i64 => true,
        Some(_) => {
            map.remove(email);
            false
        }
        None => false,
    }
}

fn mark_email_cooldown(email: &str, now: i64) {
    let Ok(mut map) = cooldown_map().lock() else {
        return;
    };
    map.insert(email.to_string(), now);
    if map.len() > COOLDOWN_MAP_MAX_SIZE {
        let cutoff = now.saturating_sub(EMAIL_RESEND_COOLDOWN_MS as i64);
        map.retain(|_, v| *v >= cutoff);
    }
}

async fn with_anti_timing_delay<T>(fut: impl std::future::Future<Output = T>) -> T {
    let start = Instant::now();
    let out = fut.await;
    let elapsed = start.elapsed();
    let budget = std::time::Duration::from_millis(ANTI_TIMING_DELAY_MS);
    if elapsed < budget {
        tokio::time::sleep(budget - elapsed).await;
    }
    out
}

async fn persist_and_send_verification(
    pool: &Pool,
    cfg: &WorkerConfig,
    email: &str,
) -> Result<(), anyhow::Error> {
    let now = current_unix_ms();
    let ttl = i64::try_from(EMAIL_VERIFICATION_TTL_MS)?;
    let token = build_signed_email_verification_token(email, now.saturating_add(ttl), &cfg.auth_flow_token_secret);
    let token_hash = hash_token_sha256(&token);
    let client = pool.get().await?;
    client
        .execute(
            "UPDATE users SET email_verification_token_hash = $2 WHERE lower(email) = $1",
            &[&email, &token_hash],
        )
        .await?;
    crate::mail::send_verification_email(
        &cfg.mail,
        email,
        &token,
        Some(u32::try_from(EMAIL_VERIFICATION_TTL_HOURS).unwrap_or(u32::MAX)),
    )
    .await
    .map_err(|e| anyhow::anyhow!(e))?;
    Ok(())
}

async fn resend_if_pending(pool: &Pool, cfg: &WorkerConfig, email: &str) -> Result<(), anyhow::Error> {
    let client = pool.get().await?;
    let row = client
        .query_opt(
            "SELECT email, email_verification_required, email_verified
               FROM users WHERE lower(email) = $1",
            &[&email],
        )
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let stored_email: String = row.get("email");
    let required: i32 = row.get("email_verification_required");
    let verified: i32 = row.get("email_verified");
    if !user_requires_email_verification(i64::from(verified), i64::from(required)) {
        return Ok(());
    }
    persist_and_send_verification(pool, cfg, &stored_email).await
}

/// Generic after format check — does not enumerate accounts.
pub async fn run_email_verify_request(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: EmailVerifyRequestBody,
) -> Result<(), EmailVerifyRequestError> {
    let raw = body
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !public_email_ok(&raw) {
        return Err(EmailVerifyRequestError::BadRequest(
            ERR_ENTER_VALID_EMAIL.into(),
        ));
    }
    let now = current_unix_ms();
    if is_email_on_cooldown(&raw, now) {
        return Ok(());
    }
    with_anti_timing_delay(async {
        if let Err(e) = resend_if_pending(pool, cfg, &raw).await {
            tracing::error!(err = %e, "request-email-verification SMTP");
        }
    })
    .await;
    mark_email_cooldown(&raw, current_unix_ms());
    Ok(())
}

async fn credit_referral_on_verified(
    cfg: &WorkerConfig,
    http: &reqwest::Client,
    verified_user_id: i64,
) -> Result<(), EmailVerifyCompleteError> {
    let Some(base) = cfg.wallet_url.as_deref() else {
        return Err(EmailVerifyCompleteError::transport(anyhow::anyhow!(
            "GENESIS_WALLET_URL unset"
        )));
    };
    let url = format!("{base}{REFERRAL_CREDIT_PATH}");
    let mut req = http
        .post(&url)
        .timeout(std::time::Duration::from_millis(WALLET_HTTP_TIMEOUT_MS))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&json!({
            "verifiedUserId": verified_user_id,
            "serverNowMs": current_unix_ms(),
        }));
    if let Some(token) = cfg.mining_worker_auth_token.as_deref() {
        req = req.header(crate::config::MINING_WORKER_AUTH_HEADER, token);
    }
    let res = req
        .send()
        .await
        .map_err(|e| EmailVerifyCompleteError::transport(anyhow::anyhow!(e.to_string())))?;
    if !res.status().is_success() {
        return Err(EmailVerifyCompleteError::transport(anyhow::anyhow!(
            "wallet referral credit status {}",
            res.status()
        )));
    }
    Ok(())
}

pub async fn run_email_verify_complete(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &reqwest::Client,
    body: EmailVerifyCompleteBody,
) -> Result<EmailVerifyCompleteOk, EmailVerifyCompleteError> {
    let raw_token = body.token.as_deref().unwrap_or("");
    let Some(parsed) = parse_signed_email_verification_token(raw_token, &cfg.auth_flow_token_secret)
    else {
        return Err(EmailVerifyCompleteError::BadRequest(ERR_INVALID_LINK.into()));
    };
    if current_unix_ms() > parsed.expiry {
        return Err(EmailVerifyCompleteError::Forbidden(ERR_EXPIRED_LINK.into()));
    }

    let client = pool.get().await.map_err(EmailVerifyCompleteError::transport)?;
    let row = client
        .query_opt(
            "SELECT id, email_verified, email_verification_token_hash
               FROM users WHERE lower(email) = $1",
            &[&parsed.email],
        )
        .await
        .map_err(EmailVerifyCompleteError::transport)?;
    let Some(row) = row else {
        return Err(EmailVerifyCompleteError::NotFound(ERR_ACCOUNT_NOT_FOUND.into()));
    };
    let user_id: i32 = row.get("id");
    let email_verified: i32 = row.get("email_verified");
    let stored_hash: Option<String> = row.get("email_verification_token_hash");
    let uid = i64::from(user_id);

    if email_verified == 1 {
        credit_referral_on_verified(cfg, http, uid).await?;
        return Ok(EmailVerifyCompleteOk {
            already_verified: true,
            message: MSG_ALREADY.into(),
        });
    }

    if let Some(stored) = stored_hash.filter(|s| !s.is_empty()) {
        let incoming = hash_token_sha256(raw_token);
        if !timing_safe_token_hash_equal(&incoming, &stored) {
            return Err(EmailVerifyCompleteError::Forbidden(ERR_STALE_LINK.into()));
        }
    }

    credit_referral_on_verified(cfg, http, uid).await?;

    let pg_uid = pg_user_id(uid).map_err(EmailVerifyCompleteError::transport)?;
    client
        .execute(
            "UPDATE users SET
                email_verified = 1,
                email_verification_required = 0,
                email_verification_token_hash = NULL
              WHERE id = $1",
            &[&pg_uid],
        )
        .await
        .map_err(EmailVerifyCompleteError::transport)?;

    Ok(EmailVerifyCompleteOk {
        already_verified: false,
        message: MSG_CONFIRMED.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_ok_message_matches_node() {
        assert_eq!(
            EMAIL_VERIFY_GENERIC_MESSAGE,
            "If the email belongs to a pending new account, we resent the confirmation link."
        );
    }

    #[test]
    fn parse_roundtrip() {
        let secret = "unit-test-auth-flow-secret";
        let token = build_signed_email_verification_token("A@B.COM", 100, secret);
        let p = parse_signed_email_verification_token(&token, secret).unwrap();
        assert_eq!(p.email, "a@b.com");
        assert!(parse_signed_email_verification_token("not-a-token", secret).is_none());
    }

    #[test]
    fn node_status_codes() {
        assert_eq!(HTTP_BAD_REQUEST, 400);
        assert_eq!(HTTP_FORBIDDEN, 403);
        assert_eq!(HTTP_NOT_FOUND, 404);
        assert_eq!(HTTP_SERVICE_UNAVAILABLE, 503);
    }

    #[test]
    fn wallet_unset_transport_is_503() {
        let err = EmailVerifyCompleteError::transport(anyhow::anyhow!("GENESIS_WALLET_URL unset"));
        assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.error_message(), "Could not confirm the email.");
    }
}
