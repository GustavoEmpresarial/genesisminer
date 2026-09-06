//! Public / admin mining ranking I/O — scan PG, cache Redis, refresh loop.
//!
//! Domain math lives in `genesis_core::ranking`. Wire format matches Node
//! `ranking:public:v1` JSON (`timestamp`, `user_id`, `generalCoins`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use deadpool_postgres::Pool;
use genesis_core::calculator::types::CalculatorUpgradeLite;
use genesis_core::ranking::{
    accumulate_admin_ranking_power_from_racks, accumulate_ranking_power_from_racks,
    filter_admin_ranking_users, my_global_mining_rank_from_payload, AdminMiningRankingPayload,
    AdminRankingUser, CoinLite, MyGlobalMiningRank, PublicMiningRankingPayload, PublicRankingUser,
    RankingRackInput,
};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, RANKING_LOCAL_FALLBACK_TTL_MS, RANKING_REDIS_KEY,
    RANKING_SLOW_REFRESH_LOG_THRESHOLD_MS,
};
use crate::kafka;
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

struct RankingScanData {
    coins: Vec<CoinLite>,
    upgrades_mining: HashMap<String, CalculatorUpgradeLite>,
    nft_room_ids: HashSet<String>,
    asic_room_ids: HashSet<String>,
    eligible_users: Vec<(i64, String)>,
    racks: Vec<RankingRackInput>,
    slots_by_rack: HashMap<String, Vec<Option<String>>>,
    mult_by_rack: HashMap<String, Vec<Option<String>>>,
}

#[derive(Clone)]
pub struct RankingService {
    pool: Pool,
    locks: RedisLockClient,
    cfg: WorkerConfig,
    kafka: kafka::SharedKafka,
    local_fallback: Arc<Mutex<Option<(u64, PublicMiningRankingPayload)>>>,
    my_rank_cache: Arc<Mutex<Option<(u64, PublicMiningRankingPayload)>>>,
    /// Serializes uncached computes (Node `inFlightCompute` dedup).
    compute_lock: Arc<Mutex<()>>,
}

impl RankingService {
    pub fn new(
        pool: Pool,
        locks: RedisLockClient,
        cfg: WorkerConfig,
        kafka: kafka::SharedKafka,
    ) -> Self {
        Self {
            pool,
            locks,
            cfg,
            kafka,
            local_fallback: Arc::new(Mutex::new(None)),
            my_rank_cache: Arc::new(Mutex::new(None)),
            compute_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn get_public(&self, fresh: bool) -> anyhow::Result<PublicMiningRankingPayload> {
        if fresh {
            return self.compute_and_cache(true).await;
        }

        if self.locks.has_redis() {
            match self.locks.get_string(RANKING_REDIS_KEY).await {
                Ok(Some(raw)) => match serde_json::from_str::<PublicMiningRankingPayload>(&raw) {
                    Ok(payload) => return Ok(payload),
                    Err(e) => warn!(err = %e, "ranking redis JSON parse failed"),
                },
                Ok(None) => {}
                Err(e) => warn!(err = %e, "ranking redis GET failed — fallback"),
            }
        }

        let now = now_ms();
        {
            let guard = self.local_fallback.lock().await;
            if let Some((at, ref payload)) = *guard {
                if now.saturating_sub(at) < RANKING_LOCAL_FALLBACK_TTL_MS {
                    return Ok(payload.clone());
                }
            }
        }

        self.compute_and_cache(false).await
    }

    pub async fn get_my_rank(
        &self,
        user_id: i64,
        fresh: bool,
    ) -> anyhow::Result<MyGlobalMiningRank> {
        if user_id <= 0 {
            return Ok(MyGlobalMiningRank {
                position: None,
                total_ranked: 0,
                hash: 0.0,
            });
        }
        let payload = self.get_public_cached_for_me(fresh).await?;
        Ok(my_global_mining_rank_from_payload(&payload, user_id))
    }

    pub async fn get_admin(&self) -> anyhow::Result<AdminMiningRankingPayload> {
        let scan = self.load_scan_data().await?;
        let mut ranking_data: HashMap<i64, AdminRankingUser> = HashMap::new();
        let mut username_by_id: HashMap<i64, String> = HashMap::new();
        for (id, name) in &scan.eligible_users {
            username_by_id.insert(*id, name.clone());
            ranking_data.insert(
                *id,
                AdminRankingUser {
                    user_id: *id,
                    username: name.clone(),
                    coins: HashMap::new(),
                    general_coins: HashMap::new(),
                    balances: HashMap::new(),
                },
            );
        }

        accumulate_admin_ranking_power_from_racks(
            &mut ranking_data,
            &scan.racks,
            &scan.slots_by_rack,
            &scan.mult_by_rack,
            &scan.upgrades_mining,
            &scan.nft_room_ids,
            &scan.asic_room_ids,
            &username_by_id,
        );

        let coin_ids: Vec<String> = scan.coins.iter().map(|c| c.id.clone()).collect();
        if !coin_ids.is_empty() {
            let client = self.pool.get().await.context("pg pool")?;
            let bal_rows = client
                .query(
                    "SELECT user_id, coin_id, amount FROM coin_balances WHERE coin_id = ANY($1)",
                    &[&coin_ids],
                )
                .await
                .context("coin_balances")?;
            for row in &bal_rows {
                let uid = row_user_id(row);
                let coin_id: String = row.get("coin_id");
                let amount = row_f64(row, "amount");
                if let Some(entry) = ranking_data.get_mut(&uid) {
                    entry.balances.insert(coin_id, amount);
                }
            }
        }

        let ranking = filter_admin_ranking_users(ranking_data.into_values().collect());
        Ok(AdminMiningRankingPayload {
            timestamp: now_ms() as i64,
            ranking,
            coins: scan.coins,
        })
    }

    /// Force recompute + Redis write (HTTP refresh / job tick).
    pub async fn refresh_snapshot(&self) -> anyhow::Result<PublicMiningRankingPayload> {
        let t0 = Instant::now();
        let payload = self.compute_and_cache(true).await?;
        let duration_ms = t0.elapsed().as_millis() as u64;
        if duration_ms >= RANKING_SLOW_REFRESH_LOG_THRESHOLD_MS {
            warn!(
                event = "slow_refresh",
                duration_ms,
                ranking_size = payload.ranking.len(),
                "public ranking refresh slow"
            );
        }
        self.kafka.publish_ranking_snapshot(&payload).await;
        Ok(payload)
    }

    /// Background tick with Redis lock (mirrors Node job runner).
    pub async fn run_refresh_tick(&self) -> anyhow::Result<()> {
        let handle = match self.locks.try_acquire_public_ranking().await? {
            Some(h) => h,
            None => {
                info!(
                    event = "ranking_lock_busy",
                    "public ranking lock held elsewhere"
                );
                return Ok(());
            }
        };
        let owned = OwnedYieldTickLock::new(self.locks.clone(), handle);
        let tick = async {
            let _ = self.refresh_snapshot().await?;
            Ok::<(), anyhow::Error>(())
        };
        let result = tokio::time::timeout(
            Duration::from_millis(self.cfg.job_timeout_public_ranking_ms),
            tick,
        )
        .await;
        owned.release().await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(anyhow::anyhow!(
                "public ranking refresh timed out after {}ms",
                self.cfg.job_timeout_public_ranking_ms
            )),
        }
    }

    async fn get_public_cached_for_me(
        &self,
        fresh: bool,
    ) -> anyhow::Result<PublicMiningRankingPayload> {
        let now = now_ms();
        if !fresh {
            let guard = self.my_rank_cache.lock().await;
            if let Some((at, ref payload)) = *guard {
                if now.saturating_sub(at) < self.cfg.my_rank_cache_ttl_ms {
                    return Ok(payload.clone());
                }
            }
        }
        let payload = self.get_public(false).await?;
        *self.my_rank_cache.lock().await = Some((now, payload.clone()));
        Ok(payload)
    }

    async fn compute_and_cache(&self, force: bool) -> anyhow::Result<PublicMiningRankingPayload> {
        let _compute_guard = self.compute_lock.lock().await;

        if !force {
            // Another waiter may have filled Redis / local while we queued.
            if self.locks.has_redis() {
                if let Ok(Some(raw)) = self.locks.get_string(RANKING_REDIS_KEY).await {
                    if let Ok(payload) = serde_json::from_str::<PublicMiningRankingPayload>(&raw) {
                        *self.local_fallback.lock().await = Some((now_ms(), payload.clone()));
                        return Ok(payload);
                    }
                }
            }
            {
                let now = now_ms();
                let guard = self.local_fallback.lock().await;
                if let Some((at, ref payload)) = *guard {
                    if now.saturating_sub(at) < RANKING_LOCAL_FALLBACK_TTL_MS {
                        return Ok(payload.clone());
                    }
                }
            }
        }

        let payload = self.compute_public_uncached().await?;

        *self.local_fallback.lock().await = Some((now_ms(), payload.clone()));
        if self.locks.has_redis() {
            match serde_json::to_string(&payload) {
                Ok(json) => {
                    if let Err(e) = self
                        .locks
                        .set_ex(RANKING_REDIS_KEY, &json, self.cfg.ranking_redis_ttl_seconds)
                        .await
                    {
                        warn!(err = %e, "ranking redis SET failed");
                    }
                }
                Err(e) => warn!(err = %e, "ranking serialize failed"),
            }
        }
        Ok(payload)
    }

    async fn compute_public_uncached(&self) -> anyhow::Result<PublicMiningRankingPayload> {
        let scan = self.load_scan_data().await?;
        let username_by_id: HashMap<i64, String> = scan.eligible_users.iter().cloned().collect();
        let mut ranking_data: HashMap<i64, PublicRankingUser> = HashMap::new();
        accumulate_ranking_power_from_racks(
            &mut ranking_data,
            &scan.racks,
            &scan.slots_by_rack,
            &scan.mult_by_rack,
            &scan.upgrades_mining,
            &scan.nft_room_ids,
            &scan.asic_room_ids,
            &username_by_id,
        );
        Ok(PublicMiningRankingPayload {
            timestamp: now_ms() as i64,
            ranking: ranking_data.into_values().collect(),
            coins: scan.coins,
        })
    }

    async fn load_scan_data(&self) -> anyhow::Result<RankingScanData> {
        let client = self.pool.get().await.context("pg pool")?;

        let coin_rows = client
            .query("SELECT id, name, symbol FROM mining_coins", &[])
            .await
            .context("mining_coins")?;
        let coins: Vec<CoinLite> = coin_rows
            .iter()
            .map(|r| CoinLite {
                id: r.get("id"),
                name: r.try_get("name").unwrap_or_default(),
                symbol: r.try_get("symbol").unwrap_or_default(),
            })
            .collect();

        let ups_rows = client
            .query(
                "SELECT id, type, category, base_production, multiplier, nft_mining_coin_id FROM upgrades",
                &[],
            )
            .await
            .context("upgrades")?;
        let mut upgrades_mining: HashMap<String, CalculatorUpgradeLite> = HashMap::new();
        for row in &ups_rows {
            let id: String = row.get("id");
            upgrades_mining.insert(
                id.clone(),
                CalculatorUpgradeLite {
                    id,
                    upgrade_type: row.try_get("type").unwrap_or_default(),
                    category: row.try_get("category").ok(),
                    base_production: row_f64(row, "base_production"),
                    multiplier: row
                        .try_get::<_, f64>("multiplier")
                        .ok()
                        .or_else(|| row.try_get::<_, i32>("multiplier").ok().map(|v| v as f64)),
                    power_capacity: None,
                    nft_mining_coin_id: row.try_get("nft_mining_coin_id").ok(),
                },
            );
        }

        let nft_room_ids = resolve_nft_auto_room_ids(std::ops::Deref::deref(&*client)).await?;
        let asic_room_ids = resolve_asic_room_ids(std::ops::Deref::deref(&*client)).await?;

        let user_rows = client
            .query(
                "SELECT id, username FROM users WHERE is_blocked = 0 AND ranking_excluded = 0",
                &[],
            )
            .await
            .context("eligible users")?;
        let eligible_users: Vec<(i64, String)> = user_rows
            .iter()
            .map(|r| (row_user_id(r), r.try_get("username").unwrap_or_default()))
            .collect();
        let eligible_ids: Vec<i32> = eligible_users
            .iter()
            .filter_map(|(id, _)| i32::try_from(*id).ok())
            .collect();

        let racks = if eligible_ids.is_empty() {
            Vec::new()
        } else {
            let rack_rows = client
                .query(
                    r#"SELECT id, user_id, item_id, selected_coin_id, room_id
                         FROM placed_racks
                        WHERE is_on = 1
                          AND user_id = ANY($1)
                          AND wiring_id IS NOT NULL
                          AND battery_id IS NOT NULL"#,
                    &[&eligible_ids],
                )
                .await
                .context("placed_racks")?;
            rack_rows
                .iter()
                .map(|r| RankingRackInput {
                    id: r.get("id"),
                    user_id: row_user_id(r),
                    item_id: opt_string(r, "item_id"),
                    selected_coin_id: opt_string(r, "selected_coin_id"),
                    room_id: opt_string(r, "room_id"),
                })
                .collect()
        };

        let rack_ids: Vec<String> = racks.iter().map(|r| r.id.clone()).collect();
        let (slots_by_rack, mult_by_rack) = if rack_ids.is_empty() {
            (HashMap::new(), HashMap::new())
        } else {
            let slot_rows = client
                .query(
                    "SELECT rack_id, machine_item_id FROM rack_slots WHERE rack_id = ANY($1)",
                    &[&rack_ids],
                )
                .await
                .context("rack_slots")?;
            let mult_rows = client
                .query(
                    "SELECT rack_id, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1)",
                    &[&rack_ids],
                )
                .await
                .context("rack_multiplier_slots")?;

            let mut slots_by_rack: HashMap<String, Vec<Option<String>>> = HashMap::new();
            for s in &slot_rows {
                let rack_id: String = s.get("rack_id");
                let mid: Option<String> = opt_string(s, "machine_item_id");
                slots_by_rack.entry(rack_id).or_default().push(mid);
            }
            let mut mult_by_rack: HashMap<String, Vec<Option<String>>> = HashMap::new();
            for m in &mult_rows {
                let rack_id: String = m.get("rack_id");
                let mid: Option<String> = opt_string(m, "multiplier_item_id");
                mult_by_rack.entry(rack_id).or_default().push(mid);
            }
            (slots_by_rack, mult_by_rack)
        };

        Ok(RankingScanData {
            coins,
            upgrades_mining,
            nft_room_ids,
            asic_room_ids,
            eligible_users,
            racks,
            slots_by_rack,
            mult_by_rack,
        })
    }
}

/// Spawn the public-ranking refresh loop (parallel to yield cron).
pub async fn run_ranking_refresh_loop(service: RankingService, cfg: WorkerConfig) {
    if !cfg.ranking_loop_active() {
        info!(
            event = "ranking_disabled",
            reason = "SCHEDULER_ENABLED=0 or RANKING_REFRESH_LOOP_ENABLED=0",
            "ranking refresh idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        interval_ms = cfg.ranking_refresh_interval_ms,
        redis_ttl_sec = cfg.ranking_redis_ttl_seconds,
        lock = crate::config::REDIS_LOCK_JOB_PUBLIC_RANKING,
        "public ranking refresh scheduled"
    );

    // Immediate tick (Node `void runner.tick()` before setInterval).
    if let Err(e) = service.run_refresh_tick().await {
        warn!(err = %e, "ranking initial refresh failed");
    }

    let mut interval =
        tokio::time::interval(Duration::from_millis(cfg.ranking_refresh_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate first interval tick (we already ran above).
    interval.tick().await;

    loop {
        interval.tick().await;
        match service.run_refresh_tick().await {
            Ok(()) => info!(event = "health", "ranking worker healthy"),
            Err(e) => warn!(err = %e, "ranking refresh failed"),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn row_f64(row: &tokio_postgres::Row, col: &str) -> f64 {
    row.try_get::<_, f64>(col)
        .ok()
        .or_else(|| row.try_get::<_, i32>(col).ok().map(|v| v as f64))
        .or_else(|| row.try_get::<_, i64>(col).ok().map(|v| v as f64))
        .unwrap_or(0.0)
}

fn row_user_id(row: &tokio_postgres::Row) -> i64 {
    row.try_get::<_, i32>("user_id")
        .map(|v| v as i64)
        .or_else(|_| row.try_get::<_, i64>("user_id"))
        .or_else(|_| row.try_get::<_, i32>("id").map(|v| v as i64))
        .or_else(|_| row.try_get::<_, i64>("id"))
        .unwrap_or(0)
}

fn opt_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    row.try_get::<_, Option<String>>(col)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<_, String>(col).ok())
        .filter(|s| !s.is_empty())
}
