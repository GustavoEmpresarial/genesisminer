//! Env config for the wallet money-TX worker binary.
//!
//! Listen port = same `8091` as other internal workers (isolated container).
//! Auth header = `x-mining-worker-token` (same as mining / hardware / auth).

use genesis_core::time::MS_PER_SECOND;

/// Default HTTP listen port — keep in sync with Node `MINING_WORKER_DEFAULT_PORT`.
pub const WALLET_WORKER_DEFAULT_PORT: u16 = 8091;

/// Auth header for Node → worker HTTP.
/// Keep in sync with Node `MINING_WORKER_AUTH_HEADER` in mining-worker-client.ts.
pub const MINING_WORKER_AUTH_HEADER: &str = "x-mining-worker-token";

/// Node `LOCK_TIMEOUT_MS` in exchange-liquidation / withdraw-request.
pub const WALLET_LOCK_TIMEOUT_MS: u64 = 45_000;

/// Statement timeout headroom above lock timeout (same ratio idea as market buy).
pub const WALLET_STATEMENT_TIMEOUT_MS: u64 = WALLET_LOCK_TIMEOUT_MS * 2;

const _: () = assert!(WALLET_LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(WALLET_STATEMENT_TIMEOUT_MS == 90_000);
const _: () = assert!(MS_PER_SECOND == 1_000);

pub fn current_unix_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub database_url: String,
    pub wallet_worker_port: u16,
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
            wallet_worker_port: env_u16_clamped(
                "WALLET_WORKER_PORT",
                WALLET_WORKER_DEFAULT_PORT,
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
