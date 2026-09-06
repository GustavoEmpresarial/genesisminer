//! Yield cron tick — port of `executeMiningYieldTick` from
//! `server/modules/mining-engine/services/yield-cron.ts`.
//!
//! Math: `genesis_core::mining` + `genesis_core::calculator::slot_credits`.
//! I/O: Postgres + Redis lock.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Instant;

use anyhow::Context;
use deadpool_postgres::Pool;
use genesis_core::calculator::nft::is_independent_network_pool_mining_coin_ref;
use genesis_core::calculator::slot_credits::list_slot_mining_credits;
use genesis_core::calculator::types::{CalculatorUpgradeLite, MiningCoinInput};
use genesis_core::mining::{
    build_yield_history_rows_for_boundary, last_completed_ten_minute_utc_grid,
    list_pending_ten_minute_boundaries, CoinYieldInput,
};
use serde_json::json;
use tokio_postgres::types::ToSql;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, HISTORY_RETENTION_MS, MAX_YIELD_CATCHUP_BOUNDARIES_PER_TICK,
    MINING_YIELD_HISTORY_INSERT_SQL, RACK_SCAN_BATCH_SIZE, SLOW_TICK_LOG_THRESHOLD_MS,
};
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

static LAST_YIELD_HISTORY_BOUNDARY_MS: AtomicI64 = AtomicI64::new(0);
static YIELD_HISTORY_BOUNDARY_HYDRATED: AtomicBool = AtomicBool::new(false);

struct RackRow {
    selected_coin_id: Option<String>,
    id: String,
    user_id: i64,
    item_id: Option<String>,
    room_id: Option<String>,
    username: Option<serde_json::Value>,
}

struct UserStat {
    user_id: i64,
    username: Option<serde_json::Value>,
    coins: HashMap<String, f64>,
    general_power: f64,
}

pub async fn run_yield_tick(
    pool: &Pool,
    locks: &RedisLockClient,
    cfg: &WorkerConfig,
) -> anyhow::Result<()> {
    let handle = locks.try_acquire_mining_yield_tick().await?;
    let Some(handle) = handle else {
        info!(event = "lock_busy", "mining yield tick skipped — lock held");
        return Ok(());
    };

    // Owned guard: Drop releases even if outer `tokio::time::timeout` cancels this future.
    let guard = OwnedYieldTickLock::new(locks.clone(), handle);
    let result = execute_mining_yield_tick(pool, cfg).await;
    guard.release().await;
    result
}

async fn execute_mining_yield_tick(pool: &Pool, cfg: &WorkerConfig) -> anyhow::Result<()> {
    let tick_start = Instant::now();
    let client = pool.get().await.context("pg pool get")?;

    hydrate_yield_history_boundary(&*client, cfg.ten_minute_grid_enabled).await?;

    let active_sql = r#"
      SELECT pr.selected_coin_id, pr.id, pr.user_id, pr.item_id, pr.battery_id, pr.room_id, u.username
      FROM placed_racks pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.is_on = 1
      AND pr.wiring_id IS NOT NULL
      AND pr.battery_id IS NOT NULL
      AND u.is_blocked = 0
      AND u.ranking_excluded = 0
    "#;
    let ups_sql =
        "SELECT id, type, category, base_production, multiplier, nft_mining_coin_id FROM upgrades";
    let coins_sql =
        "SELECT id, symbol, nft_room_only, block_reward, block_time, network_hashrate FROM mining_coins WHERE is_active = 1";

    let active_rows = client
        .query(active_sql, &[])
        .await
        .context("active racks")?;
    let ups_rows = client.query(ups_sql, &[]).await.context("upgrades")?;
    let coin_rows = client.query(coins_sql, &[]).await.context("mining_coins")?;
    let nft_room_ids = resolve_nft_auto_room_ids(std::ops::Deref::deref(&*client)).await?;
    let asic_room_ids = resolve_asic_room_ids(std::ops::Deref::deref(&*client)).await?;

    let mut ups_map: HashMap<String, CalculatorUpgradeLite> = HashMap::new();
    for row in &ups_rows {
        let id: String = row.get("id");
        let upgrade_type: String = row.try_get("type").unwrap_or_default();
        let category: Option<String> = row.try_get("category").ok();
        let base_production: f64 = row
            .try_get::<_, f64>("base_production")
            .or_else(|_| row.try_get::<_, i32>("base_production").map(|v| v as f64))
            .unwrap_or(0.0);
        let multiplier: Option<f64> = row
            .try_get::<_, f64>("multiplier")
            .ok()
            .or_else(|| row.try_get::<_, i32>("multiplier").ok().map(|v| v as f64));
        let nft_mining_coin_id: Option<String> = row.try_get("nft_mining_coin_id").ok();
        ups_map.insert(
            id.clone(),
            CalculatorUpgradeLite {
                id,
                upgrade_type,
                category,
                base_production,
                multiplier,
                power_capacity: None,
                nft_mining_coin_id,
            },
        );
    }

    let active_coin_ids: HashSet<String> =
        coin_rows.iter().map(|r| r.get::<_, String>("id")).collect();

    let racks: Vec<RackRow> = active_rows
        .iter()
        .map(|r| RackRow {
            selected_coin_id: r.try_get("selected_coin_id").ok(),
            id: r.get("id"),
            user_id: {
                // users.id may be int4 or int8 depending on schema
                r.try_get::<_, i64>("user_id")
                    .or_else(|_| r.try_get::<_, i32>("user_id").map(|v| v as i64))
                    .unwrap_or(0)
            },
            item_id: r.try_get("item_id").ok(),
            room_id: r.try_get("room_id").ok(),
            username: r
                .try_get::<_, serde_json::Value>("username")
                .ok()
                .or_else(|| {
                    r.try_get::<_, String>("username")
                        .ok()
                        .map(serde_json::Value::String)
                }),
        })
        .collect();

    let active_rack_ids: Vec<String> = racks.iter().map(|r| r.id.clone()).collect();
    let (slot_rows, multi_rows) = if active_rack_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let slot_rows = client
            .query(
                "SELECT rack_id, machine_item_id FROM rack_slots WHERE rack_id = ANY($1)",
                &[&active_rack_ids],
            )
            .await
            .context("rack_slots")?;
        let multi_rows = client
            .query(
                "SELECT rack_id, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1)",
                &[&active_rack_ids],
            )
            .await
            .context("rack_multiplier_slots")?;
        (slot_rows, multi_rows)
    };

    let mut slots_map: HashMap<String, Vec<Option<String>>> = HashMap::new();
    for s in &slot_rows {
        let rid: String = s.get("rack_id");
        let mid: String = s.get("machine_item_id");
        slots_map.entry(rid).or_default().push(Some(mid));
    }
    let mut multi_map: HashMap<String, Vec<Option<String>>> = HashMap::new();
    for m in &multi_rows {
        let rid: String = m.get("rack_id");
        let mid: String = m.get("multiplier_item_id");
        multi_map.entry(rid).or_default().push(Some(mid));
    }

    let mut real_network: HashMap<String, f64> = HashMap::new();
    let mut active_users: HashSet<i64> = HashSet::new();
    let mut active_users_by_coin: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut user_stats: HashMap<i64, UserStat> = HashMap::new();

    for chunk in racks.chunks(RACK_SCAN_BATCH_SIZE) {
        for rack in chunk {
            let room_id = rack.room_id.as_deref();
            let empty_slots: Vec<Option<String>> = Vec::new();
            let slots = slots_map.get(&rack.id).unwrap_or(&empty_slots);
            let multis = multi_map.get(&rack.id).unwrap_or(&empty_slots);
            let selected = rack.selected_coin_id.as_deref().unwrap_or("");
            let credits = list_slot_mining_credits(
                room_id,
                slots,
                multis,
                &ups_map,
                selected,
                Some(&nft_room_ids),
                rack.item_id.as_deref(),
                Some(&asic_room_ids),
            );
            if credits.is_empty() {
                continue;
            }
            for sc in credits {
                if !active_coin_ids.contains(&sc.coin_id) {
                    continue;
                }
                let power = sc.effective_base_prod;
                if !power.is_finite() || power <= 0.0 {
                    continue;
                }
                *real_network.entry(sc.coin_id.clone()).or_insert(0.0) += power;
                active_users.insert(rack.user_id);
                active_users_by_coin
                    .entry(sc.coin_id.clone())
                    .or_default()
                    .insert(rack.user_id);

                let u = user_stats.entry(rack.user_id).or_insert_with(|| UserStat {
                    user_id: rack.user_id,
                    username: rack.username.clone(),
                    coins: HashMap::new(),
                    general_power: 0.0,
                });
                *u.coins.entry(sc.coin_id.clone()).or_insert(0.0) += power;
                if sc.counts_toward_general_power {
                    u.general_power += power;
                }
            }
        }
        // Cooperative yield between batches (mirrors setImmediate in TS).
        tokio::task::yield_now().await;
    }

    let coin_totals: HashMap<String, f64> = real_network.clone();
    let mut ranking: Vec<serde_json::Value> = user_stats
        .values()
        .filter(|u| !u.coins.is_empty())
        .map(|u| {
            json!({
                "user_id": u.user_id,
                "username": u.username,
                "coins": u.coins,
                "generalPower": u.general_power,
                "totalPower": u.general_power,
            })
        })
        .collect();
    ranking.sort_by(|a, b| {
        let ap = a.get("totalPower").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bp = b.get("totalPower").and_then(|v| v.as_f64()).unwrap_or(0.0);
        bp.partial_cmp(&ap).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut active_miners_by_coin: HashMap<String, usize> = HashMap::new();
    for (cid, set) in &active_users_by_coin {
        active_miners_by_coin.insert(cid.clone(), set.len());
    }
    let total_active_users = ranking.len();
    let network_stats = json!({
        "hashrates": coin_totals,
        "activeMiners": total_active_users,
        "activeMinersByCoin": active_miners_by_coin,
        "ranking": ranking,
    });

    if let Err(e) = client
        .execute(
            r#"
        INSERT INTO app_cache (key, value, updated_at)
        VALUES ('network_stats', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
      "#,
            &[&network_stats],
        )
        .await
    {
        warn!(err = %e, "app_cache network_stats write failed");
    }

    let wall_at_ms = now_ms();
    let coins: Vec<CoinYieldInput> = coin_rows
        .iter()
        .map(|r| {
            let id: String = r.get("id");
            let symbol: String = r.try_get("symbol").unwrap_or_default();
            let nft_room_only = row_flag_nonzero(r, "nft_room_only");
            let block_reward = row_f64(r, "block_reward");
            let block_time = row_f64(r, "block_time");
            let network_hashrate = row_f64(r, "network_hashrate");
            let independent_pool = is_independent_network_pool_mining_coin_ref(&MiningCoinInput {
                id: id.clone(),
                symbol: symbol.clone(),
                name: symbol,
                network_hashrate,
                block_reward,
                block_time,
                price_usd: 0.0,
                usdc_rate: 0.0,
                nft_room_only,
            });
            CoinYieldInput {
                id,
                block_reward,
                block_time,
                network_hashrate,
                independent_pool,
            }
        })
        .collect();

    if cfg.ten_minute_grid_enabled {
        let checkpoint = LAST_YIELD_HISTORY_BOUNDARY_MS.load(Ordering::Relaxed) as f64;
        let cap = last_completed_ten_minute_utc_grid(wall_at_ms) as f64;
        let pending_all = list_pending_ten_minute_boundaries(checkpoint, cap);
        let pending: Vec<i64> = pending_all
            .into_iter()
            .take(MAX_YIELD_CATCHUP_BOUNDARIES_PER_TICK)
            .collect();

        if pending.len() > 1 {
            info!(
                event = "catch_up",
                pending = pending.len(),
                from = pending.first().copied().unwrap_or(0),
                to = pending.last().copied().unwrap_or(0),
                checkpoint_before = checkpoint as i64,
                cap = cap as i64,
                "mining yield catch-up"
            );
        }

        for boundary in pending {
            insert_yield_history_boundary(&*client, &coins, &real_network, boundary as f64)
                .await
                .with_context(|| format!("boundary {boundary}"))?;
            LAST_YIELD_HISTORY_BOUNDARY_MS.store(boundary, Ordering::Relaxed);
        }
    } else {
        insert_yield_history_boundary(&*client, &coins, &real_network, wall_at_ms as f64).await?;
    }

    let retention = now_ms() - HISTORY_RETENTION_MS;
    if let Err(e) = client
        .execute(
            "DELETE FROM mining_yield_history WHERE effective_at < $1",
            &[&retention],
        )
        .await
    {
        warn!(err = %e, "retention delete failed");
    }

    let duration_ms = tick_start.elapsed().as_millis() as u64;
    if duration_ms > SLOW_TICK_LOG_THRESHOLD_MS {
        warn!(
            event = "slow_tick",
            duration_ms,
            rack_count = racks.len(),
            active_users = total_active_users,
            "mining yield tick slow"
        );
    } else {
        info!(
            event = "tick_ok",
            duration_ms,
            rack_count = racks.len(),
            active_users = total_active_users,
            yield_history_boundary = if cfg.ten_minute_grid_enabled {
                Some(LAST_YIELD_HISTORY_BOUNDARY_MS.load(Ordering::Relaxed))
            } else {
                None
            },
            "mining yield tick"
        );
    }

    Ok(())
}

async fn hydrate_yield_history_boundary(
    client: &tokio_postgres::Client,
    grid_enabled: bool,
) -> anyhow::Result<()> {
    if !grid_enabled || YIELD_HISTORY_BOUNDARY_HYDRATED.load(Ordering::Relaxed) {
        return Ok(());
    }
    match client
        .query_opt(
            "SELECT (MAX(effective_at))::float8 AS m FROM mining_yield_history WHERE effective_at IS NOT NULL",
            &[],
        )
        .await
    {
        Ok(Some(row)) => {
            let raw: Option<f64> = row.try_get("m").ok();
            if let Some(mx) = raw.filter(|v| v.is_finite() && *v > 0.0) {
                let grid = last_completed_ten_minute_utc_grid(mx as i64);
                LAST_YIELD_HISTORY_BOUNDARY_MS.store(grid, Ordering::Relaxed);
            }
            YIELD_HISTORY_BOUNDARY_HYDRATED.store(true, Ordering::Relaxed);
        }
        Ok(None) => {
            YIELD_HISTORY_BOUNDARY_HYDRATED.store(true, Ordering::Relaxed);
        }
        Err(e) => {
            warn!(err = %e, "hydrate yield boundary (retry next tick)");
        }
    }
    Ok(())
}

async fn insert_yield_history_boundary(
    client: &tokio_postgres::Client,
    coins: &[CoinYieldInput],
    real_network: &HashMap<String, f64>,
    effective_at_ms: f64,
) -> anyhow::Result<()> {
    let rows = build_yield_history_rows_for_boundary(coins, real_network, effective_at_ms);
    if rows.coin_ids.is_empty() {
        return Ok(());
    }
    let effectives: Vec<i64> = rows.effectives.iter().map(|v| *v as i64).collect();
    let params: [&(dyn ToSql + Sync); 5] = [
        &rows.coin_ids,
        &rows.yields,
        &rows.rewards,
        &rows.net_hashes,
        &effectives,
    ];
    match client
        .execute(MINING_YIELD_HISTORY_INSERT_SQL, &params)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if is_pg_unique_violation(&e) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn is_pg_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code().map(|c| c.code() == "23505").unwrap_or(false)
}

fn row_f64(row: &tokio_postgres::Row, col: &str) -> f64 {
    row.try_get::<_, f64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(|v| v as f64))
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v as f64))
        .unwrap_or(0.0)
}

/// `nft_room_only` na BD é int 0/1 (alguns schemas bool).
fn row_flag_nonzero(row: &tokio_postgres::Row, col: &str) -> bool {
    row.try_get::<_, i32>(col)
        .map(|v| v != 0)
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v != 0))
        .or_else(|_| row.try_get::<_, bool>(col))
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
