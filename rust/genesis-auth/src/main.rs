//! `genesis-auth` — bcrypt + JWT + Turnstile + SMTP + session/refresh Postgres I/O.
//!
//! Node delegates via:
//!   POST http://$GENESIS_AUTH_URL/v1/auth/password/{hash,verify}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/jwt/{sign,verify}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/turnstile/verify
//!   POST http://$GENESIS_AUTH_URL/v1/auth/mail/{reset,verify}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/session/{create,load,delete,delete-by-user,update-flags,hydrate}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/login/complete
//!   POST http://$GENESIS_AUTH_URL/v1/auth/register
//!   POST http://$GENESIS_AUTH_URL/v1/auth/password-reset/{request,complete}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/email-verify/{request,complete}
//!   POST http://$GENESIS_AUTH_URL/v1/auth/refresh/{issue,rotate,revoke}
//! Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN`.

mod config;
mod db;
mod email_verify;
mod errors;
mod http;
mod hydrate;
mod login;
mod mail;
mod password_reset;
mod pg_types;
mod refresh;
mod register;
mod session;
mod turnstile;

use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::WorkerConfig;
use crate::http::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = WorkerConfig::from_env()?;
    let pool = db::create_pool(&cfg)?;
    let state = AppState {
        pool,
        cfg: cfg.clone(),
        http: reqwest::Client::new(),
    };

    info!(
        port = cfg.auth_worker_port,
        turnstile_enabled = cfg.turnstile.is_enforcement_ready(),
        "auth worker starting (password/JWT/turnstile/mail/session/refresh)"
    );

    let http_task = tokio::spawn(async move {
        if let Err(e) = http::serve(state).await {
            warn!(err = %e, "HTTP server exited");
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!(event = "shutdown", "SIGINT — auth worker stopping");
        }
        _ = http_task => {
            warn!("HTTP task ended");
        }
    }

    Ok(())
}
