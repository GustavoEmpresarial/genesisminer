//! Player mining projection — `coins/s = user_hps × yield_per_hash`.
//!
//! Same identity as progress / header estimates. For `usd_month`, yield comes
//! from [`usd_month_yield`] (budget ÷ active hashrate), never from dead
//! `block_reward` / catalog `network_hashrate` columns.

use super::network::effective_network_hashrate_for_coin;
use super::yield_boundary::{usd_month_yield, CoinYieldInput, DistributionMode};
use crate::calculator::constants::{
    PROJECTION_DAYS_PER_WEEK, PROJECTION_DAYS_PER_YEAR, SECONDS_PER_MONTH,
};
use crate::time::{SECONDS_PER_DAY, SECONDS_PER_HOUR};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Stable period id for API / client i18n (`hour|day|week|month|year`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionPeriod {
    pub id: &'static str,
    pub seconds: f64,
}

/// One projected window: coins and USD over `period_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionRow {
    pub period_id: String,
    pub coins: f64,
    pub usd: f64,
}

/// Canonical projection windows (hour → year). Seconds from time / calculator constants.
pub fn projection_periods() -> Vec<ProjectionPeriod> {
    vec![
        ProjectionPeriod {
            id: "hour",
            seconds: SECONDS_PER_HOUR as f64,
        },
        ProjectionPeriod {
            id: "day",
            seconds: SECONDS_PER_DAY as f64,
        },
        ProjectionPeriod {
            id: "week",
            seconds: PROJECTION_DAYS_PER_WEEK * SECONDS_PER_DAY as f64,
        },
        ProjectionPeriod {
            id: "month",
            seconds: SECONDS_PER_MONTH,
        },
        ProjectionPeriod {
            id: "year",
            seconds: PROJECTION_DAYS_PER_YEAR * SECONDS_PER_DAY as f64,
        },
    ]
}

/// Instantaneous coin rate: `user_hps × yield_per_hash`.
pub fn coins_per_sec(user_hps: f64, yield_per_hash: f64) -> f64 {
    let h = if user_hps.is_finite() && user_hps > 0.0 {
        user_hps
    } else {
        0.0
    };
    let y = if yield_per_hash.is_finite() && yield_per_hash > 0.0 {
        yield_per_hash
    } else {
        0.0
    };
    let rate = h * y;
    if rate.is_finite() && rate > 0.0 {
        rate
    } else {
        0.0
    }
}

/// Rows for each [`projection_periods`] window.
pub fn project_rows(user_hps: f64, yield_per_hash: f64, price_usd: f64) -> Vec<ProjectionRow> {
    let cps = coins_per_sec(user_hps, yield_per_hash);
    let price = if price_usd.is_finite() && price_usd > 0.0 {
        price_usd
    } else {
        0.0
    };
    projection_periods()
        .into_iter()
        .map(|p| {
            let coins = cps * p.seconds;
            let usd = coins * price;
            ProjectionRow {
                period_id: p.id.to_string(),
                coins: if coins.is_finite() { coins } else { 0.0 },
                usd: if usd.is_finite() { usd } else { 0.0 },
            }
        })
        .collect()
}

/// Resolve `(yield_per_hash, network_divisor)` for projection.
///
/// * `usd_month` — [`usd_month_yield`] with `active_or_effective_net` as live
///   active hashrate (never catalog floor / block_reward).
/// * `legacy` — `(block_reward / block_time) / effective`, where effective is
///   [`effective_network_hashrate_for_coin`] using `active_or_effective_net` as
///   the live map entry for this coin.
pub fn resolve_yield_per_hash(
    coin: &CoinYieldInput,
    active_or_effective_net: f64,
) -> (f64, f64) {
    let active = if active_or_effective_net.is_finite() && active_or_effective_net > 0.0 {
        active_or_effective_net
    } else {
        0.0
    };

    if coin.distribution_mode == DistributionMode::UsdMonth {
        let (yph, _budget, divisor) =
            usd_month_yield(coin.distribution_usd_month, coin.price_usd, active);
        return (yph, divisor);
    }

    let mut live = HashMap::new();
    if active > 0.0 {
        live.insert(coin.id.clone(), active);
    }
    let empty_implied = HashMap::new();
    let effective = effective_network_hashrate_for_coin(
        &coin.id,
        coin.network_hashrate,
        &live,
        &empty_implied,
        coin.independent_pool,
    );
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
    let reward_per_sec = if block_time > 0.0 {
        block_reward / block_time
    } else {
        0.0
    };
    let yph = if effective > 0.0 && reward_per_sec > 0.0 {
        let v = reward_per_sec / effective;
        if v.is_finite() && v > 0.0 {
            v
        } else {
            0.0
        }
    } else {
        0.0
    };
    (yph, effective)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calculator::constants::{DIST_MIN_HASHRATE, SECONDS_PER_MONTH};

    fn usd_coin(budget: f64, price: f64) -> CoinYieldInput {
        CoinYieldInput {
            id: "c".into(),
            block_reward: 0.0,
            block_time: 0.0,
            network_hashrate: 0.0,
            independent_pool: false,
            distribution_mode: DistributionMode::UsdMonth,
            distribution_usd_month: budget,
            price_usd: price,
        }
    }

    #[test]
    fn projection_periods_use_named_constants() {
        let periods = projection_periods();
        assert_eq!(periods.len(), 5);
        assert_eq!(periods[0].id, "hour");
        assert_eq!(periods[0].seconds, SECONDS_PER_HOUR as f64);
        assert_eq!(periods[1].id, "day");
        assert_eq!(periods[1].seconds, SECONDS_PER_DAY as f64);
        assert_eq!(periods[2].id, "week");
        assert_eq!(
            periods[2].seconds,
            PROJECTION_DAYS_PER_WEEK * SECONDS_PER_DAY as f64
        );
        assert_eq!(periods[3].id, "month");
        assert_eq!(periods[3].seconds, SECONDS_PER_MONTH);
        assert_eq!(periods[4].id, "year");
        assert_eq!(
            periods[4].seconds,
            PROJECTION_DAYS_PER_YEAR * SECONDS_PER_DAY as f64
        );
    }

    #[test]
    fn year_usd_matches_daily_times_days_per_year() {
        let rows = project_rows(10.0, 0.01, 2.0);
        let day = rows.iter().find(|r| r.period_id == "day").unwrap();
        let year = rows.iter().find(|r| r.period_id == "year").unwrap();
        let expected = day.usd * PROJECTION_DAYS_PER_YEAR;
        assert!((year.usd - expected).abs() < 1e-6);
    }

    #[test]
    fn usd_month_share_and_month_usd() {
        // budget $50 / month, price $1, active 100 H/s → yph = 50/SECONDS_PER_MONTH/100
        // user 10 H/s → share 10%, month_usd ≈ 5
        let coin = usd_coin(50.0, 1.0);
        let active = 100.0;
        let user = 10.0;
        let (yph, divisor) = resolve_yield_per_hash(&coin, active);
        assert!((divisor - active).abs() < 1e-12);
        let cps = coins_per_sec(user, yph);
        let month_usd = cps * SECONDS_PER_MONTH * 1.0;
        let share_pct = user / active * 100.0;
        assert!((share_pct - 10.0).abs() < 1e-9);
        assert!((month_usd - 5.0).abs() < 1e-9);
        // Cannot exceed share of budget
        assert!(month_usd <= 50.0 * (user / active) + 1e-9);
    }

    #[test]
    fn usd_month_empty_active_yields_zero() {
        let coin = usd_coin(50.0, 1.0);
        let (yph, _div) = resolve_yield_per_hash(&coin, 0.0);
        assert_eq!(yph, 0.0);
        assert_eq!(coins_per_sec(10.0, yph), 0.0);
    }

    #[test]
    fn usd_month_below_floor_never_over_budget() {
        // active 2 < DIST_MIN_HASHRATE → under-distributes
        let coin = usd_coin(SECONDS_PER_MONTH, 1.0); // $SECONDS_PER_MONTH → 1 coin/sec budget
        let active = 2.0;
        let (yph, divisor) = resolve_yield_per_hash(&coin, active);
        assert!((divisor - DIST_MIN_HASHRATE).abs() < 1e-12);
        let total_paid_month = yph * active * SECONDS_PER_MONTH;
        assert!(total_paid_month < SECONDS_PER_MONTH);
        assert!((total_paid_month - SECONDS_PER_MONTH * active / DIST_MIN_HASHRATE).abs() < 1e-6);
    }

    #[test]
    fn legacy_path_uses_block_reward_over_effective() {
        let coin = CoinYieldInput {
            id: "leg".into(),
            block_reward: 60.0,
            block_time: 60.0, // 1 coin/sec
            network_hashrate: 100.0,
            independent_pool: false,
            distribution_mode: DistributionMode::Legacy,
            distribution_usd_month: 0.0,
            price_usd: 0.0,
        };
        let (yph, divisor) = resolve_yield_per_hash(&coin, 100.0);
        assert!((divisor - 100.0).abs() < 1e-12);
        assert!((yph - 0.01).abs() < 1e-12);
        let rows = project_rows(10.0, yph, 2.0);
        let day = rows.iter().find(|r| r.period_id == "day").unwrap();
        // 10 * 0.01 * 86400 = 8640 coins; * $2 = 17280
        assert!((day.coins - 8640.0).abs() < 1e-6);
        assert!((day.usd - 17280.0).abs() < 1e-6);
    }

    #[test]
    fn project_rows_zero_when_no_power() {
        let rows = project_rows(0.0, 1.0, 1.0);
        assert!(rows.iter().all(|r| r.coins == 0.0 && r.usd == 0.0));
    }
}
