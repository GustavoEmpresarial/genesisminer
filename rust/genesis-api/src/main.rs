//! `genesis-api` — public game HTTP + Socket.IO. Express receives admin only.

mod admin_auth;
mod admin_catalog;
mod admin_tabs;
mod admin_transparency;
mod admin_users;
mod admin_wallet_tabs;
mod client_ip;
mod config;
mod cookies;
mod dashboard;
mod download;
mod facade;
mod gerente;
mod http;
mod img;
mod owned;
mod partner_games;
mod partners;
mod player;
mod proxy;
mod rate_limit;
mod realtime;
mod session;
mod spa;
mod workers;

use tracing::info;
use tracing::warn;
use tracing_subscriber::EnvFilter;

use crate::config::{ApiConfig, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = ApiConfig::from_env()?;
    info!(
        port = cfg.api_port,
        express = ?cfg.express_url,
        "genesis-api starting (game HTTP + Socket.IO; Express = admin only)"
    );

    let state = AppState::new(cfg, reqwest::Client::new());

    let http_task = tokio::spawn(async move {
        if let Err(e) = http::serve(state).await {
            warn!(err = %e, "HTTP server exited");
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!(event = "shutdown", "SIGINT — genesis-api stopping");
        }
        _ = http_task => {
            warn!("HTTP task ended");
        }
    }

    Ok(())
}
