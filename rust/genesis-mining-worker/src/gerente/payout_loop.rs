//! Hourly gerente payout loop — owns Node `startGerentePayoutCron`.

use std::time::Duration;

use deadpool_postgres::Pool;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, REDIS_LOCK_JOB_GERENTE_PAYOUT, REDIS_LOCK_TTL_GERENTE_PAYOUT_SEC,
};
use crate::gerente_payout::pay_closed_manager_weeks;
use crate::player_reads::now_ms;
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

pub async fn run_gerente_payout_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.gerente_payout_loop_active() {
        info!(
            event = "gerente_payout_disabled",
            reason = "SCHEDULER_ENABLED=0 or GERENTE_PAYOUT_LOOP_ENABLED=0",
            "gerente payout idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        interval_ms = cfg.gerente_payout_interval_ms,
        timeout_ms = cfg.job_timeout_gerente_payout_ms,
        "gerente payout cron starting"
    );

    // Immediate first tick (Node `void runner.tick()` before setInterval).
    run_one_tick(&pool, &locks, &cfg).await;

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.gerente_payout_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await; // consume immediate tick

    loop {
        interval.tick().await;
        run_one_tick(&pool, &locks, &cfg).await;
    }
}

async fn run_one_tick(pool: &Pool, locks: &RedisLockClient, cfg: &WorkerConfig) {
    let handle = match locks
        .try_acquire(
            REDIS_LOCK_JOB_GERENTE_PAYOUT,
            REDIS_LOCK_TTL_GERENTE_PAYOUT_SEC,
        )
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(
                event = "gerente_payout_lock_busy",
                "gerente payout lock held elsewhere"
            );
            return;
        }
        Err(e) => {
            warn!(err = %e, "gerente payout lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        let now = now_ms();
        let result = pay_closed_manager_weeks(pool, cfg, now).await;
        if result.ok {
            info!(
                event = "paid",
                paid = result.paid,
                skipped = result.skipped,
                "gerente payout tick"
            );
        } else {
            warn!(
                err = result.error.as_deref().unwrap_or("unknown"),
                "gerente payout tick failed"
            );
        }
    };
    match tokio::time::timeout(
        Duration::from_millis(cfg.job_timeout_gerente_payout_ms),
        tick,
    )
    .await
    {
        Ok(()) => {}
        Err(_) => warn!(
            timeout_ms = cfg.job_timeout_gerente_payout_ms,
            "gerente payout tick timed out"
        ),
    }
    owned.release().await;
}
