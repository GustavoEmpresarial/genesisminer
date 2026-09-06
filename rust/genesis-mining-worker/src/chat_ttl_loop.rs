//! Chat TTL purge loop — owns Node `startChatTtlCron` (SQL + disk + ws emit).
//!
//! Redis lock `genesis:lock:job:chat-ttl`, interval `MS_PER_MINUTE`.
//! After a successful purge tick, publishes `chat:ttl_purge` on
//! [`crate::config::WS_EMIT_CHANNEL`] for genesis-api Socket.IO fanout.

use std::path::Path;
use std::time::Duration;

use deadpool_postgres::Pool;
use tracing::{info, warn};

use crate::chat_purge::{
    run_purge_expired_chat_messages, sweep_orphan_chat_audio, unlink_chat_audio_files,
};
use crate::config::{
    WorkerConfig, CHAT_TTL_MAX_BATCHES_PER_TICK, CHAT_TTL_PURGE_BATCH_LIMIT, CHAT_TTL_PURGE_EVENT,
    REDIS_LOCK_JOB_CHAT_TTL, REDIS_LOCK_TTL_CHAT_TTL_SEC, WS_EMIT_CHANNEL,
};
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

pub async fn run_chat_ttl_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.chat_ttl_loop_active() {
        info!(
            event = "chat_ttl_disabled",
            reason = "SCHEDULER_ENABLED=0 or CHAT_TTL_LOOP_ENABLED=0",
            "chat ttl idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        interval_ms = cfg.chat_ttl_interval_ms,
        timeout_ms = cfg.job_timeout_chat_ttl_ms,
        chat_audio_dir = %cfg.chat_audio_dir,
        "chat ttl cron starting"
    );

    // Immediate first tick (Node `void runner.tick()` before setInterval).
    run_one_tick(&pool, &locks, &cfg).await;

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.chat_ttl_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await; // consume immediate tick

    loop {
        interval.tick().await;
        run_one_tick(&pool, &locks, &cfg).await;
    }
}

async fn run_one_tick(pool: &Pool, locks: &RedisLockClient, cfg: &WorkerConfig) {
    let handle = match locks
        .try_acquire(REDIS_LOCK_JOB_CHAT_TTL, REDIS_LOCK_TTL_CHAT_TTL_SEC)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(event = "chat_ttl_lock_busy", "chat ttl lock held elsewhere");
            return;
        }
        Err(e) => {
            warn!(err = %e, "chat ttl lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match run_chat_ttl_purge(pool, Path::new(&cfg.chat_audio_dir)).await {
            Ok((messages, audio_files, orphans)) => {
                if messages > 0 || orphans > 0 {
                    info!(
                        event = "purged",
                        messages, audio_files, orphans, "chat ttl purge"
                    );
                }
                publish_ttl_purge(locks, messages, audio_files, orphans).await;
            }
            Err(e) => warn!(err = %e, "chat ttl purge tick failed"),
        }
    };
    match tokio::time::timeout(Duration::from_millis(cfg.job_timeout_chat_ttl_ms), tick).await {
        Ok(()) => {}
        Err(_) => warn!(
            timeout_ms = cfg.job_timeout_chat_ttl_ms,
            "chat ttl tick timed out"
        ),
    }
    owned.release().await;
}

async fn publish_ttl_purge(
    locks: &RedisLockClient,
    messages: usize,
    audio_files: usize,
    orphans: usize,
) {
    let body = serde_json::json!({
        "event": CHAT_TTL_PURGE_EVENT,
        "room": null,
        "payload": {
            "ok": true,
            "messages": messages,
            "audioFiles": audio_files,
            "orphans": orphans,
        }
    })
    .to_string();
    if let Err(e) = locks.publish(WS_EMIT_CHANNEL, &body).await {
        warn!(err = %e, "chat ttl ws emit publish failed");
    }
}

async fn run_chat_ttl_purge(
    pool: &Pool,
    chat_audio_dir: &Path,
) -> Result<(usize, usize, usize), String> {
    let mut total_deleted = 0usize;
    let mut total_audio = 0usize;
    let mut last_before = 0i64;

    for _ in 0..CHAT_TTL_MAX_BATCHES_PER_TICK {
        let out =
            run_purge_expired_chat_messages(pool, None, Some(CHAT_TTL_PURGE_BATCH_LIMIT)).await?;
        last_before = out.before_ms;
        if out.deleted < 1 {
            break;
        }
        total_deleted += out.deleted;
        total_audio += unlink_chat_audio_files(chat_audio_dir, &out.audio_urls);
        if out.deleted < CHAT_TTL_PURGE_BATCH_LIMIT as usize {
            break;
        }
    }

    let orphans = sweep_orphan_chat_audio(chat_audio_dir, last_before);
    Ok((total_deleted, total_audio, orphans))
}

#[cfg(test)]
mod tests {
    use crate::config::{CHAT_TTL_PURGE_EVENT, REDIS_LOCK_JOB_CHAT_TTL, WS_EMIT_CHANNEL};

    #[test]
    fn chat_ttl_lock_key_matches_node() {
        assert_eq!(REDIS_LOCK_JOB_CHAT_TTL, "genesis:lock:job:chat-ttl");
    }

    #[test]
    fn ws_emit_channel_and_event_match_genesis_api() {
        assert_eq!(WS_EMIT_CHANNEL, "genesis:ws:emit");
        assert_eq!(CHAT_TTL_PURGE_EVENT, "chat:ttl_purge");
    }
}
