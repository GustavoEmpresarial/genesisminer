//! Black-market / P2P domain helpers — page clamps, tax, reserve timing, band reference.
//! Player mutations / reads run in `genesis-hardware` (`/v1/market/*`) when
//! `GENESIS_HARDWARE_URL` is set. Node Express stays JWT / rate-limit / Kafka / WS.

use crate::time::MS_PER_MINUTE;

/// Minutes a listing stays reserved for a buyer before purchase.
pub const MARKET_RESERVE_MINUTES: u64 = 3;
/// Reserve window in ms (`MARKET_RESERVE_MINUTES * MS_PER_MINUTE`).
pub const MARKET_RESERVE_MS: i64 = (MARKET_RESERVE_MINUTES * MS_PER_MINUTE) as i64;

pub const BLACK_MARKET_MAX_PAGE: i64 = 100;
pub const BLACK_MARKET_DEFAULT_LIMIT: i64 = 60;
pub const BLACK_MARKET_MAX_OFFSET: i64 = 50_000;

pub const TAX_PERCENT_MIN: f64 = 0.0;
pub const TAX_PERCENT_MAX: f64 = 100.0;

/// Node `listing-mapper.ts` price-band clamp (percent points).
pub const PRICE_BAND_MIN_PERCENT: f64 = 1.0;
pub const PRICE_BAND_MAX_PERCENT: f64 = 90.0;
pub const PRICE_BAND_DEFAULT_PERCENT: f64 = 20.0;

/// Clamp P2P price-band percent into `[PRICE_BAND_MIN_PERCENT, PRICE_BAND_MAX_PERCENT]`.
/// Non-finite → `PRICE_BAND_DEFAULT_PERCENT`.
pub fn clamp_price_band_percent(raw: f64) -> f64 {
    if !raw.is_finite() {
        return PRICE_BAND_DEFAULT_PERCENT;
    }
    raw.max(PRICE_BAND_MIN_PERCENT).min(PRICE_BAND_MAX_PERCENT)
}

/// Safe page size for P2P book queries. Invalid / missing → default.
pub fn clamp_limit(n: Option<i64>) -> i64 {
    match n {
        Some(v) if v >= 1 => v.min(BLACK_MARKET_MAX_PAGE),
        _ => BLACK_MARKET_DEFAULT_LIMIT,
    }
}

/// Safe offset for P2P book queries. Invalid / missing / negative → 0.
pub fn clamp_offset(n: Option<i64>) -> i64 {
    match n {
        Some(v) if v >= 0 => v.min(BLACK_MARKET_MAX_OFFSET),
        _ => 0,
    }
}

/// Clamp market tax percent into `[TAX_PERCENT_MIN, TAX_PERCENT_MAX]`.
/// Non-finite → `TAX_PERCENT_MIN`.
pub fn clamp_tax_percent(raw: f64) -> f64 {
    if !raw.is_finite() {
        return TAX_PERCENT_MIN;
    }
    raw.max(TAX_PERCENT_MIN).min(TAX_PERCENT_MAX)
}

/// Active reservation when `reserved_until` is present and strictly after `now_ms`.
pub fn is_reservation_active(reserved_until_ms: Option<i64>, now_ms: i64) -> bool {
    match reserved_until_ms {
        Some(until) => until > now_ms,
        None => false,
    }
}

/// Epoch ms when a new reservation expires (`now + MARKET_RESERVE_MS`).
pub fn compute_reserved_until(now_ms: i64) -> i64 {
    now_ms.saturating_add(MARKET_RESERVE_MS)
}

/// P2P ±band% reference USD: shop `base_cost` when valid (>0), else book fallback, else 0.
pub fn compute_p2p_band_reference_usd(base_cost: f64, book_fallback: Option<f64>) -> f64 {
    if base_cost.is_finite() && base_cost > 0.0 {
        return base_cost;
    }
    match book_fallback {
        Some(m) if m.is_finite() && m > 0.0 => m,
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_ms_matches_minutes() {
        assert_eq!(MARKET_RESERVE_MS, (3 * MS_PER_MINUTE) as i64);
    }

    #[test]
    fn clamp_limit_defaults_and_caps() {
        assert_eq!(clamp_limit(None), BLACK_MARKET_DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), BLACK_MARKET_DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(-5)), BLACK_MARKET_DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(500)), BLACK_MARKET_MAX_PAGE);
        assert_eq!(clamp_limit(Some(25)), 25);
    }

    #[test]
    fn clamp_offset_defaults_and_caps() {
        assert_eq!(clamp_offset(None), 0);
        assert_eq!(clamp_offset(Some(-1)), 0);
        assert_eq!(clamp_offset(Some(999_999)), BLACK_MARKET_MAX_OFFSET);
        assert_eq!(clamp_offset(Some(10)), 10);
    }

    #[test]
    fn clamp_tax_percent_bounds() {
        assert_eq!(clamp_tax_percent(-1.0), TAX_PERCENT_MIN);
        assert_eq!(clamp_tax_percent(150.0), TAX_PERCENT_MAX);
        assert_eq!(clamp_tax_percent(12.5), 12.5);
        assert_eq!(clamp_tax_percent(f64::NAN), TAX_PERCENT_MIN);
    }

    #[test]
    fn reservation_active_strict_gt() {
        let now = 1_700_000_000_000_i64;
        assert!(!is_reservation_active(None, now));
        assert!(!is_reservation_active(Some(now), now));
        assert!(is_reservation_active(Some(now + 1), now));
        assert!(!is_reservation_active(Some(now - 1), now));
    }

    #[test]
    fn reserved_until_adds_window() {
        let now = 1_000_i64;
        assert_eq!(compute_reserved_until(now), now + MARKET_RESERVE_MS);
    }

    #[test]
    fn band_reference_prefers_base_cost() {
        assert_eq!(compute_p2p_band_reference_usd(10.0, Some(99.0)), 10.0);
        assert_eq!(compute_p2p_band_reference_usd(0.0, Some(5.0)), 5.0);
        assert_eq!(compute_p2p_band_reference_usd(-1.0, Some(5.0)), 5.0);
        assert_eq!(compute_p2p_band_reference_usd(0.0, None), 0.0);
        assert_eq!(compute_p2p_band_reference_usd(0.0, Some(0.0)), 0.0);
    }

    #[test]
    fn clamp_price_band_percent_bounds() {
        assert_eq!(
            clamp_price_band_percent(f64::NAN),
            PRICE_BAND_DEFAULT_PERCENT
        );
        assert_eq!(clamp_price_band_percent(0.0), PRICE_BAND_MIN_PERCENT);
        assert_eq!(clamp_price_band_percent(100.0), PRICE_BAND_MAX_PERCENT);
        assert_eq!(clamp_price_band_percent(20.0), PRICE_BAND_DEFAULT_PERCENT);
        assert_eq!(clamp_price_band_percent(15.0), 15.0);
    }
}
