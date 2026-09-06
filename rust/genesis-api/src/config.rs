//! Public shell config — `API_PORT` default 3000 (nginx `app:3000`).

use genesis_core::time::{MS_PER_MINUTE, MS_PER_SECOND, SECONDS_PER_DAY};

/// Default listen port — nginx `proxy_pass http://app:3000`.
pub const API_DEFAULT_PORT: u16 = 3000;

/// Node `PROGRESS_TX_TIMEOUT_SEC` in mining-worker-client.
const PROGRESS_TX_TIMEOUT_SEC: u64 = 5;
/// Node `WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER`.
const WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER: u64 = 6;
/// Worker HTTP budget — same as Node `MINING_WORKER_PROGRESS_TIMEOUT_MS`.
pub const MINING_WORKER_PROGRESS_TIMEOUT_MS: u64 =
    PROGRESS_TX_TIMEOUT_SEC * MS_PER_SECOND * WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER;
/// Node `SUPPORT_LOCK_TIMEOUT_MS`.
pub const SUPPORT_LOCK_TIMEOUT_MS: u64 = 45_000;
/// Node `MINING_WORKER_SUPPORT_TIMEOUT_MS`.
pub const MINING_WORKER_SUPPORT_TIMEOUT_MS: u64 =
    SUPPORT_LOCK_TIMEOUT_MS + MINING_WORKER_PROGRESS_TIMEOUT_MS;

const _: () = assert!(SUPPORT_LOCK_TIMEOUT_MS == 45_000);

/// Express reverse-proxy / websocket handshake — 60s named (`MS_PER_MINUTE`).
pub const EXPRESS_PROXY_TIMEOUT_MS: u64 = MS_PER_MINUTE;

/// Node `READINESS_DEFAULT_MS` — short probe.
pub const READINESS_DEFAULT_MS: u64 = 2 * MS_PER_SECOND;

/// Node `TICKET_ID_MAX_LENGTH`.
pub const TICKET_ID_MAX_LENGTH: usize = 80;

/// Node `COOKIE_ACCESS`.
pub const COOKIE_ACCESS: &str = "gm_access";
/// Node `COOKIE_REFRESH`.
pub const COOKIE_REFRESH: &str = "gm_refresh";
/// Legacy session cookie.
pub const COOKIE_SID: &str = "sid";

/// Auth header — same as workers.
pub const MINING_WORKER_AUTH_HEADER: &str = "x-mining-worker-token";

/// Node `DEFAULT_IMG_UPLOADS_DIR` / mining-worker default.
const DEFAULT_IMG_UPLOADS_DIR: &str = "storage/uploads";
/// Node `deps.ts` `IMG_DIR` default.
const DEFAULT_IMG_DIR: &str = "storage/media-seed";
/// Express `client/dist` (Dockerfile api: `CLIENT_DIST=/app/client/dist`).
const DEFAULT_CLIENT_DIST: &str = "client/dist";

/// Express hashed `/assets/*` Cache-Control — 365 calendar days (`max-age=31536000`).
const DAYS_PER_YEAR: u64 = 365;
pub const SPA_HASHED_ASSET_MAX_AGE_SEC: u64 = SECONDS_PER_DAY * DAYS_PER_YEAR;

#[derive(Clone)]
pub struct ApiConfig {
    pub api_port: u16,
    pub is_production: bool,
    pub express_url: Option<String>,
    pub auth_url: Option<String>,
    pub mining_worker_url: Option<String>,
    pub hardware_url: Option<String>,
    pub wallet_url: Option<String>,
    pub mining_worker_auth_token: Option<String>,
    pub turnstile_enabled: bool,
    pub turnstile_site_key: String,
    pub cookie: crate::cookies::CookieConfig,
    pub img_uploads_dir: String,
    pub img_dir: String,
    pub support_upload_dir: String,
    pub client_dist: String,
    pub trust_cf_connecting_ip: bool,
}

impl std::fmt::Debug for ApiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiConfig")
            .field("api_port", &self.api_port)
            .field("is_production", &self.is_production)
            .field("express_url", &self.express_url)
            .field("auth_url", &self.auth_url)
            .field("mining_worker_url", &self.mining_worker_url)
            .field("hardware_url", &self.hardware_url)
            .field("wallet_url", &self.wallet_url)
            .field("img_dir", &self.img_dir)
            .field("client_dist", &self.client_dist)
            .field(
                "mining_worker_auth_token",
                &self.mining_worker_auth_token.as_ref().map(|_| "<redacted>"),
            )
            .field("turnstile_enabled", &self.turnstile_enabled)
            .field("img_uploads_dir", &self.img_uploads_dir)
            .finish()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: ApiConfig,
    pub http: reqwest::Client,
    /// Set once during `http::serve` after Socket.IO build.
    pub realtime: std::sync::Arc<std::sync::OnceLock<crate::realtime::RealtimeHandle>>,
    /// Optional Redis (`REDIS_URL`) — HTTP rate limits + realtime bus.
    pub redis: Option<redis::aio::ConnectionManager>,
}

impl AppState {
    pub fn new(cfg: ApiConfig, http: reqwest::Client) -> Self {
        Self {
            cfg,
            http,
            realtime: std::sync::Arc::new(std::sync::OnceLock::new()),
            redis: None,
        }
    }

    /// Attach `REDIS_URL` connection manager when set (fail-open if unset).
    pub async fn attach_redis_from_env(&mut self) -> anyhow::Result<()> {
        let url = std::env::var("REDIS_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let Some(url) = url else {
            return Ok(());
        };
        let client = redis::Client::open(url.as_str())?;
        self.redis = Some(redis::aio::ConnectionManager::new(client).await?);
        Ok(())
    }

    pub fn emit_market(&self, payload: serde_json::Value) {
        if let Some(rt) = self.realtime.get() {
            let rt = rt.clone();
            tokio::spawn(async move {
                rt.emit_market(payload).await;
            });
        }
    }

    pub fn emit_chat_message(&self, channel: String, message: serde_json::Value) {
        if let Some(rt) = self.realtime.get() {
            let rt = rt.clone();
            tokio::spawn(async move {
                rt.emit_chat_message(&channel, message).await;
            });
        }
    }
}

impl ApiConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let is_production = is_production();
        let express_url = env_url("GENESIS_EXPRESS_URL");
        if is_production && express_url.is_none() {
            anyhow::bail!("GENESIS_EXPRESS_URL is required when NODE_ENV=production");
        }
        let auth_url = env_url("GENESIS_AUTH_URL");
        if is_production && auth_url.is_none() {
            anyhow::bail!("GENESIS_AUTH_URL is required when NODE_ENV=production");
        }
        let img_uploads_dir = env_string_or("IMG_UPLOADS_DIR", DEFAULT_IMG_UPLOADS_DIR);
        let support_upload_dir =
            env_nonempty("SUPPORT_UPLOAD_DIR").unwrap_or_else(|| img_uploads_dir.clone());
        let site_key = env_nonempty("CLOUDFLARE_TURNSTILE_SITE_KEY").unwrap_or_default();
        let enabled_flag = env_nonempty("CLOUDFLARE_TURNSTILE_ENABLED")
            .map(|v| v == "1")
            .unwrap_or(false);
        Ok(Self {
            api_port: env_u16("API_PORT", API_DEFAULT_PORT),
            is_production,
            express_url,
            auth_url,
            mining_worker_url: env_url("GENESIS_MINING_WORKER_URL"),
            hardware_url: env_url("GENESIS_HARDWARE_URL"),
            wallet_url: env_url("GENESIS_WALLET_URL"),
            mining_worker_auth_token: env_nonempty("MINING_WORKER_AUTH_TOKEN"),
            turnstile_enabled: enabled_flag && !site_key.is_empty(),
            turnstile_site_key: site_key,
            cookie: crate::cookies::CookieConfig::from_env(is_production),
            img_uploads_dir,
            img_dir: env_string_or("IMG_DIR", DEFAULT_IMG_DIR),
            support_upload_dir,
            client_dist: env_string_or("CLIENT_DIST", DEFAULT_CLIENT_DIST),
            trust_cf_connecting_ip: env_nonempty("TRUST_CF_CONNECTING_IP")
                .map(|v| v == "1")
                .unwrap_or(false),
        })
    }
}

pub fn is_production() -> bool {
    std::env::var("NODE_ENV")
        .map(|v| v.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false)
}

fn env_url(key: &str) -> Option<String> {
    env_nonempty(key).map(|s| s.trim_end_matches('/').to_string())
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_string_or(key: &str, fallback: &str) -> String {
    env_nonempty(key).unwrap_or_else(|| fallback.to_string())
}

fn env_u16(key: &str, fallback: u16) -> u16 {
    match std::env::var(key) {
        Ok(raw) => raw.trim().parse::<u16>().unwrap_or(fallback).max(1),
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
    fn prod_boot_bails_without_auth_url() {
        with_env(
            &[
                ("NODE_ENV", Some("production")),
                ("GENESIS_EXPRESS_URL", Some("http://express:3001")),
                ("GENESIS_AUTH_URL", None),
            ],
            || {
                let err = ApiConfig::from_env().expect_err("auth url required in prod");
                assert!(err.to_string().contains("GENESIS_AUTH_URL"));
            },
        );
    }

    #[test]
    fn prod_boot_bails_without_express_url() {
        with_env(
            &[
                ("NODE_ENV", Some("production")),
                ("GENESIS_EXPRESS_URL", None),
                ("GENESIS_AUTH_URL", Some("http://auth:8091")),
            ],
            || {
                let err = ApiConfig::from_env().expect_err("express url required in prod");
                assert!(err.to_string().contains("GENESIS_EXPRESS_URL"));
            },
        );
    }

    #[test]
    fn prod_boot_ok_when_express_and_auth_set() {
        with_env(
            &[
                ("NODE_ENV", Some("production")),
                ("GENESIS_EXPRESS_URL", Some("http://express:3001")),
                ("GENESIS_AUTH_URL", Some("http://auth:8091")),
            ],
            || {
                let cfg = ApiConfig::from_env().expect("prod urls set");
                assert_eq!(cfg.express_url.as_deref(), Some("http://express:3001"));
                assert_eq!(cfg.auth_url.as_deref(), Some("http://auth:8091"));
            },
        );
    }
}
