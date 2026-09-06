//! Wallet desk liquidation helpers — percent shortcuts + fraction gates.
//! Deposits / on-chain RPC stay in Node.

/// Desk UI shortcuts (percentage points).
pub const DESK_PERCENT_10: u32 = 10;
pub const DESK_PERCENT_50: u32 = 50;
pub const DESK_PERCENT_100: u32 = 100;

pub const DESK_FRACTION_10PCT: f64 = 0.1;
pub const DESK_FRACTION_50PCT: f64 = 0.5;
pub const DESK_FRACTION_100PCT: f64 = 1.0;

pub const FRACTION_MODE_DESK_SHORTCUTS: &str = "desk_shortcuts";
pub const FRACTION_MODE_LEGACY: &str = "legacy";

/// Accept only exact desk shortcuts 10 / 50 / 100.
pub fn parse_desk_liquidation_percentage_points(raw: f64) -> Option<u32> {
    if !raw.is_finite() {
        return None;
    }
    if raw == f64::from(DESK_PERCENT_10) {
        return Some(DESK_PERCENT_10);
    }
    if raw == f64::from(DESK_PERCENT_50) {
        return Some(DESK_PERCENT_50);
    }
    if raw == f64::from(DESK_PERCENT_100) {
        return Some(DESK_PERCENT_100);
    }
    None
}

/// Map desk percent points → liquidation fraction.
pub fn desk_percent_to_fraction(percent: u32) -> Option<f64> {
    match percent {
        DESK_PERCENT_10 => Some(DESK_FRACTION_10PCT),
        DESK_PERCENT_50 => Some(DESK_FRACTION_50PCT),
        DESK_PERCENT_100 => Some(DESK_FRACTION_100PCT),
        _ => None,
    }
}

/// `desk_shortcuts`: only 0.1 / 0.5 / 1.0. `legacy`: (0, 1].
pub fn fraction_allowed(fraction: f64, mode: &str) -> bool {
    if !fraction.is_finite() {
        return false;
    }
    match mode {
        FRACTION_MODE_DESK_SHORTCUTS => {
            fraction == DESK_FRACTION_10PCT
                || fraction == DESK_FRACTION_50PCT
                || fraction == DESK_FRACTION_100PCT
        }
        FRACTION_MODE_LEGACY => fraction > 0.0 && fraction <= 1.0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_desk_percents() {
        assert_eq!(parse_desk_liquidation_percentage_points(10.0), Some(10));
        assert_eq!(parse_desk_liquidation_percentage_points(50.0), Some(50));
        assert_eq!(parse_desk_liquidation_percentage_points(100.0), Some(100));
        assert_eq!(parse_desk_liquidation_percentage_points(25.0), None);
        assert_eq!(parse_desk_liquidation_percentage_points(f64::NAN), None);
    }

    #[test]
    fn percent_to_fraction() {
        assert_eq!(desk_percent_to_fraction(10), Some(0.1));
        assert_eq!(desk_percent_to_fraction(50), Some(0.5));
        assert_eq!(desk_percent_to_fraction(100), Some(1.0));
        assert_eq!(desk_percent_to_fraction(25), None);
    }

    #[test]
    fn fraction_desk_shortcuts() {
        assert!(fraction_allowed(0.1, FRACTION_MODE_DESK_SHORTCUTS));
        assert!(fraction_allowed(0.5, FRACTION_MODE_DESK_SHORTCUTS));
        assert!(fraction_allowed(1.0, FRACTION_MODE_DESK_SHORTCUTS));
        assert!(!fraction_allowed(0.33, FRACTION_MODE_DESK_SHORTCUTS));
    }

    #[test]
    fn fraction_legacy() {
        assert!(fraction_allowed(0.33, FRACTION_MODE_LEGACY));
        assert!(fraction_allowed(1.0, FRACTION_MODE_LEGACY));
        assert!(!fraction_allowed(0.0, FRACTION_MODE_LEGACY));
        assert!(!fraction_allowed(1.01, FRACTION_MODE_LEGACY));
        assert!(!fraction_allowed(-0.1, FRACTION_MODE_LEGACY));
    }
}
