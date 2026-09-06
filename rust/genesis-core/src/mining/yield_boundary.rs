//! Fórmula de `mining_yield_history` por boundary — espelho de `buildYieldHistoryRowsForBoundary`.

use super::network::effective_network_hashrate_for_coin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinYieldInput {
    pub id: String,
    pub block_reward: f64,
    pub block_time: f64,
    pub network_hashrate: f64,
    /// Pool independente (GHO / NFT / usdc_interno): rede via
    /// [`effective_network_hashrate_for_coin`] (floor-only; ignora live/implied).
    #[serde(default)]
    pub independent_pool: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YieldHistoryBoundaryRows {
    pub coin_ids: Vec<String>,
    pub yields: Vec<f64>,
    pub rewards: Vec<f64>,
    pub net_hashes: Vec<f64>,
    pub effectives: Vec<f64>,
}

/// Uma linha por moeda para `effective_at` fixo.
/// Competitivo: live=0 → yield 0; stored = floor. live>0 → max(live, floor).
/// Independente: yield e stored = mesmo effective floor-only (`max(floor, MIN)`).
pub fn build_yield_history_rows_for_boundary(
    coins: &[CoinYieldInput],
    real_network_by_coin: &HashMap<String, f64>,
    effective_at_ms: f64,
) -> YieldHistoryBoundaryRows {
    let mut coin_ids = Vec::new();
    let mut yields = Vec::new();
    let mut rewards = Vec::new();
    let mut net_hashes = Vec::new();
    let mut effectives = Vec::new();
    let empty_implied = HashMap::new();

    for coin in coins {
        let coin_id = coin.id.clone();
        let real_net_hash = real_network_by_coin
            .get(&coin_id)
            .copied()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);

        let block_reward = if coin.block_reward.is_finite() {
            coin.block_reward
        } else {
            0.0
        };
        let block_time = if coin.block_time.is_finite() {
            coin.block_time
        } else {
            0.0
        };
        let network_hashrate = if coin.network_hashrate.is_finite() {
            coin.network_hashrate
        } else {
            0.0
        };

        let effective_hashrate = effective_network_hashrate_for_coin(
            &coin_id,
            network_hashrate,
            real_network_by_coin,
            &empty_implied,
            coin.independent_pool,
        );

        let mut yield_per_hash = 0.0;
        if coin.independent_pool {
            // Floor-only: yield sempre via piso admin — pool não partilha rede.
            if block_time > 0.0 {
                let reward_per_sec = block_reward / block_time;
                yield_per_hash = reward_per_sec / effective_hashrate;
            }
        } else if real_net_hash > 0.0 {
            if block_time > 0.0 {
                let reward_per_sec = block_reward / block_time;
                yield_per_hash = reward_per_sec / effective_hashrate;
            }
        }
        if !yield_per_hash.is_finite() || yield_per_hash < 0.0 {
            yield_per_hash = 0.0;
        }

        // Yield e stored usam o mesmo effective (competitivo sem live → yield 0, stored = floor).
        coin_ids.push(coin_id);
        yields.push(yield_per_hash);
        rewards.push(block_reward);
        net_hashes.push(effective_hashrate);
        effectives.push(effective_at_ms);
    }

    YieldHistoryBoundaryRows {
        coin_ids,
        yields,
        rewards,
        net_hashes,
        effectives,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yield_from_live_and_floor() {
        let coins = vec![CoinYieldInput {
            id: "btc".into(),
            block_reward: 6.0,
            block_time: 60.0,
            network_hashrate: 100.0,
            independent_pool: false,
        }];
        let mut live = HashMap::new();
        live.insert("btc".into(), 200.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1_000.0);
        // reward/sec = 0.1; effective = 200; yph = 0.0005
        assert_eq!(rows.yields[0], 0.1 / 200.0);
        assert_eq!(rows.net_hashes[0], 200.0);
        assert_eq!(rows.effectives[0], 1_000.0);
    }

    #[test]
    fn zero_live_yield_zero_stored_floor() {
        let coins = vec![CoinYieldInput {
            id: "x".into(),
            block_reward: 1.0,
            block_time: 10.0,
            network_hashrate: 50.0,
            independent_pool: false,
        }];
        let rows = build_yield_history_rows_for_boundary(&coins, &HashMap::new(), 5.0);
        assert_eq!(rows.yields[0], 0.0);
        assert_eq!(rows.net_hashes[0], 50.0);
    }

    #[test]
    fn independent_gemt_ignores_live_uses_floor() {
        let coins = vec![CoinYieldInput {
            id: "gemt".into(),
            block_reward: 10.0,
            block_time: 600.0,
            network_hashrate: 965.0,
            independent_pool: true,
        }];
        let mut live = HashMap::new();
        live.insert("gemt".into(), 5_216.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1_000.0);
        let expected_yph = (10.0 / 600.0) / 965.0;
        assert_eq!(rows.yields[0], expected_yph);
        assert_eq!(rows.net_hashes[0], 965.0);
    }

    #[test]
    fn independent_live_absent_uses_floor() {
        let coins = vec![CoinYieldInput {
            id: "gho".into(),
            block_reward: 10.0,
            block_time: 600.0,
            network_hashrate: 965.0,
            independent_pool: true,
        }];
        let rows = build_yield_history_rows_for_boundary(&coins, &HashMap::new(), 1_000.0);
        let expected_yph = (10.0 / 600.0) / 965.0;
        assert_eq!(rows.yields[0], expected_yph);
        assert_eq!(rows.net_hashes[0], 965.0);
    }
}
