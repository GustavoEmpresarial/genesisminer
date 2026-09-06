//! Distributed Redis lock — mirrors `server/core/redis/lock.ts`
//! (`SET NX EX` + compare-and-delete Lua).

use redis::aio::ConnectionManager;
use tracing::warn;
use uuid::Uuid;

use crate::config::{
    WorkerConfig, REDIS_LOCK_MINING_YIELD_TICK, REDIS_LOCK_TTL_MINING_YIELD_TICK_SEC,
};

const RELEASE_LOCK_SCRIPT: &str = r#"
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
"#;

const LOCK_TTL_SECONDS_MIN: u64 = 1;
/// 30 min ceiling — same as Node lock helper.
const LOCK_TTL_SECONDS_MAX: u64 = 30 * 60;

#[derive(Debug, Clone)]
pub struct LockHandle {
    pub key: String,
    pub token: String,
}

#[derive(Clone)]
pub struct RedisLockClient {
    manager: Option<ConnectionManager>,
    locks_enabled: bool,
}

impl RedisLockClient {
    /// Same degrade semantics as Node `miningProgressDistributedLockEffective`.
    pub fn locks_effective(&self) -> bool {
        self.manager.is_some() && self.locks_enabled
    }

    pub async fn connect(cfg: &WorkerConfig) -> anyhow::Result<Self> {
        let locks_enabled = cfg.redis_locks_enabled;
        let manager = if let Some(url) = cfg.redis_url.as_ref() {
            let client = redis::Client::open(url.as_str())?;
            Some(ConnectionManager::new(client).await?)
        } else {
            None
        };
        Ok(Self {
            manager,
            locks_enabled,
        })
    }

    fn clamp_ttl(ttl_seconds: u64) -> u64 {
        ttl_seconds.clamp(LOCK_TTL_SECONDS_MIN, LOCK_TTL_SECONDS_MAX)
    }

    /// Acquire yield-tick lock. Without Redis (or locks disabled) → always succeeds
    /// (same degrade path as Node).
    pub async fn try_acquire_mining_yield_tick(&self) -> anyhow::Result<Option<LockHandle>> {
        self.try_acquire(
            REDIS_LOCK_MINING_YIELD_TICK,
            REDIS_LOCK_TTL_MINING_YIELD_TICK_SEC,
        )
        .await
    }

    pub async fn try_acquire(
        &self,
        key: &str,
        ttl_seconds: u64,
    ) -> anyhow::Result<Option<LockHandle>> {
        let Some(manager) = self.manager.as_ref() else {
            return Ok(Some(LockHandle {
                key: key.to_string(),
                token: "no-redis".into(),
            }));
        };
        if !self.locks_enabled {
            return Ok(Some(LockHandle {
                key: key.to_string(),
                token: "locks-disabled".into(),
            }));
        }

        let token = Uuid::new_v4().to_string();
        let mut conn = manager.clone();
        let ttl = Self::clamp_ttl(ttl_seconds);
        let ok: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(&token)
            .arg("EX")
            .arg(ttl)
            .arg("NX")
            .query_async(&mut conn)
            .await?;
        if ok.as_deref() == Some("OK") {
            Ok(Some(LockHandle {
                key: key.to_string(),
                token,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn release(&self, handle: Option<LockHandle>) {
        let Some(handle) = handle else {
            return;
        };
        let Some(manager) = self.manager.as_ref() else {
            return;
        };
        if !self.locks_enabled {
            return;
        }
        let mut conn = manager.clone();
        let result: Result<(), redis::RedisError> = async {
            let _: i32 = redis::cmd("EVAL")
                .arg(RELEASE_LOCK_SCRIPT)
                .arg(1)
                .arg(&handle.key)
                .arg(&handle.token)
                .query_async(&mut conn)
                .await?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            warn!(key = %handle.key, err = %e, "redis lock release failed");
        }
    }

    /// GET string value (ranking snapshot, etc.). `None` when Redis unset.
    pub async fn get_string(&self, key: &str) -> anyhow::Result<Option<String>> {
        let Some(manager) = self.manager.as_ref() else {
            return Ok(None);
        };
        let mut conn = manager.clone();
        let val: Option<String> = redis::cmd("GET").arg(key).query_async(&mut conn).await?;
        Ok(val)
    }

    /// SET key value EX ttl_seconds (cache / snapshot — no lock TTL clamp).
    pub async fn set_ex(&self, key: &str, value: &str, ttl_seconds: u64) -> anyhow::Result<()> {
        let Some(manager) = self.manager.as_ref() else {
            return Ok(());
        };
        let mut conn = manager.clone();
        let ttl = ttl_seconds.max(LOCK_TTL_SECONDS_MIN);
        let _: () = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(ttl)
            .query_async(&mut conn)
            .await?;
        Ok(())
    }

    pub fn has_redis(&self) -> bool {
        self.manager.is_some()
    }

    /// `SET key value PX ms NX` — Node `chat:ratelimit:<userId>` check-and-set.
    pub async fn set_nx_px_ms(&self, key: &str, value: &str, px_ms: u64) -> anyhow::Result<bool> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let ok: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("PX")
            .arg(px_ms)
            .arg("NX")
            .query_async(&mut conn)
            .await?;
        Ok(ok.as_deref() == Some("OK"))
    }

    /// Remaining TTL in ms (`PTTL`). `None` when key missing.
    pub async fn pttl_ms(&self, key: &str) -> anyhow::Result<Option<i64>> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let ms: i64 = redis::cmd("PTTL").arg(key).query_async(&mut conn).await?;
        if ms < 0 {
            return Ok(None);
        }
        Ok(Some(ms))
    }

    pub async fn sadd(&self, key: &str, member: &str) -> anyhow::Result<i64> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let n: i64 = redis::cmd("SADD")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await?;
        Ok(n)
    }

    pub async fn srem(&self, key: &str, member: &str) -> anyhow::Result<i64> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let n: i64 = redis::cmd("SREM")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await?;
        Ok(n)
    }

    pub async fn scard(&self, key: &str) -> anyhow::Result<i64> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let n: i64 = redis::cmd("SCARD").arg(key).query_async(&mut conn).await?;
        Ok(n)
    }

    pub async fn expire_ms(&self, key: &str, px_ms: u64) -> anyhow::Result<()> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let _: () = redis::cmd("PEXPIRE")
            .arg(key)
            .arg(px_ms)
            .query_async(&mut conn)
            .await?;
        Ok(())
    }

    pub async fn try_acquire_public_ranking(&self) -> anyhow::Result<Option<LockHandle>> {
        self.try_acquire(
            crate::config::REDIS_LOCK_JOB_PUBLIC_RANKING,
            crate::config::REDIS_LOCK_TTL_PUBLIC_RANKING_SEC,
        )
        .await
    }

    /// PUBLISH to a Redis channel (genesis-api `genesis:ws:emit` fanout, etc.).
    pub async fn publish(&self, channel: &str, payload: &str) -> anyhow::Result<()> {
        let Some(manager) = self.manager.as_ref() else {
            anyhow::bail!("redis unset");
        };
        let mut conn = manager.clone();
        let _: i64 = redis::cmd("PUBLISH")
            .arg(channel)
            .arg(payload)
            .query_async(&mut conn)
            .await?;
        Ok(())
    }
}

/// Progress-user lock key pattern — `REDIS_LOCK_KEYS.miningProgressUser(userId)`.
pub fn mining_progress_user_lock_key(user_id: i64) -> String {
    format!("genesis:lock:mining_progress:user:{user_id}")
}

/// Owned Redis lock for yield tick: always releases on `Drop` even when
/// `tokio::time::timeout` cancels the tick future (async release via spawn).
pub struct OwnedYieldTickLock {
    locks: RedisLockClient,
    handle: Option<LockHandle>,
}

impl OwnedYieldTickLock {
    pub fn new(locks: RedisLockClient, handle: LockHandle) -> Self {
        Self {
            locks,
            handle: Some(handle),
        }
    }

    /// Best-effort async release before Drop (avoids spawn when path completes normally).
    pub async fn release(mut self) {
        if let Some(handle) = self.handle.take() {
            self.locks.release(Some(handle)).await;
        }
    }
}

impl Drop for OwnedYieldTickLock {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        let locks = self.locks.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    locks.release(Some(handle)).await;
                });
            }
            Err(_) => {
                warn!(
                    key = %handle.key,
                    "yield lock Drop without tokio runtime — relying on Redis TTL"
                );
            }
        }
    }
}
