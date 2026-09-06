//! Env config for the auth crypto worker binary.
//!
//! Listen port = `AUTH_WORKER_PORT` (default same `8091` as other internal workers).
//! Auth header = `x-mining-worker-token` (same as mining / hardware workers).

use genesis_core::auth::access_jwt::AccessJwtConfig;
use genesis_core::auth::constants::{
    ACCESS_JWT_DEFAULT_AUDIENCE, ACCESS_JWT_DEFAULT_ISSUER, ACCESS_JWT_PROD_SECRET_MIN_LENGTH,
    ACCESS_JWT_TTL_CEILING_SEC, ACCESS_JWT_TTL_DEFAULT_SEC, ACCESS_JWT_TTL_FLOOR_SEC,
    AUTH_FLOW_SECRET_MIN_LENGTH, REFRESH_JWT_TTL_CEILING_SEC, REFRESH_JWT_TTL_DEFAULT_SEC,
    REFRESH_JWT_TTL_FLOOR_SEC,
};

use crate::mail::MailConfig;
use crate::turnstile::TurnstileConfig;

/// Default HTTP listen port — keep in sync with Node `MINING_WORKER_DEFAULT_PORT`.
pub const AUTH_WORKER_DEFAULT_PORT: u16 = 8091;

/// Auth header for Node → worker HTTP.
/// Keep in sync with Node `MINING_WORKER_AUTH_HEADER` in mining-worker-client.ts.
pub const MINING_WORKER_AUTH_HEADER: &str = "x-mining-worker-token";

/// Dev-only fallback when `JWT_SECRET` unset and not production — keep in sync with Node `config.ts`.
const DEV_FALLBACK_JWT_SECRET: &str =
    "dev-only-jwt-secret-do-not-use-in-production-min-32-chars!";

#[derive(Clone)]
pub struct WorkerConfig {
    pub database_url: String,
    pub auth_worker_port: u16,
    /// Shared secret for `x-mining-worker-token`. `None` = auth disabled (dev only).
    pub mining_worker_auth_token: Option<String>,
    pub jwt: AccessJwtConfig,
    /// Refresh cookie / row TTL — same floor/ceiling as Node `getJwtAuthConfig`.
    pub refresh_ttl_sec: u64,
    pub turnstile: TurnstileConfig,
    pub mail: MailConfig,
    /// Node `ACCOUNT_MANAGER_ENABLED` — hydrate / login profile flag.
    pub account_manager_enabled: bool,
    /// HMAC secret for password-reset / email-verify tokens — Node `getAuthFlowTokenSecret`.
    pub auth_flow_token_secret: String,
    /// `GENESIS_WALLET_URL` — referral credit on email verify. `None` = fail-closed 503.
    pub wallet_url: Option<String>,
}

impl std::fmt::Debug for WorkerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerConfig")
            .field("database_url", &"<redacted>")
            .field("auth_worker_port", &self.auth_worker_port)
            .field(
                "mining_worker_auth_token",
                &self
                    .mining_worker_auth_token
                    .as_ref()
                    .map(|_| "<redacted>"),
            )
            .field("jwt", &self.jwt)
            .field("refresh_ttl_sec", &self.refresh_ttl_sec)
            .field("turnstile", &self.turnstile)
            .field("mail", &self.mail)
            .field("account_manager_enabled", &self.account_manager_enabled)
            .field("auth_flow_token_secret", &"<redacted>")
            .field("wallet_url", &self.wallet_url)
            .finish()
    }
}

impl WorkerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let mining_worker_auth_token = resolve_mining_worker_auth_token()?;
        let jwt = resolve_jwt_config()?;
        let auth_flow_token_secret = resolve_auth_flow_token_secret(&jwt.secret)?;
        Ok(Self {
            database_url,
            auth_worker_port: env_u16_clamped(
                "AUTH_WORKER_PORT",
                AUTH_WORKER_DEFAULT_PORT,
                1,
                u16::MAX,
            ),
            mining_worker_auth_token,
            jwt,
            refresh_ttl_sec: resolve_refresh_ttl_sec(),
            turnstile: TurnstileConfig::from_env(),
            mail: MailConfig::from_env(),
            account_manager_enabled: env_flag_on("ACCOUNT_MANAGER_ENABLED"),
            auth_flow_token_secret,
            wallet_url: env_url("GENESIS_WALLET_URL"),
        })
    }
}

fn resolve_mining_worker_auth_token() -> anyhow::Result<Option<String>> {
    let token = std::env::var("MINING_WORKER_AUTH_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let is_prod = is_production();
    if is_prod && token.is_none() {
        anyhow::bail!("MINING_WORKER_AUTH_TOKEN is required when NODE_ENV=production");
    }
    Ok(token)
}

fn resolve_jwt_config() -> anyhow::Result<AccessJwtConfig> {
    let secret_raw = std::env::var("JWT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let is_prod = is_production();
    if is_prod {
        let secret = secret_raw.ok_or_else(|| anyhow::anyhow!("JWT_SECRET em falta."))?;
        if secret.len() < ACCESS_JWT_PROD_SECRET_MIN_LENGTH {
            anyhow::bail!(
                "[JWT] Em produção defina JWT_SECRET com pelo menos {} characters.",
                ACCESS_JWT_PROD_SECRET_MIN_LENGTH
            );
        }
        return Ok(AccessJwtConfig {
            secret,
            issuer: env_string_or("JWT_ISSUER", ACCESS_JWT_DEFAULT_ISSUER),
            audience: env_string_or("JWT_AUDIENCE", ACCESS_JWT_DEFAULT_AUDIENCE),
            access_ttl_sec: resolve_access_ttl_sec(),
        });
    }
    let secret = secret_raw.unwrap_or_else(|| DEV_FALLBACK_JWT_SECRET.to_string());
    if std::env::var("JWT_SECRET")
        .ok()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        tracing::warn!(
            "[JWT] JWT_SECRET não definido — a usar segredo de desenvolvimento (não usar em produção)."
        );
    }
    Ok(AccessJwtConfig {
        secret,
        issuer: env_string_or("JWT_ISSUER", ACCESS_JWT_DEFAULT_ISSUER),
        audience: env_string_or("JWT_AUDIENCE", ACCESS_JWT_DEFAULT_AUDIENCE),
        access_ttl_sec: resolve_access_ttl_sec(),
    })
}

fn resolve_access_ttl_sec() -> u64 {
    let raw = match std::env::var("JWT_ACCESS_TTL_SEC") {
        Ok(s) => s
            .trim()
            .parse::<u64>()
            .unwrap_or(ACCESS_JWT_TTL_DEFAULT_SEC),
        Err(_) => ACCESS_JWT_TTL_DEFAULT_SEC,
    };
    let floored = raw.max(ACCESS_JWT_TTL_FLOOR_SEC);
    floored.min(ACCESS_JWT_TTL_CEILING_SEC)
}

fn resolve_refresh_ttl_sec() -> u64 {
    let raw = match std::env::var("JWT_REFRESH_TTL_SEC") {
        Ok(s) => s
            .trim()
            .parse::<u64>()
            .unwrap_or(REFRESH_JWT_TTL_DEFAULT_SEC),
        Err(_) => REFRESH_JWT_TTL_DEFAULT_SEC,
    };
    let floored = raw.max(REFRESH_JWT_TTL_FLOOR_SEC);
    floored.min(REFRESH_JWT_TTL_CEILING_SEC)
}

/// Node `getAuthFlowTokenSecret` — `AUTH_FLOW_TOKEN_SECRET` or `JWT_SECRET`, fail-closed if short.
fn resolve_auth_flow_token_secret(jwt_secret: &str) -> anyhow::Result<String> {
    let from_env = std::env::var("AUTH_FLOW_TOKEN_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let secret = from_env.unwrap_or_else(|| jwt_secret.trim().to_string());
    if secret.len() < AUTH_FLOW_SECRET_MIN_LENGTH {
        anyhow::bail!(
            "[SECURITY] AUTH_FLOW_TOKEN_SECRET não definido ou demasiado curto. \
             Defina AUTH_FLOW_TOKEN_SECRET com pelo menos 32 caracteres aleatórios."
        );
    }
    Ok(secret)
}

fn env_url(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

fn env_string_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn env_flag_on(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes" || t == "on"
        }
        Err(_) => false,
    }
}

fn is_production() -> bool {
    std::env::var("NODE_ENV")
        .map(|v| v.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false)
}

fn env_u16_clamped(key: &str, fallback: u16, min: u16, max: u16) -> u16 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<u16>() {
            Ok(n) => n.clamp(min, max),
            Err(_) => fallback,
        },
        Err(_) => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env(pairs: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let saved: Vec<(String, Option<String>)> = pairs
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in pairs {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        f();
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }

    #[test]
    fn auth_flow_secret_shorter_than_min_fails_closed() {
        let jwt = "j".repeat(32);
        with_env(
            &[
                ("DATABASE_URL", Some("postgres://invalid")),
                ("NODE_ENV", Some("development")),
                ("JWT_SECRET", Some(jwt.as_str())),
                ("AUTH_FLOW_TOKEN_SECRET", Some("tooshort")),
            ],
            || {
                let err = WorkerConfig::from_env().expect_err("short auth-flow secret");
                let msg = err.to_string();
                assert!(msg.contains("SECURITY") || msg.contains("AUTH_FLOW"));
            },
        );
    }

    #[test]
    fn auth_flow_falls_back_to_jwt_when_unset() {
        let jwt = "k".repeat(32);
        with_env(
            &[
                ("DATABASE_URL", Some("postgres://invalid")),
                ("NODE_ENV", Some("development")),
                ("JWT_SECRET", Some(jwt.as_str())),
                ("AUTH_FLOW_TOKEN_SECRET", None),
            ],
            || {
                let cfg = WorkerConfig::from_env().expect("jwt fallback");
                assert_eq!(cfg.auth_flow_token_secret.len(), jwt.len());
            },
        );
    }
}
