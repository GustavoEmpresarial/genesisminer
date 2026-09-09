//! Progress credit I/O — port of r#"computeProgressForUser"# from
//! r#"server/modules/mining-engine/services/progress-computer.ts"#.
//!
//! Math: r#"genesis_core::mining"# + calculator slot credits / checkin bonus.
//! I/O: Postgres TX + Redis per-user lock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Context;
use deadpool_postgres::Pool;
use genesis_core::calculator::checkin_bonus::{
    effective_hash_with_checkin_bonus, sum_non_nft_room_rig_hash_hps,
};
use genesis_core::calculator::nft::{
    is_independent_network_pool_mining_coin_ref, is_nft_mining_room_id,
    resolve_mining_coin_usd_rate,
};
use genesis_core::calculator::slot_credits::list_slot_mining_credits;
use genesis_core::calculator::types::{CalculatorUpgradeLite, CheckinHashEntry, MiningCoinInput};
use genesis_core::checkin::{
    is_checkin_frozen_for_mining, DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
    DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
};
use genesis_core::gerente::{ACCOUNT_MANAGER_SHARE, ACCOUNT_MANAGER_STATUS_ACTIVE};
use genesis_core::mining::effective_network_hashrate_for_coin;
use genesis_core::mining::{
    amounts_almost_equal, assert_tick_history_matches_economy,
    build_mining_block_history_rows_for_credit, calculate_integrated_yield,
    consolidate_mining_block_history_rows, mining_credit_cap_now_ms, BuildHistoryRowsOpts,
    MiningBlockHistoryInsertRow, YieldHistPoint,
};
use genesis_core::time::MS_PER_SECOND;
use genesis_core::utc_week::utc_week_start_ms;
use serde::Serialize;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, CLOCK_SKEW_ALLOW_MS, IDEMPOTENCY_KEY_MAX_LENGTH, MAX_EARNING_WINDOW_MS,
    MINED_COIN_AMOUNT_DECIMALS, PG_INVALID_COLUMN_REFERENCE, PG_UNDEFINED_COLUMN,
    PG_UNDEFINED_TABLE, PROGRESS_TX_TIMEOUT_MS, YIELD_HISTORY_LOOKBACK_MS,
};
use crate::redis_lock::{mining_progress_user_lock_key, RedisLockClient};
use crate::room_ids::{resolve_asic_room_ids, resolve_nft_auto_room_ids};

static LEDGER_SCHEMA_WARNED: AtomicBool = AtomicBool::new(false);
static BLOCK_HISTORY_SCHEMA_WARNED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_mined: Option<HashMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_recent: Option<bool>,
}

impl ProgressResult {
    fn ok_empty() -> Self {
        Self {
            ok: true,
            offline_mined: None,
            error: None,
            skipped_recent: None,
        }
    }

    fn ok_mined(offline: HashMap<String, f64>) -> Self {
        Self {
            ok: true,
            offline_mined: Some(offline),
            error: None,
            skipped_recent: None,
        }
    }

    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            offline_mined: None,
            error: Some(msg.into()),
            skipped_recent: None,
        }
    }
}

struct EconomyMeta {
    network_hashrate: f64,
    block_reward: f64,
    block_time: f64,
}

struct RackUpdate {
    id: String,
    is_on: i32,
    prev_is_on: i32,
}

/// Port of r#"computeProgressForUser"# (happy path: balances + last_updated + history).
pub async fn compute_progress_for_user(
    pool: &Pool,
    locks: &RedisLockClient,
    cfg: &WorkerConfig,
    kafka: &crate::kafka::KafkaBus,
    user_id: i64,
) -> ProgressResult {
    if user_id <= 0 {
        warn!(user_id, "progress: invalid user id");
        return ProgressResult::err("invalid user");
    }

    if !cfg.mining_progress_compute_enabled {
        info!(
            user_id,
            "progress: compute disabled (MINING_PROGRESS_COMPUTE_ENABLED=0)"
        );
        return ProgressResult::ok_empty();
    }

    if cfg.mining_progress_require_redis_lock && !locks.locks_effective() {
        warn!(
            user_id,
            "progress: skipped (MINING_PROGRESS_REQUIRE_REDIS_LOCK without effective Redis locks)"
        );
        return ProgressResult::ok_empty();
    }

    let wall_clock = now_ms();
    let mut server_now = wall_clock;
    if server_now > wall_clock + CLOCK_SKEW_ALLOW_MS {
        warn!(
            user_id,
            skew_ms = server_now - wall_clock,
            "progress: now clamped (future skew)"
        );
        server_now = wall_clock;
    }

    let credit_cap = mining_credit_cap_now_ms(server_now, cfg.ten_minute_grid_enabled);

    let lock_key = mining_progress_user_lock_key(user_id);
    let dist_lock = match locks
        .try_acquire(&lock_key, cfg.mining_progress_lock_ttl_sec)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(user_id, "progress: skipped (redis lock held)");
            return ProgressResult::ok_empty();
        }
        Err(e) => {
            warn!(user_id, err = %e, "progress: redis lock acquire failed");
            return ProgressResult::err(format!("redis lock: {e}"));
        }
    };

    let result = compute_progress_locked(pool, cfg, kafka, user_id, server_now, credit_cap).await;
    locks.release(Some(dist_lock)).await;
    result
}

async fn compute_progress_locked(
    pool: &Pool,
    cfg: &WorkerConfig,
    kafka: &crate::kafka::KafkaBus,
    user_id: i64,
    server_now: i64,
    credit_cap: i64,
) -> ProgressResult {
    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => return ProgressResult::err(format!("pg pool: {e}")),
    };

    let mut in_tx = false;
    match compute_progress_inner(
        &*client, cfg, kafka, user_id, server_now, credit_cap, &mut in_tx,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            if in_tx {
                let _ = client.batch_execute("ROLLBACK").await;
            }
            let err_full = format!("{e:#}");
            warn!(user_id, err = %err_full, "progress: error");
            ProgressResult::err(truncate_err(&err_full))
        }
    }
}

async fn compute_progress_inner(
    client: &tokio_postgres::Client,
    cfg: &WorkerConfig,
    kafka: &crate::kafka::KafkaBus,
    user_id: i64,
    server_now: i64,
    credit_cap: i64,
    in_tx: &mut bool,
) -> anyhow::Result<ProgressResult> {
    // PG columns `users.id` / `*.user_id` are int4 — tokio-postgres bind must be i32.
    let user_id_i32: i32 = i32::try_from(user_id)
        .map_err(|_| anyhow::anyhow!("user_id out of int4 range: {user_id}"))?;

    let coin_active_rows = client
        .query("SELECT id, is_active FROM mining_coins", &[])
        .await
        .context("mining_coins active map")?;
    let mut coin_map: HashMap<String, bool> = HashMap::new();
    for row in &coin_active_rows {
        let id: String = row.get("id");
        let active = row_i32(row, "is_active") == 1;
        coin_map.insert(id, active);
    }
    let coin_ids: Vec<String> = coin_map.keys().cloned().collect();

    let nft_room_ids = resolve_nft_auto_room_ids(client).await?;
    let asic_room_ids = resolve_asic_room_ids(client).await?;

    let mut fallback_yield: HashMap<String, f64> = HashMap::new();
    let mut usd_rate_by_coin: HashMap<String, f64> = HashMap::new();
    let mut economy_meta: HashMap<String, EconomyMeta> = HashMap::new();

    let live_hashrates = load_live_network_hashrates(client).await;

    if !coin_ids.is_empty() {
        let economy_rows = client
            .query(
                "SELECT id, symbol, block_reward, block_time, network_hashrate, usdc_rate, price_usd, name,
                        nft_room_only, distribution_mode, distribution_usd_month
                   FROM mining_coins WHERE id = ANY($1) AND is_active = 1",
                &[&coin_ids],
            )
            .await
            .context("mining_coins economy")?;
        let empty_implied = HashMap::new();
        for coin in &economy_rows {
            let coin_id: String = coin.get("id");
            let block_reward = row_f64(coin, "block_reward");
            let block_time = row_f64(coin, "block_time");
            let configured = row_f64(coin, "network_hashrate");
            let symbol: String = coin.try_get("symbol").unwrap_or_default();
            let name: String = coin.try_get("name").unwrap_or_default();
            let usdc_rate = row_f64(coin, "usdc_rate");
            let price_usd = row_f64(coin, "price_usd");
            let nft_room_only = row_i32(coin, "nft_room_only") != 0;
            let distribution_mode = genesis_core::mining::DistributionMode::parse(
                &coin
                    .try_get::<_, Option<String>>("distribution_mode")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            );
            let distribution_usd_month = row_f64(coin, "distribution_usd_month");
            let coin_input_for_flag = MiningCoinInput {
                id: coin_id.clone(),
                symbol: symbol.clone(),
                name: name.clone(),
                network_hashrate: configured,
                block_reward,
                block_time,
                price_usd,
                usdc_rate,
                nft_room_only,
                distribution_mode: Default::default(),
                distribution_usd_month: 0.0,
            };
            let independent_pool =
                is_independent_network_pool_mining_coin_ref(&coin_input_for_flag);
            let effective_hashrate = effective_network_hashrate_for_coin(
                &coin_id,
                configured,
                &live_hashrates,
                &empty_implied,
                independent_pool,
            );
            // `fallback` só é usado quando não há linha de `mining_yield_history`
            // cobrindo a janela de crédito (gap > lookback ou moeda recém-criada).
            let fallback = if distribution_mode == genesis_core::mining::DistributionMode::UsdMonth {
                // Divisor com hashrate live (levemente stale) e clamp no piso —
                // mesma fórmula do boundary; 0 se hashrate desconhecido.
                let active = live_hashrates
                    .get(&coin_id)
                    .copied()
                    .filter(|v| v.is_finite() && *v > 0.0)
                    .unwrap_or(0.0);
                genesis_core::mining::usd_month_yield(distribution_usd_month, price_usd, active).0
            } else {
                let reward_per_sec = if block_time > 0.0 {
                    block_reward / block_time
                } else {
                    0.0
                };
                if effective_hashrate > 0.0 {
                    reward_per_sec / effective_hashrate
                } else {
                    0.0
                }
            };
            fallback_yield.insert(
                coin_id.clone(),
                if fallback.is_finite() && fallback > 0.0 {
                    fallback
                } else {
                    0.0
                },
            );
            let coin_input = MiningCoinInput {
                id: coin_id.clone(),
                symbol,
                name,
                network_hashrate: effective_hashrate,
                block_reward,
                block_time,
                price_usd,
                usdc_rate,
                nft_room_only,
                distribution_mode: Default::default(),
                distribution_usd_month: 0.0,
            };
            let usd = resolve_mining_coin_usd_rate(&coin_input);
            if usd > 0.0 {
                usd_rate_by_coin.insert(coin_id.clone(), usd);
            }
            economy_meta.insert(
                coin_id,
                EconomyMeta {
                    network_hashrate: effective_hashrate,
                    block_reward,
                    block_time,
                },
            );
        }
    }

    let ups_rows = client
        .query(
            "SELECT id, type, category, base_production, multiplier, nft_mining_coin_id FROM upgrades",
            &[],
        )
        .await
        .context("upgrades")?;
    let mut ups_map: HashMap<String, CalculatorUpgradeLite> = HashMap::new();
    for row in &ups_rows {
        let id: String = row.get("id");
        ups_map.insert(
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

    let gs_initial = client
        .query_opt(
            r#"SELECT gs.last_updated_at, gs.start_time, gs.last_checkin_at_ms, gs.checkin_bonus_hps,
                    COALESCE(u.is_blocked, 0) AS is_blocked
               FROM game_states gs
               JOIN users u ON u.id = gs.user_id
              WHERE gs.user_id = $1"#,
            &[&user_id_i32],
        )
        .await
        .context("game_states initial")?;
    let Some(gs_initial) = gs_initial else {
        return Ok(ProgressResult::ok_empty());
    };
    if row_i32(&gs_initial, "is_blocked") == 1 {
        return Ok(ProgressResult::ok_empty());
    }

    let last = {
        let lu = row_f64_opt(&gs_initial, "last_updated_at");
        let st = row_f64_opt(&gs_initial, "start_time");
        let v = if lu > 0.0 { lu } else { st };
        if !v.is_finite() || v <= 0.0 {
            return Ok(ProgressResult::ok_empty());
        }
        v
    };

    // Premium weekly check-in — espelha `isCheckinFrozenForUser` (checkin.ts + premium-policy.ts).
    let last_checkin_raw = row_i64_opt(&gs_initial, "last_checkin_at_ms");
    let premium = resolve_premium_weekly_checkin(client, user_id_i32).await;
    let checkin_frozen = is_checkin_frozen_for_mining(
        last_checkin_raw,
        server_now,
        premium.premium_weekly,
        premium.interval_days,
    );

    if (server_now as f64) < last {
        warn!(user_id, "progress: clock behind last_updated");
        return Ok(ProgressResult::ok_empty());
    }
    if (credit_cap as f64) < last {
        return Ok(ProgressResult::ok_empty());
    }

    let mut dt_ms = ((credit_cap as f64) - last).max(0.0);
    let mut last_write = credit_cap as f64;
    if dt_ms > MAX_EARNING_WINDOW_MS as f64 {
        info!(
            user_id,
            dt_ms,
            max_ms = MAX_EARNING_WINDOW_MS,
            "progress: offline backlog discarded (no retroactive credit)"
        );
        // Sem pagamento retroativo: pula o backlog antigo e avança direto para o
        // teto. Credita só os últimos MAX_EARNING_WINDOW_MS — o intervalo entre
        // `last` e `credit_cap - janela` é perdido de propósito.
        dt_ms = MAX_EARNING_WINDOW_MS as f64;
        last_write = credit_cap as f64;
    }
    if !(dt_ms > 0.0) || !dt_ms.is_finite() {
        return Ok(ProgressResult::ok_empty());
    }
    // Início efetivo da integração: `last` no caso normal; `credit_cap - janela`
    // quando o backlog foi descartado. (`last_write - dt_ms` cobre os dois.)
    let credit_start = last_write - dt_ms;

    let history_start = (last - YIELD_HISTORY_LOOKBACK_MS as f64).max(0.0);
    let mut yield_history_map: HashMap<String, Vec<YieldHistPoint>> = HashMap::new();
    if !coin_ids.is_empty() {
        let yh = client
            .query(
                "SELECT coin_id, yield_per_hash, effective_at FROM mining_yield_history
                  WHERE coin_id = ANY($1) AND effective_at >= $2",
                &[&coin_ids, &(history_start as i64)],
            )
            .await
            .context("mining_yield_history")?;
        for row in &yh {
            let cid: String = row.get("coin_id");
            yield_history_map
                .entry(cid)
                .or_default()
                .push(YieldHistPoint {
                    yield_per_hash: row_f64(row, "yield_per_hash"),
                    effective_at: row_f64(row, "effective_at"),
                });
        }
        for hist in yield_history_map.values_mut() {
            hist.sort_by(|a, b| {
                a.effective_at
                    .partial_cmp(&b.effective_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }

    let mut total_gained: HashMap<String, f64> = HashMap::new();
    let mut nft_asic_mined_usd_delta = 0.0;
    let mut rack_updates: Vec<RackUpdate> = Vec::new();
    let mut block_history_rows: Vec<MiningBlockHistoryInsertRow> = Vec::new();

    let racks = if checkin_frozen {
        Vec::new()
    } else {
        client
            .query(
                "SELECT * FROM placed_racks WHERE user_id = $1",
                &[&user_id_i32],
            )
            .await
            .context("placed_racks")?
    };

    let checkin_bonus_hps = row_f64_opt(&gs_initial, "checkin_bonus_hps").max(0.0);

    if !racks.is_empty() {
        let rack_ids: Vec<String> = racks.iter().map(|r| r.get::<_, String>("id")).collect();
        let slot_rows = client
            .query(
                "SELECT rack_id, machine_item_id FROM rack_slots WHERE rack_id = ANY($1)",
                &[&rack_ids],
            )
            .await
            .context("rack_slots")?;
        let multi_rows = client
            .query(
                "SELECT rack_id, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1)",
                &[&rack_ids],
            )
            .await
            .context("rack_multiplier_slots")?;

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

        let empty_slots: Vec<Option<String>> = Vec::new();
        let mut hash_entries: Vec<CheckinHashEntry> = Vec::new();
        for r in &racks {
            if !rack_is_operable(r) {
                continue;
            }
            let rid: String = r.get("id");
            let room_id: Option<String> = r.try_get("room_id").ok();
            let selected: String = r
                .try_get::<_, String>("selected_coin_id")
                .unwrap_or_default();
            let item_id: Option<String> = r.try_get("item_id").ok();
            let credits = list_slot_mining_credits(
                room_id.as_deref(),
                slots_map.get(&rid).unwrap_or(&empty_slots),
                multi_map.get(&rid).unwrap_or(&empty_slots),
                &ups_map,
                &selected,
                Some(&nft_room_ids),
                item_id.as_deref(),
                Some(&asic_room_ids),
            );
            for sc in credits {
                hash_entries.push(CheckinHashEntry {
                    coin_id: sc.coin_id,
                    room_id: room_id.clone(),
                    base_hps: sc.effective_base_prod,
                    counts_toward_general_power: sc.counts_toward_general_power,
                });
            }
        }
        let total_non_nft_rig_hash =
            sum_non_nft_room_rig_hash_hps(&hash_entries, &nft_room_ids, Some(&asic_room_ids));

        for r in &racks {
            if !rack_is_operable(r) {
                continue;
            }
            let rid: String = r.get("id");
            let room_id: Option<String> = r.try_get("room_id").ok();
            let selected: String = r
                .try_get::<_, String>("selected_coin_id")
                .unwrap_or_default();
            let item_id: Option<String> = r.try_get("item_id").ok();
            let slot_credits = list_slot_mining_credits(
                room_id.as_deref(),
                slots_map.get(&rid).unwrap_or(&empty_slots),
                multi_map.get(&rid).unwrap_or(&empty_slots),
                &ups_map,
                &selected,
                Some(&nft_room_ids),
                item_id.as_deref(),
                Some(&asic_room_ids),
            );
            if slot_credits.is_empty() {
                continue;
            }

            // TS: coin && !coin.isActive → power off rack
            let rack_has_inactive = slot_credits
                .iter()
                .any(|sc| coin_map.get(&sc.coin_id).is_some_and(|active| !*active));
            if rack_has_inactive {
                rack_updates.push(RackUpdate {
                    id: rid,
                    is_on: 0,
                    prev_is_on: 1,
                });
                continue;
            }

            let time_avail_ms = dt_ms;
            if !(time_avail_ms > 0.0) {
                continue;
            }
            for sc in &slot_credits {
                let Some(true) = coin_map.get(&sc.coin_id).copied() else {
                    continue;
                };
                let hist = yield_history_map
                    .get(&sc.coin_id)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                let history_yield =
                    calculate_integrated_yield(credit_start, credit_start + time_avail_ms, hist);
                let fallback_rate = fallback_yield.get(&sc.coin_id).copied().unwrap_or(0.0);
                let fallback_y = fallback_rate * (time_avail_ms / MS_PER_SECOND as f64);
                let integrated = if history_yield > 0.0 {
                    history_yield
                } else {
                    fallback_y
                };
                let effective_hash = effective_hash_with_checkin_bonus(
                    sc.effective_base_prod,
                    &sc.coin_id,
                    room_id.as_deref(),
                    checkin_bonus_hps,
                    total_non_nft_rig_hash,
                    &nft_room_ids,
                    Some(&asic_room_ids),
                    Some(sc.counts_toward_general_power),
                );
                let gained = effective_hash * integrated;
                let usd_rate = usd_rate_by_coin.get(&sc.coin_id).copied().unwrap_or(0.0);
                let meta = economy_meta.get(&sc.coin_id);
                if gained.is_finite() && gained > 0.0 {
                    let prev = total_gained.get(&sc.coin_id).copied().unwrap_or(0.0);
                    let next = round_mined_coin_amount(prev + gained);
                    if next > 0.0 {
                        total_gained.insert(sc.coin_id.clone(), next);
                    }
                    block_history_rows.extend(build_mining_block_history_rows_for_credit(
                        BuildHistoryRowsOpts {
                            coin_id: &sc.coin_id,
                            room_id: room_id.as_deref(),
                            interval_start_ms: credit_start,
                            interval_end_ms: credit_start + time_avail_ms,
                            sorted_coin_history: hist,
                            use_history_integration: history_yield > 0.0,
                            fallback_yield_per_hash: fallback_rate,
                            effective_hash,
                            usd_rate,
                            network_hashrate: meta.map(|m| m.network_hashrate).unwrap_or(0.0),
                            block_reward: meta.map(|m| m.block_reward).unwrap_or(0.0),
                            block_time: meta.map(|m| m.block_time).unwrap_or(0.0),
                        },
                    ));
                    if is_nft_mining_room_id(room_id.as_deref(), &nft_room_ids) && usd_rate > 0.0 {
                        nft_asic_mined_usd_delta += gained * usd_rate;
                    }
                }
            }
        }
    }

    // --- TX ---
    client.batch_execute("BEGIN").await.context("BEGIN")?;
    *in_tx = true;
    let timeout_sql = format!(
        "SET LOCAL statement_timeout = {PROGRESS_TX_TIMEOUT_MS}; SET LOCAL lock_timeout = {PROGRESS_TX_TIMEOUT_MS}"
    );
    client
        .batch_execute(&timeout_sql)
        .await
        .context("SET LOCAL timeouts")?;

    let gs_verify = client
        .query_opt(
            r#"SELECT gs.last_updated_at, gs.start_time, COALESCE(u.is_blocked, 0) AS is_blocked
               FROM game_states gs
               JOIN users u ON u.id = gs.user_id
              WHERE gs.user_id = $1
              FOR UPDATE"#,
            &[&user_id_i32],
        )
        .await
        .context("game_states FOR UPDATE")?;
    let Some(gs_verify) = gs_verify else {
        client.batch_execute("ROLLBACK").await.ok();
        *in_tx = false;
        return Ok(ProgressResult::ok_empty());
    };
    if row_i32(&gs_verify, "is_blocked") == 1 {
        client.batch_execute("ROLLBACK").await.ok();
        *in_tx = false;
        return Ok(ProgressResult::ok_empty());
    }
    let last_confirmed = {
        let lu = row_f64_opt(&gs_verify, "last_updated_at");
        let st = row_f64_opt(&gs_verify, "start_time");
        if lu > 0.0 {
            lu
        } else {
            st
        }
    };
    if !last_confirmed.is_finite() || last_confirmed != last {
        client.batch_execute("ROLLBACK").await.ok();
        *in_tx = false;
        info!(user_id, "progress: race avoided (last changed)");
        return Ok(ProgressResult::ok_empty());
    }

    let idempotency_key = {
        let raw = format!(
            "mp:{}:{}:{}",
            user_id,
            last.floor() as i64,
            last_write.floor() as i64
        );
        if raw.len() > IDEMPOTENCY_KEY_MAX_LENGTH {
            raw[..IDEMPOTENCY_KEY_MAX_LENGTH].to_string()
        } else {
            raw
        }
    };

    if cfg.mining_progress_ledger_enabled {
        match insert_progress_ledger(client, user_id_i32, &idempotency_key).await {
            Ok(InsertLedgerOutcome::Inserted) => {}
            Ok(InsertLedgerOutcome::Duplicate) => {
                client.batch_execute("ROLLBACK").await.ok();
                *in_tx = false;
                info!(user_id, key = %idempotency_key, "progress: ledger idempotent skip");
                return Ok(ProgressResult::ok_empty());
            }
            Ok(InsertLedgerOutcome::TableMissing) => {}
            Err(e) => return Err(e),
        }
    }

    let history_to_insert = if block_history_rows.is_empty() {
        Vec::new()
    } else {
        consolidate_mining_block_history_rows(&block_history_rows)
    };

    // Fonte única: saldos = Σ history arredondado (evita mismatch ∫ contínuo vs janelas 10 min).
    if !history_to_insert.is_empty() {
        total_gained.clear();
        for r in &history_to_insert {
            *total_gained.entry(r.coin_id.clone()).or_insert(0.0) += r.amount_coins;
        }
        for amt in total_gained.values_mut() {
            *amt = round_mined_coin_amount(*amt);
        }
        if let Err(e) = assert_tick_history_matches_economy(&total_gained, &history_to_insert) {
            client.batch_execute("ROLLBACK").await.ok();
            *in_tx = false;
            return Ok(ProgressResult::err(truncate_err(&e)));
        }
        match assert_canonical_history_compatible(client, user_id_i32, &history_to_insert).await {
            Ok(()) => {}
            Err(HistoryAssertError::Mismatch(msg) | HistoryAssertError::AlreadyCredited(msg)) => {
                client.batch_execute("ROLLBACK").await.ok();
                *in_tx = false;
                warn!(user_id, %msg, "progress: history abort — no credit");
                return Ok(ProgressResult::err(truncate_err(&msg)));
            }
            Err(HistoryAssertError::TableMissing) => {}
            Err(HistoryAssertError::Other(e)) => return Err(e),
        }
    }

    if !total_gained.is_empty() {
        let c_ids: Vec<String> = total_gained.keys().cloned().collect();
        let c_amts: Vec<f64> = c_ids
            .iter()
            .map(|id| round_mined_coin_amount(total_gained[id]))
            .collect();
        client
            .execute(
                r#"INSERT INTO coin_balances (user_id, coin_id, amount)
                 SELECT $1, unnest($2::text[]), unnest($3::float8[])::numeric
                 ON CONFLICT (user_id, coin_id) DO UPDATE
                   SET amount = coin_balances.amount + EXCLUDED.amount"#,
                &[&user_id_i32, &c_ids, &c_amts],
            )
            .await
            .context("coin_balances credit")?;
        if cfg.account_manager_enabled {
            accrue_manager_mining_share_safe(client, user_id_i32, &c_ids, &c_amts, server_now)
                .await;
        }
    }

    if !history_to_insert.is_empty() {
        insert_block_history(client, user_id_i32, server_now, &history_to_insert).await?;
    }

    if !rack_updates.is_empty() {
        let r_ids: Vec<String> = rack_updates.iter().map(|u| u.id.clone()).collect();
        let r_is_ons: Vec<i32> = rack_updates.iter().map(|u| u.is_on).collect();
        client
            .execute(
                r#"UPDATE placed_racks
                    SET is_on = COALESCE(data.is_on, placed_racks.is_on)
                   FROM (SELECT unnest($1::text[]) as id, unnest($2::int[]) as is_on) as data
                  WHERE placed_racks.id = data.id AND placed_racks.user_id = $3"#,
                &[&r_ids, &r_is_ons, &user_id_i32],
            )
            .await
            .context("placed_racks power-off")?;
        warn!(
            user_id,
            racks = rack_updates.len(),
            prev_is_on = rack_updates.first().map(|u| u.prev_is_on),
            "progress: eligibility rack-power deltas skipped (not ported)"
        );
    }

    let last_write_i = last_write.floor() as i64;
    if nft_asic_mined_usd_delta > 0.0 && nft_asic_mined_usd_delta.is_finite() {
        client
            .execute(
                r#"UPDATE game_states
                    SET last_updated_at = $1,
                        nft_asic_mined_usd_total = COALESCE(nft_asic_mined_usd_total, 0) + $2
                  WHERE user_id = $3"#,
                &[&last_write_i, &nft_asic_mined_usd_delta, &user_id_i32],
            )
            .await
            .context("game_states last_updated + nft usd")?;
    } else {
        client
            .execute(
                "UPDATE game_states SET last_updated_at = $1 WHERE user_id = $2",
                &[&last_write_i, &user_id_i32],
            )
            .await
            .context("game_states last_updated")?;
    }

    client.batch_execute("COMMIT").await.context("COMMIT")?;
    *in_tx = false;

    if !total_gained.is_empty() {
        info!(
            user_id,
            coins = ?total_gained,
            last_write = last_write_i,
            key = %idempotency_key,
            "progress: credited"
        );
    } else if !rack_updates.is_empty() {
        info!(
            user_id,
            racks = rack_updates.len(),
            key = %idempotency_key,
            "progress: commit racks only"
        );
    }

    if kafka.enabled() {
        kafka.publish_mining_progress(user_id).await;
    }

    Ok(ProgressResult::ok_mined(total_gained))
}

enum InsertLedgerOutcome {
    Inserted,
    Duplicate,
    TableMissing,
}

/// Accrual do gerente na mesma TX do crédito ao dono (SAVEPOINT — falha não aborta crédito).
/// Espelho de `accrueManagerMiningShare` + SAVEPOINT em `progress-computer.ts`.
async fn accrue_manager_mining_share_safe(
    client: &tokio_postgres::Client,
    owner_user_id: i32,
    coin_ids: &[String],
    amounts: &[f64],
    server_now: i64,
) {
    if coin_ids.is_empty() {
        return;
    }
    if let Err(e) = client
        .batch_execute("SAVEPOINT mining_progress_accrual_sp")
        .await
    {
        warn!(
            owner_user_id,
            error = %e,
            "progress: account-manager accrual savepoint failed (does not block credit)"
        );
        return;
    }
    match accrue_manager_mining_share(client, owner_user_id, coin_ids, amounts, server_now).await {
        Ok(()) => {
            if let Err(e) = client
                .batch_execute("RELEASE SAVEPOINT mining_progress_accrual_sp")
                .await
            {
                warn!(
                    owner_user_id,
                    error = %e,
                    "progress: account-manager accrual RELEASE failed (does not block credit)"
                );
            }
        }
        Err(e) => {
            client
                .batch_execute(
                    "ROLLBACK TO SAVEPOINT mining_progress_accrual_sp; RELEASE SAVEPOINT mining_progress_accrual_sp",
                )
                .await
                .ok();
            warn!(
                owner_user_id,
                error = %e,
                "progress: account-manager accrual failed (does not block credit)"
            );
        }
    }
}

async fn accrue_manager_mining_share(
    client: &tokio_postgres::Client,
    owner_user_id: i32,
    coin_ids: &[String],
    amounts: &[f64],
    server_now: i64,
) -> anyhow::Result<()> {
    let contract_rows = client
        .query(
            r#"SELECT id, hired_at
                 FROM account_manager_contracts
                WHERE owner_user_id = $1
                  AND status = $2
                LIMIT 1"#,
            &[&owner_user_id, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await
        .context("account_manager_contracts lookup")?;
    let Some(contract) = contract_rows.first() else {
        return Ok(());
    };
    let contract_id: i32 = contract.get("id");
    let hired_at: Option<i64> = contract.get("hired_at");
    let Some(hired_at) = hired_at else {
        return Ok(());
    };
    if server_now < hired_at {
        return Ok(());
    }
    let week_start = utc_week_start_ms(server_now);
    for (coin_id, &amount) in coin_ids.iter().zip(amounts.iter()) {
        if !(amount.is_finite() && amount > 0.0) {
            continue;
        }
        let share = amount * ACCOUNT_MANAGER_SHARE;
        client
            .execute(
                r#"INSERT INTO account_manager_mining_accrual
                     (contract_id, coin_id, week_start, owner_mined_amount, manager_share_amount, paid_at)
                   VALUES ($1, $2, $3, $4, $5, NULL)
                   ON CONFLICT (contract_id, coin_id, week_start)
                   DO UPDATE SET
                     owner_mined_amount = account_manager_mining_accrual.owner_mined_amount + EXCLUDED.owner_mined_amount,
                     manager_share_amount = account_manager_mining_accrual.manager_share_amount + EXCLUDED.manager_share_amount
                   WHERE account_manager_mining_accrual.paid_at IS NULL"#,
                &[&contract_id, coin_id, &week_start, &amount, &share],
            )
            .await
            .context("account_manager_mining_accrual upsert")?;
    }
    Ok(())
}

async fn insert_progress_ledger(
    client: &tokio_postgres::Client,
    user_id: i32,
    key: &str,
) -> anyhow::Result<InsertLedgerOutcome> {
    client
        .batch_execute("SAVEPOINT mining_progress_ledger_sp")
        .await?;
    match client
        .query(
            r#"INSERT INTO mining_progress_commit_ledger (user_id, idempotency_key)
             VALUES ($1, $2)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING id"#,
            &[&user_id, &key],
        )
        .await
    {
        Ok(rows) if rows.is_empty() => {
            // Duplicate — caller rolls back whole TX.
            Ok(InsertLedgerOutcome::Duplicate)
        }
        Ok(_) => {
            client
                .batch_execute("RELEASE SAVEPOINT mining_progress_ledger_sp")
                .await?;
            Ok(InsertLedgerOutcome::Inserted)
        }
        Err(e) if pg_code(&e) == Some(PG_UNDEFINED_TABLE) => {
            client
                .batch_execute(
                    "ROLLBACK TO SAVEPOINT mining_progress_ledger_sp; RELEASE SAVEPOINT mining_progress_ledger_sp",
                )
                .await
                .ok();
            if !LEDGER_SCHEMA_WARNED.swap(true, Ordering::Relaxed) {
                warn!("progress: mining_progress_commit_ledger missing (42P01) — ledger off this boot");
            }
            Ok(InsertLedgerOutcome::TableMissing)
        }
        Err(e) => Err(e.into()),
    }
}

enum HistoryAssertError {
    Mismatch(String),
    AlreadyCredited(String),
    TableMissing,
    Other(anyhow::Error),
}

async fn assert_canonical_history_compatible(
    client: &tokio_postgres::Client,
    user_id: i32,
    rows: &[MiningBlockHistoryInsertRow],
) -> Result<(), HistoryAssertError> {
    if rows.is_empty() {
        return Ok(());
    }
    let coin_ids: Vec<String> = rows.iter().map(|r| r.coin_id.clone()).collect();
    let starts: Vec<i64> = rows
        .iter()
        .map(|r| r.window_start_ms.floor() as i64)
        .collect();
    let ends: Vec<i64> = rows
        .iter()
        .map(|r| r.window_end_ms.floor() as i64)
        .collect();

    let existing = match client
        .query(
            r#"SELECT h.coin_id, h.window_start_ms, h.window_end_ms, h.amount_coins
               FROM mining_block_history h
               INNER JOIN unnest($2::text[], $3::bigint[], $4::bigint[])
                 AS v(coin_id, window_start_ms, window_end_ms)
                 ON h.coin_id = v.coin_id
                AND h.window_start_ms = v.window_start_ms
                AND h.window_end_ms = v.window_end_ms
              WHERE h.user_id = $1"#,
            &[&user_id, &coin_ids, &starts, &ends],
        )
        .await
    {
        Ok(r) => r,
        Err(e) if pg_code(&e) == Some(PG_UNDEFINED_TABLE) => {
            if !BLOCK_HISTORY_SCHEMA_WARNED.swap(true, Ordering::Relaxed) {
                warn!("progress: mining_block_history missing (42P01) — granular history off");
            }
            return Err(HistoryAssertError::TableMissing);
        }
        Err(e) => return Err(HistoryAssertError::Other(e.into())),
    };

    if existing.is_empty() {
        return Ok(());
    }

    let mut incoming: HashMap<String, f64> = HashMap::new();
    for r in rows {
        let key = format!(
            "{}\0{}\0{}",
            r.coin_id,
            r.window_start_ms.floor() as i64,
            r.window_end_ms.floor() as i64
        );
        incoming.insert(key, r.amount_coins);
    }

    for row in &existing {
        let coin_id: String = row.get("coin_id");
        let ws = row_f64(row, "window_start_ms").floor() as i64;
        let we = row_f64(row, "window_end_ms").floor() as i64;
        let key = format!("{coin_id}\0{ws}\0{we}");
        let existing_amount = row_f64(row, "amount_coins");
        let Some(&incoming_amount) = incoming.get(&key) else {
            continue;
        };
        if !amounts_almost_equal(existing_amount, incoming_amount) {
            return Err(HistoryAssertError::Mismatch(format!(
                "mining_block_history mismatch user={user_id} coin={coin_id} \
                 window=[{ws},{we}) existing={existing_amount} incoming={incoming_amount}"
            )));
        }
        return Err(HistoryAssertError::AlreadyCredited(format!(
            "mining_block_history already credited user={user_id} coin={coin_id} \
             window=[{ws},{we}) existing={existing_amount} incoming={incoming_amount} — abort sem += balances"
        )));
    }
    Ok(())
}

async fn insert_block_history(
    client: &tokio_postgres::Client,
    user_id: i32,
    server_now: i64,
    rows: &[MiningBlockHistoryInsertRow],
) -> anyhow::Result<()> {
    let coin_ids: Vec<String> = rows.iter().map(|r| r.coin_id.clone()).collect();
    let room_ids: Vec<String> = rows
        .iter()
        .map(|r| r.room_id.clone().unwrap_or_default())
        .collect();
    let starts: Vec<i64> = rows
        .iter()
        .map(|r| r.window_start_ms.floor() as i64)
        .collect();
    let ends: Vec<i64> = rows
        .iter()
        .map(|r| r.window_end_ms.floor() as i64)
        .collect();
    let blocks: Vec<i32> = rows.iter().map(|r| r.credit_blocks as i32).collect();
    let amounts: Vec<f64> = rows.iter().map(|r| r.amount_coins).collect();
    let usds: Vec<f64> = rows.iter().map(|r| r.amount_usd).collect();
    let hashes: Vec<f64> = rows.iter().map(|r| r.user_hash_hps).collect();
    let nets: Vec<f64> = rows.iter().map(|r| r.network_hashrate).collect();
    let rewards: Vec<f64> = rows.iter().map(|r| r.block_reward).collect();
    let times: Vec<f64> = rows.iter().map(|r| r.block_time).collect();
    let created: Vec<i64> = rows.iter().map(|_| server_now).collect();

    let sql_conflict = r#"
INSERT INTO mining_block_history (
  user_id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
  amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time, created_at
)
SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::bigint[]), unnest($5::bigint[]), unnest($6::int[]),
       unnest($7::float8[]), unnest($8::float8[]), unnest($9::float8[]),
       unnest($10::float8[]), unnest($11::float8[]), unnest($12::float8[]), unnest($13::bigint[])
ON CONFLICT (user_id, coin_id, window_start_ms, window_end_ms) DO NOTHING
"#;
    let sql_plain = r#"
INSERT INTO mining_block_history (
  user_id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
  amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time, created_at
)
SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::bigint[]), unnest($5::bigint[]), unnest($6::int[]),
       unnest($7::float8[]), unnest($8::float8[]), unnest($9::float8[]),
       unnest($10::float8[]), unnest($11::float8[]), unnest($12::float8[]), unnest($13::bigint[])
"#;

    client
        .batch_execute("SAVEPOINT mining_block_history_sp")
        .await?;

    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 13] = [
        &user_id, &coin_ids, &room_ids, &starts, &ends, &blocks, &amounts, &usds, &hashes, &nets,
        &rewards, &times, &created,
    ];

    match client.execute(sql_conflict, &params).await {
        Ok(_) => {
            client
                .batch_execute("RELEASE SAVEPOINT mining_block_history_sp")
                .await?;
            Ok(())
        }
        Err(e) if pg_code(&e) == Some(PG_UNDEFINED_TABLE) => {
            client
                .batch_execute(
                    "ROLLBACK TO SAVEPOINT mining_block_history_sp; RELEASE SAVEPOINT mining_block_history_sp",
                )
                .await
                .ok();
            if !BLOCK_HISTORY_SCHEMA_WARNED.swap(true, Ordering::Relaxed) {
                warn!("progress: mining_block_history missing (42P01) — history off (credit ok)");
            }
            Ok(())
        }
        Err(e)
            if pg_code(&e) == Some(PG_INVALID_COLUMN_REFERENCE)
                || pg_code(&e) == Some(PG_UNDEFINED_COLUMN) =>
        {
            client
                .batch_execute("ROLLBACK TO SAVEPOINT mining_block_history_sp")
                .await
                .ok();
            client
                .batch_execute("SAVEPOINT mining_block_history_sp")
                .await?;
            match client.execute(sql_plain, &params).await {
                Ok(_) => {
                    client
                        .batch_execute("RELEASE SAVEPOINT mining_block_history_sp")
                        .await?;
                    Ok(())
                }
                Err(e2) if pg_code(&e2) == Some(PG_UNDEFINED_TABLE) => {
                    client
                        .batch_execute(
                            "ROLLBACK TO SAVEPOINT mining_block_history_sp; RELEASE SAVEPOINT mining_block_history_sp",
                        )
                        .await
                        .ok();
                    Ok(())
                }
                Err(e2) => Err(e2.into()),
            }
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) async fn load_live_network_hashrates(
    client: &tokio_postgres::Client,
) -> HashMap<String, f64> {
    let Ok(Some(row)) = client
        .query_opt(
            "SELECT value FROM app_cache WHERE key = 'network_stats'",
            &[],
        )
        .await
    else {
        return HashMap::new();
    };
    let value: serde_json::Value = match row.try_get("value") {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    if let Some(obj) = value.get("hashrates").and_then(|h| h.as_object()) {
        for (k, v) in obj {
            if let Some(n) = v.as_f64() {
                if n.is_finite() && n > 0.0 {
                    out.insert(k.clone(), n);
                }
            }
        }
    }
    out
}

/// Rig opera se ligada, com cablagem e bateria (espelho TS `is_on && wiring_id && battery_id`).
fn rack_is_operable(r: &tokio_postgres::Row) -> bool {
    if row_i32(r, "is_on") != 1 {
        return false;
    }
    let wiring: Option<String> = r
        .try_get::<_, Option<String>>("wiring_id")
        .ok()
        .flatten()
        .or_else(|| r.try_get::<_, String>("wiring_id").ok());
    let battery: Option<String> = r
        .try_get::<_, Option<String>>("battery_id")
        .ok()
        .flatten()
        .or_else(|| r.try_get::<_, String>("battery_id").ok());
    wiring.as_ref().is_some_and(|s| !s.is_empty())
        && battery.as_ref().is_some_and(|s| !s.is_empty())
}

fn round_mined_coin_amount(raw: f64) -> f64 {
    if !raw.is_finite() || raw == 0.0 {
        return 0.0;
    }
    let scale = 10f64.powi(MINED_COIN_AMOUNT_DECIMALS);
    (raw * scale).round() / scale
}

fn pg_code(err: &tokio_postgres::Error) -> Option<&str> {
    err.code().map(|c| c.code())
}

fn truncate_err(msg: &str) -> String {
    const MAX: usize = 240;
    if msg.len() <= MAX {
        msg.to_string()
    } else {
        msg[..MAX].to_string()
    }
}

pub(crate) struct PremiumWeeklyContext {
    pub premium_weekly: bool,
    pub interval_days: i32,
}

/// Resolve premium weekly check-in para freeze de mineração.
/// Espelha `resolveUserCheckinPremiumContext` / `loadCheckinPremiumPolicy` (premium-policy.ts).
/// Em falha recuperável de settings/purchases: warn + cai no path 48h (não-premium) —
/// não inventar freeze premium nem piorar o gap para quem não é premium.
pub(crate) async fn resolve_premium_weekly_checkin(
    client: &tokio_postgres::Client,
    user_id: i32,
) -> PremiumWeeklyContext {
    let fallback = PremiumWeeklyContext {
        premium_weekly: false,
        interval_days: DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
    };

    let setting_keys: Vec<String> = vec![
        "checkin_premium_enabled".to_string(),
        "checkin_premium_min_usdc".to_string(),
        "checkin_premium_interval_days".to_string(),
    ];
    let settings_rows = match client
        .query(
            r#"SELECT key, value FROM settings
                WHERE key = ANY($1)"#,
            &[&setting_keys],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!(user_id, err = %e, "progress: premium settings query failed — using 48h grace");
            return fallback;
        }
    };

    let mut enabled_raw: Option<String> = None;
    let mut min_usdc_raw: Option<String> = None;
    let mut interval_days_raw: Option<String> = None;
    for row in &settings_rows {
        let key: String = row.get("key");
        let value: String = row.try_get("value").unwrap_or_default();
        match key.as_str() {
            "checkin_premium_enabled" => enabled_raw = Some(value),
            "checkin_premium_min_usdc" => min_usdc_raw = Some(value),
            "checkin_premium_interval_days" => interval_days_raw = Some(value),
            _ => {}
        }
    }

    // missing/'' → enabled true; senão enabled iff value == "1" (igual TS)
    let enabled = match enabled_raw.as_deref() {
        None | Some("") => true,
        Some(v) => v == "1",
    };

    let min_parsed = min_usdc_raw
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(DEFAULT_CHECKIN_PREMIUM_MIN_USDC);
    let min_usdc = if min_parsed.is_finite() && min_parsed >= 0.0 {
        min_parsed
    } else {
        DEFAULT_CHECKIN_PREMIUM_MIN_USDC
    };

    let days_parsed = interval_days_raw
        .as_deref()
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS);
    let interval_days = if days_parsed >= 1 {
        days_parsed
    } else {
        DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS
    };

    if !enabled {
        return PremiumWeeklyContext {
            premium_weekly: false,
            interval_days,
        };
    }

    let eligible = match client
        .query_opt(
            r#"SELECT 1 FROM admin_upgrade_purchases p
               INNER JOIN admin_upgrades u ON u.id = p.upgrade_id
               WHERE p.user_id = $1 AND u.price_usdc >= $2
               LIMIT 1"#,
            &[&user_id, &min_usdc],
        )
        .await
    {
        Ok(row) => row.is_some(),
        Err(e) => {
            warn!(
                user_id,
                err = %e,
                "progress: premium purchases query failed — using 48h grace"
            );
            return PremiumWeeklyContext {
                premium_weekly: false,
                interval_days,
            };
        }
    };

    PremiumWeeklyContext {
        premium_weekly: eligible,
        interval_days,
    }
}

fn row_f64(row: &tokio_postgres::Row, col: &str) -> f64 {
    row.try_get::<_, f64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(|v| v as f64))
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v as f64))
        .unwrap_or(0.0)
}

fn row_f64_opt(row: &tokio_postgres::Row, col: &str) -> f64 {
    row_f64(row, col)
}

fn row_i32(row: &tokio_postgres::Row, col: &str) -> i32 {
    row.try_get::<_, i32>(col)
        .or_else(|_| row.try_get::<_, i64>(col).map(|v| v as i32))
        .or_else(|_| row.try_get::<_, f64>(col).map(|v| v as i32))
        .unwrap_or(0)
}

fn row_i64_opt(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    row.try_get::<_, i64>(col)
        .ok()
        .or_else(|| row.try_get::<_, i32>(col).ok().map(|v| v as i64))
        .or_else(|| {
            row.try_get::<_, f64>(col)
                .ok()
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| v as i64)
        })
        .filter(|&v| v > 0)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
