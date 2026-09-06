//! Hashrate de rede efectivo — espelho de `server/.../network-hashrate.ts`.

use crate::calculator::constants::MIN_NETWORK_HASHRATE as CALC_MIN;
use std::collections::HashMap;

pub const MIN_NETWORK_HASHRATE: f64 = CALC_MIN;
pub const NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT: f64 = 50.0;
pub const NETWORK_FLOOR_BELOW_LIVE_WARN_RATIO: f64 = 10.0;

const PERCENT_DENOMINATOR: f64 = 100.0;
const DOMINANCE_WARN_FRACTION: f64 =
    NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT / PERCENT_DENOMINATOR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkFloorSanityLevel {
    Ok,
    Warn,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NetworkFloorSanityResult {
    pub level: NetworkFloorSanityLevel,
    pub dominance_pct: Option<f64>,
    pub message: Option<String>,
}

/// Pool competitivo: `max(floor, live, implied, MIN)`.
/// Pool independente (`independent_pool`): floor-only —
/// `max(floor, MIN)` — ignora live e implied (GHO / NFT exclusivas /
/// `usdc_interno`). Não partilha rede com outros jogadores.
pub fn effective_network_hashrate_for_coin(
    coin_id: &str,
    db_network_hashrate: f64,
    runtime_by_coin: &HashMap<String, f64>,
    implied_from_yield_by_coin: &HashMap<String, f64>,
    independent_pool: bool,
) -> f64 {
    let floor = if db_network_hashrate.is_finite() && db_network_hashrate > 0.0 {
        db_network_hashrate
    } else {
        MIN_NETWORK_HASHRATE
    };
    if independent_pool {
        return floor.max(MIN_NETWORK_HASHRATE);
    }
    let live = runtime_by_coin
        .get(coin_id)
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0);
    let implied = implied_from_yield_by_coin
        .get(coin_id)
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0);
    floor.max(live).max(implied).max(MIN_NETWORK_HASHRATE)
}

pub fn network_hashrate_from_yield_per_hash(
    yield_per_hash: f64,
    block_reward: f64,
    block_time_sec: f64,
) -> f64 {
    if !(yield_per_hash > 0.0) || !(block_time_sec > 0.0) || !(block_reward > 0.0) {
        return 0.0;
    }
    let reward_per_sec = block_reward / block_time_sec;
    let net = reward_per_sec / yield_per_hash;
    if net.is_finite() && net > 0.0 {
        net
    } else {
        0.0
    }
}

pub fn assess_network_floor_sanity(
    floor_hps: f64,
    live_network_hps: f64,
    largest_miner_hps: Option<f64>,
) -> NetworkFloorSanityResult {
    if !(floor_hps > 0.0) {
        return NetworkFloorSanityResult {
            level: NetworkFloorSanityLevel::Ok,
            dominance_pct: None,
            message: None,
        };
    }
    if let Some(largest) = largest_miner_hps {
        if largest.is_finite() && largest > 0.0 {
            let dominance_ratio = largest / floor_hps;
            if dominance_ratio >= DOMINANCE_WARN_FRACTION {
                let dominance_pct = dominance_ratio * PERCENT_DENOMINATOR;
                return NetworkFloorSanityResult {
                    level: NetworkFloorSanityLevel::Warn,
                    dominance_pct: Some(dominance_pct),
                    message: Some(format!(
                        "Este piso permite que um minerador com {largest:.0} H/s leve {dominance_pct:.1}% do bloco. Confirma?"
                    )),
                };
            }
        }
    }
    if live_network_hps > 0.0 && floor_hps < live_network_hps / NETWORK_FLOOR_BELOW_LIVE_WARN_RATIO
    {
        return NetworkFloorSanityResult {
            level: NetworkFloorSanityLevel::Warn,
            dominance_pct: None,
            message: Some(format!(
                "O piso ({floor_hps:.0} H/s) está muito abaixo do hashrate live ({live_network_hps:.0} H/s), o que pode inflacionar recompensas. Confirma?"
            )),
        };
    }
    NetworkFloorSanityResult {
        level: NetworkFloorSanityLevel::Ok,
        dominance_pct: None,
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn competitive_uses_max_of_floor_live_implied() {
        let mut runtime = HashMap::new();
        runtime.insert("btc".into(), 200.0);
        let mut implied = HashMap::new();
        implied.insert("btc".into(), 150.0);
        assert_eq!(
            effective_network_hashrate_for_coin("btc", 100.0, &runtime, &implied, false),
            200.0
        );
    }

    #[test]
    fn independent_giant_live_still_uses_floor() {
        let mut runtime = HashMap::new();
        runtime.insert("gho".into(), 1e12);
        assert_eq!(
            effective_network_hashrate_for_coin("gho", 500.0, &runtime, &HashMap::new(), true),
            500.0
        );
    }

    #[test]
    fn independent_ignores_implied() {
        let mut implied = HashMap::new();
        implied.insert("gho".into(), 100.0);
        assert_eq!(
            effective_network_hashrate_for_coin("gho", 500.0, &HashMap::new(), &implied, true),
            500.0
        );
    }

    #[test]
    fn independent_live_zero_uses_floor() {
        assert_eq!(
            effective_network_hashrate_for_coin(
                "gho",
                500.0,
                &HashMap::new(),
                &HashMap::new(),
                true
            ),
            500.0
        );
    }

    #[test]
    fn independent_ignores_live_and_implied() {
        let mut runtime = HashMap::new();
        runtime.insert("gemt".into(), 5_216.0);
        let mut implied = HashMap::new();
        implied.insert("gemt".into(), 4_869.0);
        assert_eq!(
            effective_network_hashrate_for_coin("gemt", 965.0, &runtime, &implied, true),
            965.0
        );
    }

    #[test]
    fn invert_yield() {
        // reward/sec = 10/10 = 1; yph = 0.001 → net = 1000
        assert_eq!(
            network_hashrate_from_yield_per_hash(0.001, 10.0, 10.0),
            1000.0
        );
    }
}
