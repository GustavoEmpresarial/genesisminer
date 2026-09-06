//! Idempotency purge loop — owns Node `startIdempotencyPurgeCron`.
//!
//! Redis lock `genesis:lock:job:idempotency-purge`, interval `MS_PER_HOUR`.
//! Batch DELETE on `game_servers_intent_idempotency` + `lucky_box_idempotency`
//! (30d retention, `created_at` timestamptz).

use std::time::Duration;

use deadpool_postgres::Pool;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, IDEMPOTENCY_MAX_BATCHES_PER_TICK, IDEMPOTENCY_PURGE_BATCH,
    IDEMPOTENCY_RETENTION_DAYS, REDIS_LOCK_JOB_IDEMPOTENCY_PURGE,
    REDIS_LOCK_TTL_IDEMPOTENCY_PURGE_SEC,
};
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

/// Tables + age column — Node `IDEMPOTENCY_TABLES` (both timestamptz).
/// `(table, created_at is epoch-ms bigint)`. `game_servers_intent_idempotency`
/// stores `created_at` as `timestamptz`; `lucky_box_idempotency` as `bigint` ms.
const IDEMPOTENCY_TABLES: &[(&str, bool)] = &[
    ("game_servers_intent_idempotency", false),
    ("lucky_box_idempotency", true),
];

pub async fn run_idempotency_purge_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.idempotency_purge_loop_active() {
        info!(
            event = "idempotency_purge_disabled",
            reason = "SCHEDULER_ENABLED=0 or IDEMPOTENCY_PURGE_LOOP_ENABLED=0",
            "idempotency purge idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        interval_ms = cfg.idempotency_purge_interval_ms,
        timeout_ms = cfg.job_timeout_idempotency_purge_ms,
        retention_days = IDEMPOTENCY_RETENTION_DAYS,
        "idempotency purge cron starting"
    );

    run_one_tick(&pool, &locks, &cfg).await;

    let mut interval =
        tokio::time::interval(Duration::from_millis(cfg.idempotency_purge_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await;

    loop {
        interval.tick().await;
        run_one_tick(&pool, &locks, &cfg).await;
    }
}

async fn run_one_tick(pool: &Pool, locks: &RedisLockClient, cfg: &WorkerConfig) {
    let handle = match locks
        .try_acquire(
            REDIS_LOCK_JOB_IDEMPOTENCY_PURGE,
            REDIS_LOCK_TTL_IDEMPOTENCY_PURGE_SEC,
        )
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(
                event = "idempotency_purge_lock_busy",
                "idempotency purge lock held elsewhere"
            );
            return;
        }
        Err(e) => {
            warn!(err = %e, "idempotency purge lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match run_idempotency_purge(pool).await {
            Ok(total) => {
                if total > 0 {
                    info!(
                        event = "purged",
                        total,
                        retention_days = IDEMPOTENCY_RETENTION_DAYS,
                        "idempotency purged"
                    );
                }
            }
            Err(e) => warn!(err = %e, "idempotency purge tick failed"),
        }
    };
    match tokio::time::timeout(
        Duration::from_millis(cfg.job_timeout_idempotency_purge_ms),
        tick,
    )
    .await
    {
        Ok(()) => {}
        Err(_) => warn!(
            timeout_ms = cfg.job_timeout_idempotency_purge_ms,
            "idempotency purge tick timed out"
        ),
    }
    owned.release().await;
}

async fn run_idempotency_purge(pool: &Pool) -> Result<u64, String> {
    let mut total = 0u64;
    for (table, epoch_ms) in IDEMPOTENCY_TABLES {
        total += purge_table(pool, table, *epoch_ms).await?;
    }
    Ok(total)
}

async fn purge_table(pool: &Pool, table: &str, epoch_ms: bool) -> Result<u64, String> {
    let mut deleted = 0u64;
    for _ in 0..IDEMPOTENCY_MAX_BATCHES_PER_TICK {
        let n = purge_batch(pool, table, epoch_ms).await?;
        deleted += n;
        if n < IDEMPOTENCY_PURGE_BATCH as u64 {
            break;
        }
    }
    Ok(deleted)
}

async fn purge_batch(pool: &Pool, table: &str, epoch_ms: bool) -> Result<u64, String> {
    // Table names are compile-time consts from IDEMPOTENCY_TABLES — not user input.
    // `$1` is the cutoff itself: a bigint epoch-ms for the ms-column tables, or an
    // int day-count for the timestamptz table (computed here to keep bind types clean).
    let client = pool.get().await.map_err(|e| format!("pool get: {e}"))?;
    let n = if epoch_ms {
        let cutoff_ms: i64 = crate::player_reads::now_ms()
            - i64::from(IDEMPOTENCY_RETENTION_DAYS) * (genesis_core::time::MS_PER_DAY as i64);
        let sql = format!(
            "DELETE FROM {table}
              WHERE ctid IN (SELECT ctid FROM {table} WHERE created_at < $1 LIMIT $2)"
        );
        client
            .execute(sql.as_str(), &[&cutoff_ms, &IDEMPOTENCY_PURGE_BATCH])
            .await
    } else {
        let sql = format!(
            "DELETE FROM {table}
              WHERE ctid IN (
                SELECT ctid FROM {table}
                 WHERE created_at < now() - ($1::int * interval '1 day') LIMIT $2)"
        );
        client
            .execute(
                sql.as_str(),
                &[&IDEMPOTENCY_RETENTION_DAYS, &IDEMPOTENCY_PURGE_BATCH],
            )
            .await
    }
    .map_err(|e| format!("purge {table}: {e}"))?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_key_matches_node() {
        assert_eq!(
            REDIS_LOCK_JOB_IDEMPOTENCY_PURGE,
            "genesis:lock:job:idempotency-purge"
        );
    }

    #[test]
    fn retention_and_batch_match_node() {
        assert_eq!(IDEMPOTENCY_RETENTION_DAYS, 30);
        assert_eq!(IDEMPOTENCY_PURGE_BATCH, 5_000);
        assert_eq!(IDEMPOTENCY_MAX_BATCHES_PER_TICK, 20);
    }

    #[test]
    fn tables_cover_known_idempotency_rows() {
        let names: Vec<&str> = IDEMPOTENCY_TABLES.iter().map(|(t, _)| *t).collect();
        assert!(names.contains(&"game_servers_intent_idempotency"));
        assert!(names.contains(&"lucky_box_idempotency"));
    }
}
