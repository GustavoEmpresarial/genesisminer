//! `genesis-wallet` — wallet money TXs in Rust (exchange / withdraw / deposit / quest / referral / offerwall / admin / partners approve).
//!
//! Node delegates via:
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/exchange/liquidate
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/withdraw/request
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/deposit/credit
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/deposit/resolve-receipt
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/deposit/verify
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/quests/claim
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/referral/credit-on-email-verified
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/offerwall/zerads-credit
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/admin/withdrawals/status
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/admin/coin-balance/set
//!   POST http://$GENESIS_WALLET_URL/v1/wallet/admin/save-game-balances
//!   POST http://$GENESIS_WALLET_URL/v1/partners/youtube/submissions/approve
//!   POST http://$GENESIS_WALLET_URL/v1/web3-settings/persist
//!   POST http://$GENESIS_WALLET_URL/v1/wallet-labels/{list,upsert}
//! Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN`.

mod admin_balances;
mod admin_web3;
mod admin_withdrawal_status;
mod config;
mod db;
mod deposit;
mod deposit_receipt;
mod deposit_verify;
mod errors;
mod exchange;
mod http;
mod partner_youtube_approve;
mod pg_types;
mod player_reads;
mod quest_claim;
mod referral_credit;
mod treasury_token_txs;
mod util;
mod withdraw;
mod zerads_credit;
mod zerads_offerwall;

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
    let http = reqwest::Client::new();

    let state = AppState {
        pool,
        cfg: cfg.clone(),
        http,
    };

    info!(
        port = cfg.wallet_worker_port,
        "wallet worker starting (exchange/liquidate, withdraw/request, deposit/credit, deposit/resolve-receipt, deposit/verify, quests/claim, referral/credit, offerwall/zerads, admin/withdrawals/status, admin/coin-balance/set, admin/save-game-balances, partners/youtube/approve)"
    );

    let http_task = tokio::spawn(async move {
        if let Err(e) = http::serve(state).await {
            warn!(err = %e, "HTTP server exited");
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!(event = "shutdown", "SIGINT — wallet worker stopping");
        }
        _ = http_task => {
            warn!("HTTP task ended");
        }
    }

    Ok(())
}
