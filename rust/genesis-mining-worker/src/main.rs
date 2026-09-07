//! `genesis-mining-worker` — 100% Rust mining engine I/O (yield cron + progress + ranking + chat + support).
//!
//! Disable the Node scheduler when this binary owns the tick:
//!   SCHEDULER_ENABLED=0  (or MINING_YIELD_SCHEDULER_ENABLED=0 on the Node process)
//! and run this worker with SCHEDULER_ENABLED=1 + DATABASE_URL + REDIS_URL.
//!
//! Node credits via: POST http://127.0.0.1:$MINING_WORKER_PORT/v1/mining/progress
//! Gerente payout: POST /v1/gerente/payout (+ hourly loop owns Node payout-cron)
//! Gerente player: POST /v1/gerente/me|hire|apply|accept|decline|fire|resign|enter|leave
//! Ranking: GET /v1/ranking/public|me|admin , POST /v1/ranking/refresh
//! Chat TTL: POST /v1/chat/purge-expired (+ minute loop owns Node ttl-cron SQL+disk+ws)
//! Idempotency purge: hourly loop owns Node startIdempotencyPurgeCron
//! Auto SQL backup: local-clock loop owns Node startScheduledSqlBackups
//! Chat writes: POST /v1/chat/insert|edit|delete
//! Support: POST /v1/support/submit|reply|admin-reply + list-mine|get|state|archive|reopen + admin/*
//! Announcements: POST /v1/announcements/create|update|delete|mark-read + pending|mini-blog|admin-list
//! Chat reads: POST /v1/chat/history|get|sender|peers|mentions-search|mentions-resolve
//! Calculator: POST /v1/calculator/snapshot body `{ userId, scope? }`

mod admin_dashboard;
mod admin_gate;
mod admin_users;
mod announcements;
mod backup_sql_loop;
mod calculator;
mod calculator_ai;
mod chat_presence;
mod chat_purge;
mod chat_reads;
mod chat_ttl_loop;
mod chat_writes;
mod config;
mod dashboard;
mod db;
mod gerente;
mod gerente_payout;
mod http;
mod idempotency_purge_loop;
mod kafka;
mod partner_games;
mod partners;
mod partners_admin;
mod player_reads;
mod profile_writes;
mod progress;
mod quests_admin;
mod ranking;
mod redis_lock;
mod room_ids;
mod settings_writes;
mod support;
mod support_reads;
mod transparency_admin;
mod uploads;
mod users;
mod webp_convert;
mod yield_tick;

use std::future::pending;
use std::sync::Arc;
use std::time::Duration;

use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::WorkerConfig;
use crate::http::AppState;
use crate::ranking::RankingService;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = WorkerConfig::from_env()?;
    let kafka = Arc::new(kafka::KafkaBus::connect(&cfg));

    let pool = db::create_pool(&cfg)?;
    let locks = redis_lock::RedisLockClient::connect(&cfg).await?;
    let ranking = RankingService::new(pool.clone(), locks.clone(), cfg.clone(), kafka.clone());

    let state = AppState {
        pool: pool.clone(),
        locks: locks.clone(),
        cfg: cfg.clone(),
        ranking: ranking.clone(),
        kafka: kafka.clone(),
        http: reqwest::Client::new(),
    };

    info!(
        port = cfg.mining_worker_port,
        yield_loop = cfg.yield_loop_enabled(),
        ranking_loop = cfg.ranking_loop_active(),
        gerente_payout_loop = cfg.gerente_payout_loop_active(),
        chat_ttl_loop = cfg.chat_ttl_loop_active(),
        idempotency_purge_loop = cfg.idempotency_purge_loop_active(),
        backup_sql_loop = cfg.backup_sql_loop_active(),
        grid = cfg.ten_minute_grid_enabled,
        "mining worker starting (HTTP + optional cron loops)"
    );

    let http_task = tokio::spawn(async move {
        if let Err(e) = http::serve(state).await {
            warn!(err = %e, "HTTP server exited");
        }
    });

    let yield_task = {
        let pool = pool.clone();
        let locks = locks.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if !cfg.yield_loop_enabled() {
                info!(
                    event = "yield_disabled",
                    reason = "SCHEDULER_ENABLED=0 or MINING_YIELD_*_ENABLED=0",
                    "yield cron idle — HTTP still serving"
                );
                pending::<()>().await;
                return;
            }

            info!(
                interval_ms = cfg.yield_cron_interval_ms,
                startup_delay_ms = cfg.startup_delay_ms,
                "mining yield cron starting"
            );

            tokio::time::sleep(Duration::from_millis(cfg.startup_delay_ms)).await;

            let mut interval =
                tokio::time::interval(Duration::from_millis(cfg.yield_cron_interval_ms));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                interval.tick().await;
                let tick = yield_tick::run_yield_tick(&pool, &locks, &cfg);
                match tokio::time::timeout(
                    Duration::from_millis(cfg.job_timeout_mining_yield_ms),
                    tick,
                )
                .await
                {
                    Ok(Ok(())) => info!(event = "health", "yield worker healthy"),
                    Ok(Err(e)) => warn!(err = %e, "yield tick failed"),
                    Err(_) => warn!(
                        timeout_ms = cfg.job_timeout_mining_yield_ms,
                        "yield tick timed out"
                    ),
                }
            }
        })
    };

    let ranking_task = {
        let ranking = ranking.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            ranking::run_ranking_refresh_loop(ranking, cfg).await;
        })
    };

    let gerente_payout_task = {
        let pool = pool.clone();
        let locks = locks.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            gerente::run_gerente_payout_loop(pool, locks, cfg).await;
        })
    };

    let chat_ttl_task = {
        let pool = pool.clone();
        let locks = locks.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            chat_ttl_loop::run_chat_ttl_loop(pool, locks, cfg).await;
        })
    };

    let idempotency_purge_task = {
        let pool = pool.clone();
        let locks = locks.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            idempotency_purge_loop::run_idempotency_purge_loop(pool, locks, cfg).await;
        })
    };

    let backup_sql_task = {
        let pool = pool.clone();
        let locks = locks.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            backup_sql_loop::run_backup_sql_loop(pool, locks, cfg).await;
        })
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!(event = "shutdown", "SIGINT — mining worker stopping");
        }
        _ = http_task => {
            warn!("HTTP task ended");
        }
        _ = yield_task => {
            warn!("yield task ended");
        }
        _ = ranking_task => {
            warn!("ranking task ended");
        }
        _ = gerente_payout_task => {
            warn!("gerente payout task ended");
        }
        _ = chat_ttl_task => {
            warn!("chat ttl task ended");
        }
        _ = idempotency_purge_task => {
            warn!("idempotency purge task ended");
        }
        _ = backup_sql_task => {
            warn!("backup sql task ended");
        }
    }

    Ok(())
}
