//! Accrual puro — integrate yield, history rows, consolidate, tick economy assert.
//! Espelho das funções puras em `progress-computer.ts`.

use crate::time::MS_PER_SECOND;
use serde::{Deserialize, Serialize};

use super::epsilon::assert_amounts_almost_equal;
use super::wall_clock::{list_credit_history_windows, TEN_MIN_MS};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YieldHistPoint {
    pub yield_per_hash: f64,
    pub effective_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiningBlockHistoryInsertRow {
    pub coin_id: String,
    pub room_id: Option<String>,
    pub window_start_ms: f64,
    pub window_end_ms: f64,
    pub credit_blocks: i64,
    pub amount_coins: f64,
    pub amount_usd: f64,
    pub user_hash_hps: f64,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
}

fn finite_or_zero(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// ∫ yield_per_hash(t) dt sobre `[start, end)` com histórico ordenado por effective_at.
pub fn calculate_integrated_yield(
    start_time_ms: f64,
    end_time_ms: f64,
    sorted_coin_history: &[YieldHistPoint],
) -> f64 {
    if !(end_time_ms > start_time_ms) {
        return 0.0;
    }
    if sorted_coin_history.is_empty() {
        return 0.0;
    }
    let ms_per_sec = MS_PER_SECOND as f64;
    let mut total_yield = 0.0;
    let mut cursor = start_time_ms;
    let mut current_rate = finite_or_zero(sorted_coin_history[0].yield_per_hash);

    for h in sorted_coin_history {
        let eff_at = finite_or_zero(h.effective_at);
        if eff_at <= start_time_ms {
            current_rate = finite_or_zero(h.yield_per_hash);
        } else {
            break;
        }
    }

    for h in sorted_coin_history {
        let eff = finite_or_zero(h.effective_at);
        if eff > start_time_ms && eff < end_time_ms {
            let duration_sec = (eff - cursor) / ms_per_sec;
            total_yield += duration_sec * current_rate;
            cursor = eff;
            current_rate = finite_or_zero(h.yield_per_hash);
        }
    }

    let duration_sec = (end_time_ms - cursor) / ms_per_sec;
    total_yield += duration_sec * current_rate;
    if total_yield.is_finite() {
        total_yield
    } else {
        0.0
    }
}

#[derive(Debug, Clone)]
pub struct BuildHistoryRowsOpts<'a> {
    pub coin_id: &'a str,
    pub room_id: Option<&'a str>,
    pub interval_start_ms: f64,
    pub interval_end_ms: f64,
    pub sorted_coin_history: &'a [YieldHistPoint],
    pub use_history_integration: bool,
    pub fallback_yield_per_hash: f64,
    pub effective_hash: f64,
    pub usd_rate: f64,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
}

pub fn build_mining_block_history_rows_for_credit(
    opts: BuildHistoryRowsOpts<'_>,
) -> Vec<MiningBlockHistoryInsertRow> {
    let windows = list_credit_history_windows(opts.interval_start_ms, opts.interval_end_ms);
    let ms_per_sec = MS_PER_SECOND as f64;
    let mut out = Vec::new();
    for w in windows {
        let window_yield = if opts.use_history_integration {
            calculate_integrated_yield(w.start_ms as f64, w.end_ms as f64, opts.sorted_coin_history)
        } else {
            opts.fallback_yield_per_hash * ((w.end_ms - w.start_ms) as f64 / ms_per_sec)
        };
        let amount_coins = opts.effective_hash * window_yield;
        if !(amount_coins.is_finite() && amount_coins > 0.0) {
            continue;
        }
        let amount_usd = amount_coins * opts.usd_rate;
        let dur = w.end_ms - w.start_ms;
        let credit_blocks = if dur == TEN_MIN_MS {
            1
        } else {
            ((dur as f64 / TEN_MIN_MS as f64).round() as i64).max(1)
        };
        out.push(MiningBlockHistoryInsertRow {
            coin_id: opts.coin_id.to_string(),
            room_id: opts.room_id.map(|s| s.to_string()),
            window_start_ms: w.start_ms as f64,
            window_end_ms: w.end_ms as f64,
            credit_blocks,
            amount_coins,
            amount_usd: if amount_usd.is_finite() {
                amount_usd
            } else {
                0.0
            },
            user_hash_hps: opts.effective_hash,
            network_hashrate: opts.network_hashrate,
            block_reward: opts.block_reward,
            block_time: opts.block_time,
        });
    }
    out
}

fn history_canonical_key(coin_id: &str, window_start_ms: f64, window_end_ms: f64) -> String {
    format!(
        "{}\0{}\0{}",
        coin_id,
        window_start_ms.floor() as i64,
        window_end_ms.floor() as i64
    )
}

pub fn consolidate_mining_block_history_rows(
    rows: &[MiningBlockHistoryInsertRow],
) -> Vec<MiningBlockHistoryInsertRow> {
    if rows.len() <= 1 {
        return rows.to_vec();
    }
    use std::collections::{BTreeMap, BTreeSet};
    struct Agg {
        row: MiningBlockHistoryInsertRow,
        rooms: BTreeSet<String>,
    }
    let mut by_key: BTreeMap<String, Agg> = BTreeMap::new();
    for r in rows {
        let key = history_canonical_key(&r.coin_id, r.window_start_ms, r.window_end_ms);
        let room = r
            .room_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        if let Some(existing) = by_key.get_mut(&key) {
            existing.row.amount_coins += finite_or_zero(r.amount_coins);
            existing.row.amount_usd += finite_or_zero(r.amount_usd);
            existing.row.user_hash_hps += finite_or_zero(r.user_hash_hps);
            let cb = (r.credit_blocks as f64).floor().max(1.0) as i64;
            existing.row.credit_blocks = existing.row.credit_blocks.max(cb.max(1));
            if r.network_hashrate.is_finite() && r.network_hashrate > existing.row.network_hashrate
            {
                existing.row.network_hashrate = r.network_hashrate;
            }
            if r.block_reward.is_finite() {
                existing.row.block_reward = r.block_reward;
            }
            if r.block_time.is_finite() {
                existing.row.block_time = r.block_time;
            }
            if !room.is_empty() {
                existing.rooms.insert(room);
            }
        } else {
            let mut rooms = BTreeSet::new();
            if !room.is_empty() {
                rooms.insert(room.clone());
            }
            by_key.insert(
                key,
                Agg {
                    row: MiningBlockHistoryInsertRow {
                        coin_id: r.coin_id.clone(),
                        room_id: if room.is_empty() { None } else { Some(room) },
                        window_start_ms: r.window_start_ms,
                        window_end_ms: r.window_end_ms,
                        credit_blocks: (r.credit_blocks as f64).floor().max(1.0) as i64,
                        amount_coins: finite_or_zero(r.amount_coins),
                        amount_usd: finite_or_zero(r.amount_usd),
                        user_hash_hps: finite_or_zero(r.user_hash_hps),
                        network_hashrate: r.network_hashrate,
                        block_reward: r.block_reward,
                        block_time: r.block_time,
                    },
                    rooms,
                },
            );
        }
    }
    let mut out: Vec<MiningBlockHistoryInsertRow> = by_key
        .into_values()
        .map(|agg| {
            let room_id = if agg.rooms.len() == 1 {
                agg.rooms.into_iter().next()
            } else {
                None
            };
            MiningBlockHistoryInsertRow {
                coin_id: agg.row.coin_id,
                room_id,
                window_start_ms: agg.row.window_start_ms.floor(),
                window_end_ms: agg.row.window_end_ms.floor(),
                credit_blocks: agg.row.credit_blocks,
                amount_coins: agg.row.amount_coins,
                amount_usd: agg.row.amount_usd,
                user_hash_hps: agg.row.user_hash_hps,
                network_hashrate: agg.row.network_hashrate,
                block_reward: agg.row.block_reward,
                block_time: agg.row.block_time,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.window_start_ms
            .partial_cmp(&b.window_start_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.window_end_ms
                    .partial_cmp(&b.window_end_ms)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(a.coin_id.cmp(&b.coin_id))
    });
    out
}

/// Σ history consolidado por coin ≡ total_gained (± epsilon),
/// após arredondamento à precisão canónica de saldo minerado (8 casas) —
/// alinha ao `roundMinedCoinAmount` do TS e evita falso mismatch IEEE-754.
pub fn assert_tick_history_matches_economy(
    total_gained: &std::collections::HashMap<String, f64>,
    history_rows: &[MiningBlockHistoryInsertRow],
) -> Result<(), String> {
    const MINED_DECIMALS: i32 = 8;
    let scale = 10f64.powi(MINED_DECIMALS);
    let round_mined = |raw: f64| -> f64 {
        if !raw.is_finite() || raw == 0.0 {
            return 0.0;
        }
        (raw * scale).round() / scale
    };

    let mut hist_by_coin: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for r in history_rows {
        *hist_by_coin.entry(r.coin_id.clone()).or_insert(0.0) += finite_or_zero(r.amount_coins);
    }
    let mut coins: std::collections::BTreeSet<String> = total_gained.keys().cloned().collect();
    coins.extend(hist_by_coin.keys().cloned());
    for coin_id in coins {
        let a = round_mined(total_gained.get(&coin_id).copied().unwrap_or(0.0));
        let b = round_mined(hist_by_coin.get(&coin_id).copied().unwrap_or(0.0));
        assert_amounts_almost_equal(a, b, &format!("tick economy↔history coin={coin_id}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integrate_flat_rate() {
        let hist = vec![YieldHistPoint {
            yield_per_hash: 0.001,
            effective_at: 0.0,
        }];
        let y = calculate_integrated_yield(1_000.0, 11_000.0, &hist);
        assert!((y - 0.01).abs() < 1e-12);
    }

    #[test]
    fn consolidate_sums_amounts() {
        let rows = vec![
            MiningBlockHistoryInsertRow {
                coin_id: "btc".into(),
                room_id: Some("r1".into()),
                window_start_ms: 100.0,
                window_end_ms: 200.0,
                credit_blocks: 1,
                amount_coins: 1.0,
                amount_usd: 2.0,
                user_hash_hps: 10.0,
                network_hashrate: 100.0,
                block_reward: 1.0,
                block_time: 60.0,
            },
            MiningBlockHistoryInsertRow {
                coin_id: "btc".into(),
                room_id: Some("r2".into()),
                window_start_ms: 100.0,
                window_end_ms: 200.0,
                credit_blocks: 1,
                amount_coins: 3.0,
                amount_usd: 6.0,
                user_hash_hps: 20.0,
                network_hashrate: 150.0,
                block_reward: 1.0,
                block_time: 60.0,
            },
        ];
        let out = consolidate_mining_block_history_rows(&rows);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].amount_coins, 4.0);
        assert_eq!(out[0].user_hash_hps, 30.0);
        assert_eq!(out[0].network_hashrate, 150.0);
        assert!(out[0].room_id.is_none());
    }
}
