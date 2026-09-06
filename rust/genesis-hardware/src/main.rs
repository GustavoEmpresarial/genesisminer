//! `genesis-hardware` — stock / racks persist + intent I/O in Rust.
//!
//! Node credits / persists / adjust / fold-warehouse / recall-all / wipe-user / p2p-instances / market / shop / merge / wheel / lucky-boxes / rooms via:
//!   POST http://$GENESIS_HARDWARE_URL/v1/hardware/{persist,intent,credit,adjust,racks-power,fold-warehouse,recall-all,wipe-user,p2p-instances}
//!   POST http://$GENESIS_HARDWARE_URL/v1/market/{sell,cancel,reserve,cancel-reserve,buy,buy-cached,claim-*,reclaim,listings,my-listings,custody,sellable-stock,history,state}
//!   POST http://$GENESIS_HARDWARE_URL/v1/shop/checkout
//!   POST http://$GENESIS_HARDWARE_URL/v1/merge/execute
//!   POST http://$GENESIS_HARDWARE_URL/v1/wheel/{paid-spin,redeem-code,roll}
//!   POST http://$GENESIS_HARDWARE_URL/v1/roleta/claim
//!   POST http://$GENESIS_HARDWARE_URL/v1/lucky-boxes/{buy,open,promocodes/redeem}
//!   POST http://$GENESIS_HARDWARE_URL/v1/rooms/purchase-slot
//!   POST http://$GENESIS_HARDWARE_URL/v1/upgrades/purchase
//!   POST http://$GENESIS_HARDWARE_URL/v1/catalog/upgrades/replace
//!   POST http://$GENESIS_HARDWARE_URL/v1/catalog/{access-levels/replace,loot-boxes/upsert,mining-coins/upsert,news/upsert,news/delete,season-passes/replace}
//!   POST http://$GENESIS_HARDWARE_URL/v1/settings/{news-fee,news-expire-days}/persist
//!   POST http://$GENESIS_HARDWARE_URL/v1/rooms/catalog/upsert
//! Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN`.

mod adjust;
mod admin_catalog;
mod bulk_batteries;
mod catalog;
mod config;
mod db;
mod eligibility;
mod http;
mod instances;
mod intent_idem;
mod leases;
mod load;
mod lucky_boxes;
mod market;
mod merge;
mod p2p;
mod persist;
mod pg_types;
mod player_reads;
mod post_apply;
mod racks_power;
mod recall_all;
mod rooms;
mod shop;
mod upgrades;
mod wheel;
mod wipe_user;

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
    };

    info!(
        port = cfg.hardware_worker_port,
        "hardware worker starting (HTTP persist/intent/credit/adjust/racks-power/fold-warehouse/recall-all/wipe-user/p2p-instances/market/shop/merge/wheel/lucky-boxes/rooms/upgrades/catalog)"
    );

    let http_task = tokio::spawn(async move {
        if let Err(e) = http::serve(state).await {
            warn!(err = %e, "HTTP server exited");
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!(event = "shutdown", "SIGINT — hardware worker stopping");
        }
        _ = http_task => {
            warn!("HTTP task ended");
        }
    }

    Ok(())
}
