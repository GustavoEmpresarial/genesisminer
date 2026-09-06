//! Env config for the hardware worker binary.
//!
//! Listen port = same `8091` as `MINING_WORKER_DEFAULT_PORT` (isolated container).
//! Auth header = `x-mining-worker-token` (same as mining worker).

use genesis_core::time::MS_PER_SECOND;

/// Default HTTP listen port — keep in sync with Node `MINING_WORKER_DEFAULT_PORT`.
pub const MINING_WORKER_DEFAULT_PORT: u16 = 8091;

/// Auth header for Node → worker HTTP.
/// Keep in sync with Node `MINING_WORKER_AUTH_HEADER` in mining-worker-client.ts.
pub const MINING_WORKER_AUTH_HEADER: &str = "x-mining-worker-token";

/// Seconds of `SET LOCAL statement_timeout` inside persist/intent TX
/// (same as mining-worker `PROGRESS_TX_TIMEOUT_SEC`).
pub const HARDWARE_TX_TIMEOUT_SEC: u64 = 5;
/// `SET LOCAL statement_timeout` / `lock_timeout` inside persist/intent TX.
pub const HARDWARE_TX_TIMEOUT_MS: u64 = HARDWARE_TX_TIMEOUT_SEC * MS_PER_SECOND;

pub fn current_unix_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub database_url: String,
    pub hardware_worker_port: u16,
    /// Shared secret for `x-mining-worker-token`. `None` = auth disabled (dev only).
    pub mining_worker_auth_token: Option<String>,
}

impl WorkerConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let mining_worker_auth_token = resolve_mining_worker_auth_token()?;
        Ok(Self {
            database_url,
            hardware_worker_port: env_u16_clamped(
                "MINING_WORKER_PORT",
                MINING_WORKER_DEFAULT_PORT,
                1,
                u16::MAX,
            ),
            mining_worker_auth_token,
        })
    }
}

fn resolve_mining_worker_auth_token() -> anyhow::Result<Option<String>> {
    let token = std::env::var("MINING_WORKER_AUTH_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let is_prod = std::env::var("NODE_ENV")
        .map(|v| v.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false);
    if is_prod && token.is_none() {
        anyhow::bail!("MINING_WORKER_AUTH_TOKEN is required when NODE_ENV=production");
    }
    Ok(token)
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
