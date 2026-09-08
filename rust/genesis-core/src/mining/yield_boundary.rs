//! Fórmula de `mining_yield_history` por boundary — espelho de `buildYieldHistoryRowsForBoundary`.

use super::network::effective_network_hashrate_for_coin;
use crate::calculator::constants::{DIST_MIN_HASHRATE, MIN_NETWORK_HASHRATE, SECONDS_PER_MONTH};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Como o `yield_per_hash` da moeda é derivado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DistributionMode {
    /// `block_reward` / `block_time` / `network_hashrate` (comportamento histórico).
    #[default]
    Legacy,
    /// Orçamento USD mensal perpétuo, dividido pelo hashrate ativo real a cada boundary.
    UsdMonth,
}

impl DistributionMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "usd_month" => Self::UsdMonth,
            _ => Self::Legacy,
        }
    }
}

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
    /// `legacy` vs `usd_month`. Default `Legacy` (payload antigo).
    #[serde(default)]
    pub distribution_mode: DistributionMode,
    /// Orçamento USD/mês quando `distribution_mode == UsdMonth`.
    #[serde(default)]
    pub distribution_usd_month: f64,
    /// Preço da moeda em USD — só usado no modo `usd_month` (converte orçamento → coins).
    #[serde(default)]
    pub price_usd: f64,
}

/// Núcleo do modo `usd_month`. Retorna `(yield_per_hash, budget_per_sec_coins, divisor)`.
/// `active` = Σ hashrate ativo real da moeda no tick. Divisor com clamp em
/// [`DIST_MIN_HASHRATE`] → total pago nunca passa do orçamento (só sub-distribui abaixo do piso).
/// `active <= MIN_NETWORK_HASHRATE` ⇒ ninguém minerando ⇒ yield 0.
pub fn usd_month_yield(distribution_usd_month: f64, price_usd: f64, active: f64) -> (f64, f64, f64) {
    let usd_month = if distribution_usd_month.is_finite() && distribution_usd_month > 0.0 {
        distribution_usd_month
    } else {
        0.0
    };
    let price_or_1 = if price_usd.is_finite() && price_usd > 0.0 {
        price_usd
    } else {
        1.0
    };
    let budget_per_sec_coins = usd_month / SECONDS_PER_MONTH / price_or_1;
    let active = if active.is_finite() && active > 0.0 {
        active
    } else {
        0.0
    };
    let divisor = active.max(DIST_MIN_HASHRATE);
    let yield_per_hash = if active <= MIN_NETWORK_HASHRATE || budget_per_sec_coins <= 0.0 {
        0.0
    } else {
        budget_per_sec_coins / divisor
    };
    (yield_per_hash, budget_per_sec_coins, divisor)
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

        // Modo `usd_month`: yield derivado do orçamento USD / hashrate ativo real.
        // Competitivo vs independente é irrelevante aqui — sempre divide pelo hash ativo.
        if coin.distribution_mode == DistributionMode::UsdMonth {
            let (yph, budget_per_sec_coins, divisor) =
                usd_month_yield(coin.distribution_usd_month, coin.price_usd, real_net_hash);
            coin_ids.push(coin_id);
            yields.push(yph);
            // `block_reward` guardado = coins/seg do orçamento → mantém a identidade
            // `yield * network_hashrate ≈ reward_per_sec` (assert_tick_history_matches_economy).
            rewards.push(budget_per_sec_coins);
            net_hashes.push(divisor);
            effectives.push(effective_at_ms);
            continue;
        }

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

    fn legacy_coin(id: &str, block_reward: f64, block_time: f64, net: f64, independent: bool) -> CoinYieldInput {
        CoinYieldInput {
            id: id.into(),
            block_reward,
            block_time,
            network_hashrate: net,
            independent_pool: independent,
            distribution_mode: DistributionMode::Legacy,
            distribution_usd_month: 0.0,
            price_usd: 0.0,
        }
    }

    fn usd_coin(id: &str, usd_month: f64, price_usd: f64) -> CoinYieldInput {
        CoinYieldInput {
            id: id.into(),
            block_reward: 0.0,
            block_time: 0.0,
            network_hashrate: 0.0,
            independent_pool: false,
            distribution_mode: DistributionMode::UsdMonth,
            distribution_usd_month: usd_month,
            price_usd,
        }
    }

    #[test]
    fn yield_from_live_and_floor() {
        let coins = vec![legacy_coin("btc", 6.0, 60.0, 100.0, false)];
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
        let coins = vec![legacy_coin("x", 1.0, 10.0, 50.0, false)];
        let rows = build_yield_history_rows_for_boundary(&coins, &HashMap::new(), 5.0);
        assert_eq!(rows.yields[0], 0.0);
        assert_eq!(rows.net_hashes[0], 50.0);
    }

    #[test]
    fn independent_gemt_ignores_live_uses_floor() {
        let coins = vec![legacy_coin("gemt", 10.0, 600.0, 965.0, true)];
        let mut live = HashMap::new();
        live.insert("gemt".into(), 5_216.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1_000.0);
        let expected_yph = (10.0 / 600.0) / 965.0;
        assert_eq!(rows.yields[0], expected_yph);
        assert_eq!(rows.net_hashes[0], 965.0);
    }

    #[test]
    fn independent_live_absent_uses_floor() {
        let coins = vec![legacy_coin("gho", 10.0, 600.0, 965.0, true)];
        let rows = build_yield_history_rows_for_boundary(&coins, &HashMap::new(), 1_000.0);
        let expected_yph = (10.0 / 600.0) / 965.0;
        assert_eq!(rows.yields[0], expected_yph);
        assert_eq!(rows.net_hashes[0], 965.0);
    }

    // ---- usd_month mode ----

    #[test]
    fn usd_month_budget_over_active() {
        // $2_592_000/mo, price 1 → budget_per_sec = 1 coin/s ; active 100 → yph = 0.01
        let coins = vec![usd_coin("c", SECONDS_PER_MONTH, 1.0)];
        let mut live = HashMap::new();
        live.insert("c".into(), 100.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 7.0);
        assert!((rows.yields[0] - 0.01).abs() < 1e-15);
        assert_eq!(rows.net_hashes[0], 100.0);
        assert!((rows.rewards[0] - 1.0).abs() < 1e-15);
        assert_eq!(rows.effectives[0], 7.0);
        // total coins/sec paid = yph * active = budget_per_sec
        assert!((rows.yields[0] * rows.net_hashes[0] - rows.rewards[0]).abs() < 1e-12);
    }

    #[test]
    fn usd_month_price_zero_treated_as_one() {
        let coins = vec![usd_coin("c", SECONDS_PER_MONTH, 0.0)];
        let mut live = HashMap::new();
        live.insert("c".into(), 50.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1.0);
        assert!((rows.yields[0] - (1.0 / 50.0)).abs() < 1e-15);
    }

    #[test]
    fn usd_month_price_scales_inverse() {
        let coins = vec![usd_coin("c", SECONDS_PER_MONTH, 4.0)];
        let mut live = HashMap::new();
        live.insert("c".into(), 10.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1.0);
        // budget_per_sec = 1/4 ; divisor = max(10,10) = 10 ; yph = 0.025
        assert!((rows.yields[0] - 0.025).abs() < 1e-15);
    }

    #[test]
    fn usd_month_no_active_yields_zero() {
        let coins = vec![usd_coin("c", SECONDS_PER_MONTH, 1.0)];
        let rows = build_yield_history_rows_for_boundary(&coins, &HashMap::new(), 1.0);
        assert_eq!(rows.yields[0], 0.0);
        assert_eq!(rows.net_hashes[0], DIST_MIN_HASHRATE);
    }

    #[test]
    fn usd_month_spike_guard_underdistributes_below_floor() {
        // active 2 < DIST_MIN_HASHRATE(10) → divisor 10 → total paid = budget * 2/10
        let coins = vec![usd_coin("c", SECONDS_PER_MONTH, 1.0)];
        let mut live = HashMap::new();
        live.insert("c".into(), 2.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1.0);
        assert_eq!(rows.net_hashes[0], 10.0);
        let total_per_sec = rows.yields[0] * 2.0;
        assert!((total_per_sec - 0.2).abs() < 1e-15); // budget_per_sec(1.0) * 0.2
    }

    #[test]
    fn usd_month_negative_or_nan_budget_zero() {
        for bad in [-5.0, f64::NAN, f64::INFINITY] {
            let coins = vec![usd_coin("c", bad, 1.0)];
            let mut live = HashMap::new();
            live.insert("c".into(), 100.0);
            let rows = build_yield_history_rows_for_boundary(&coins, &live, 1.0);
            assert_eq!(rows.yields[0], 0.0, "bad budget {bad}");
        }
    }

    #[test]
    fn mixed_batch_legacy_untouched() {
        let coins = vec![
            usd_coin("u", SECONDS_PER_MONTH, 1.0),
            legacy_coin("l", 6.0, 60.0, 100.0, false),
        ];
        let mut live = HashMap::new();
        live.insert("u".into(), 100.0);
        live.insert("l".into(), 200.0);
        let rows = build_yield_history_rows_for_boundary(&coins, &live, 1.0);
        assert!((rows.yields[0] - 0.01).abs() < 1e-15); // usd_month
        assert_eq!(rows.yields[1], 0.1 / 200.0); // legacy unchanged
        assert_eq!(rows.net_hashes[1], 200.0);
    }
}
