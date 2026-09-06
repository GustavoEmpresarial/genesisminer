//! Timed-ASIC duration gates used by rack intents.
//! Port of `isTimedAsicDuration` / `normalizeAsicDurationConfig` / `durationMsForConfig`
//! from `lease-duration.ts`.

use crate::time::MS_PER_DAY;
use crate::utc_week::DAYS_PER_WEEK;

pub const ASIC_DURATION_KINDS: &[&str] = &["none", "daily", "weekly", "monthly", "annual"];
pub const ASIC_DURATION_UNITS: &[&str] = &["day", "week", "month", "year"];

/// Same approximation as TS `DAYS_PER_MONTH_APPROX` in `lease-duration.ts`.
/// Does not consider 28/29/30/31-day months — fixed approximation for lease/boost
/// deadlines, not exact calendar math.
pub const DAYS_PER_MONTH_APPROX: i64 = 30;

/// Same approximation as TS `DAYS_PER_YEAR_APPROX` (does not consider leap years).
pub const DAYS_PER_YEAR_APPROX: i64 = 365;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsicDurationConfig {
    pub amount: i64,
    pub unit: Option<String>,
}

pub fn normalize_asic_duration_unit(raw: Option<&str>) -> Option<String> {
    let u = raw.unwrap_or("").trim().to_ascii_lowercase();
    match u.as_str() {
        "day" | "days" | "dia" | "dias" => Some("day".into()),
        "week" | "weeks" | "semana" | "semanas" => Some("week".into()),
        "month" | "months" | "mes" | "meses" => Some("month".into()),
        "year" | "years" | "ano" | "anos" => Some("year".into()),
        _ => None,
    }
}

pub fn normalize_asic_duration_kind(raw: Option<&str>) -> String {
    let k = raw.unwrap_or("none").trim().to_ascii_lowercase();
    if ASIC_DURATION_KINDS.iter().any(|x| *x == k) {
        k
    } else {
        "none".into()
    }
}

pub fn normalize_asic_duration_config(
    amount_raw: Option<i64>,
    unit_raw: Option<&str>,
    kind_raw: Option<&str>,
) -> AsicDurationConfig {
    let amount = amount_raw.unwrap_or(0).max(0);
    let unit = normalize_asic_duration_unit(unit_raw);
    if amount > 0 && unit.is_some() {
        return AsicDurationConfig { amount, unit };
    }
    match normalize_asic_duration_kind(kind_raw).as_str() {
        "daily" => AsicDurationConfig {
            amount: 1,
            unit: Some("day".into()),
        },
        "weekly" => AsicDurationConfig {
            amount: 1,
            unit: Some("week".into()),
        },
        "monthly" => AsicDurationConfig {
            amount: 1,
            unit: Some("month".into()),
        },
        "annual" => AsicDurationConfig {
            amount: 1,
            unit: Some("year".into()),
        },
        _ => AsicDurationConfig {
            amount: 0,
            unit: None,
        },
    }
}

pub fn is_timed_asic_duration(cfg: &AsicDurationConfig) -> bool {
    cfg.amount > 0 && cfg.unit.is_some()
}

/// Milliseconds for a timed config; `0` when permanent / not timed.
pub fn duration_ms_for_config(cfg: &AsicDurationConfig) -> i64 {
    if !is_timed_asic_duration(cfg) {
        return 0;
    }
    let amount = cfg.amount;
    let day_ms = MS_PER_DAY as i64;
    match cfg.unit.as_deref() {
        Some("day") => amount * day_ms,
        Some("week") => amount * DAYS_PER_WEEK * day_ms,
        Some("month") => amount * DAYS_PER_MONTH_APPROX * day_ms,
        Some("year") => amount * DAYS_PER_YEAR_APPROX * day_ms,
        _ => 0,
    }
}

/// `from_ms + duration`, or `0` when duration is not timed.
pub fn compute_asic_lease_expires_at(cfg: &AsicDurationConfig, from_ms: i64) -> i64 {
    let ms = duration_ms_for_config(cfg);
    if ms <= 0 {
        0
    } else {
        from_ms + ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::MS_PER_DAY;
    use crate::utc_week::DAYS_PER_WEEK;

    #[test]
    fn timed_when_amount_and_unit() {
        let cfg = normalize_asic_duration_config(Some(90), Some("day"), None);
        assert!(is_timed_asic_duration(&cfg));
    }

    #[test]
    fn permanent_when_none() {
        let cfg = normalize_asic_duration_config(Some(0), None, Some("none"));
        assert!(!is_timed_asic_duration(&cfg));
    }

    #[test]
    fn duration_one_day() {
        let cfg = normalize_asic_duration_config(Some(1), Some("day"), None);
        assert_eq!(duration_ms_for_config(&cfg), MS_PER_DAY as i64);
    }

    #[test]
    fn duration_one_week() {
        let cfg = normalize_asic_duration_config(Some(1), Some("week"), None);
        assert_eq!(
            duration_ms_for_config(&cfg),
            DAYS_PER_WEEK * (MS_PER_DAY as i64)
        );
    }

    #[test]
    fn duration_one_month() {
        let cfg = normalize_asic_duration_config(Some(1), Some("month"), None);
        assert_eq!(
            duration_ms_for_config(&cfg),
            DAYS_PER_MONTH_APPROX * (MS_PER_DAY as i64)
        );
    }

    #[test]
    fn duration_one_year() {
        let cfg = normalize_asic_duration_config(Some(1), Some("year"), None);
        assert_eq!(
            duration_ms_for_config(&cfg),
            DAYS_PER_YEAR_APPROX * (MS_PER_DAY as i64)
        );
    }

    #[test]
    fn duration_zero_or_permanent_is_zero() {
        let cfg = normalize_asic_duration_config(Some(0), None, Some("none"));
        assert_eq!(duration_ms_for_config(&cfg), 0);
        assert_eq!(compute_asic_lease_expires_at(&cfg, 1_000), 0);
    }

    #[test]
    fn expires_at_adds_duration_when_timed() {
        let cfg = normalize_asic_duration_config(Some(1), Some("day"), None);
        let from_ms = MS_PER_DAY as i64;
        assert_eq!(
            compute_asic_lease_expires_at(&cfg, from_ms),
            from_ms + duration_ms_for_config(&cfg)
        );
    }
}
