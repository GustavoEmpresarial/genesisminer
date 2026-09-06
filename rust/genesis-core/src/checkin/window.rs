//! Janela de check-in: dia civil UTC [00:00, 00:00+1d) e freeze após 48h.

use crate::time::MS_PER_DAY;

pub const CHECKIN_TIMEZONE: &str = "UTC";
pub const CHECKIN_CYCLE_HOUR_UTC: u32 = 0;
pub const CHECKIN_WINDOW_MS: u64 = MS_PER_DAY;
/// Mineração continua até 48h após o último check-in.
pub const CHECKIN_GRACE_MS: u64 = 2 * MS_PER_DAY;
/// Antecipação desactivada (check-in a qualquer hora do dia UTC).
pub const CHECKIN_EARLY_WINDOW_MS: u64 = 0;

fn is_ymd(day: &str) -> bool {
    if day.len() != 10 {
        return false;
    }
    let b = day.as_bytes();
    b[4] == b'-'
        && b[7] == b'-'
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
}

fn parse_ymd(day: &str) -> Option<(i32, u32, u32)> {
    if !is_ymd(day) {
        return None;
    }
    let y: i32 = day[0..4].parse().ok()?;
    let m: u32 = day[5..7].parse().ok()?;
    let d: u32 = day[8..10].parse().ok()?;
    Some((y, m, d))
}

fn format_ymd(y: i32, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// Dia civil UTC `YYYY-MM-DD` para o instante.
pub fn utc_day_from_ms(ms: i64) -> String {
    let safe = ms.max(0);
    let days = safe.div_euclid(MS_PER_DAY as i64);
    let (y, m, d) = civil_from_days(days);
    format_ymd(y, m, d)
}

/// Início UTC 00:00 do dia civil `ymd`.
pub fn utc_day_start_ms(ymd: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(ymd)?;
    // Date.UTC(y, m-1, d, 0, 0, 0)
    let days = days_from_civil(y, m as i32, d as i32);
    Some(days * MS_PER_DAY as i64)
}

pub fn previous_utc_day(day: &str) -> String {
    let Some((y, m, d)) = parse_ymd(day) else {
        return day.to_string();
    };
    let days = days_from_civil(y, m as i32, d as i32) - 1;
    let (yy, mm, dd) = civil_from_days(days);
    format_ymd(yy, mm, dd)
}

pub fn next_utc_day(day: &str) -> String {
    let Some((y, m, d)) = parse_ymd(day) else {
        return day.to_string();
    };
    let days = days_from_civil(y, m as i32, d as i32) + 1;
    let (yy, mm, dd) = civil_from_days(days);
    format_ymd(yy, mm, dd)
}

/// Início do ciclo UTC [00:00 D, 00:00 D+1) que contém `now_ms`.
pub fn utc_checkin_period_start_ms(now_ms: i64) -> i64 {
    let ymd = utc_day_from_ms(now_ms);
    utc_day_start_ms(&ymd).unwrap_or(0)
}

pub fn next_checkin_period_end_ms(period_start_ms: i64) -> i64 {
    period_start_ms + CHECKIN_WINDOW_MS as i64
}

pub fn next_checkin_period_start_ms(now_ms: i64) -> i64 {
    next_checkin_period_end_ms(utc_checkin_period_start_ms(now_ms))
}

fn normalize_last(last: Option<i64>) -> Option<i64> {
    last.filter(|v| *v > 0)
}

/// Já fez check-in no dia UTC actual.
pub fn has_checked_in_current_period(last_checkin_at_ms: Option<i64>, now_ms: i64) -> bool {
    let Some(at) = normalize_last(last_checkin_at_ms) else {
        return false;
    };
    utc_checkin_period_start_ms(at) == utc_checkin_period_start_ms(now_ms)
}

/// Mineração activa enquanto `now - last <= 48h`.
pub fn is_within_active_checkin_window(last_checkin_at_ms: Option<i64>, now_ms: i64) -> bool {
    let Some(at) = normalize_last(last_checkin_at_ms) else {
        return false;
    };
    now_ms.saturating_sub(at) <= CHECKIN_GRACE_MS as i64
}

pub fn is_checkin_frozen_at_ms(last_checkin_at_ms: Option<i64>, now_ms: i64) -> bool {
    !is_within_active_checkin_window(last_checkin_at_ms, now_ms)
}

// --- Premium weekly check-in (espelha `server/modules/checkin/services/premium-policy.ts`) ---

/// Default de parse quando settings ausentes / inválidos (worker lê settings em prod).
pub const DEFAULT_CHECKIN_PREMIUM_MIN_USDC: f64 = 195.0;
/// Default de parse / fallback quando `interval_days < 1`.
pub const DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS: i32 = 7;

/// `interval_days * MS_PER_DAY`; se `interval_days < 1`, usa [`DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS`].
pub fn premium_interval_ms(interval_days: i32) -> i64 {
    let days = if interval_days >= 1 {
        interval_days
    } else {
        DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS
    };
    i64::from(days) * MS_PER_DAY as i64
}

/// Mineração activa na janela premium: `now - last < premium_interval_ms` (strict `<`, como TS).
pub fn is_premium_within_active_window(
    last_checkin_at_ms: Option<i64>,
    now_ms: i64,
    interval_days: i32,
) -> bool {
    let Some(at) = normalize_last(last_checkin_at_ms) else {
        return false;
    };
    now_ms.saturating_sub(at) < premium_interval_ms(interval_days)
}

/// Freeze para crédito de mineração — espelha `isCheckinFrozenForUser` em `checkin.ts`.
/// Se `premium_weekly`: fora da janela premium; senão: grace 48h (`<= CHECKIN_GRACE_MS`).
pub fn is_checkin_frozen_for_mining(
    last_checkin_at_ms: Option<i64>,
    now_ms: i64,
    premium_weekly: bool,
    interval_days: i32,
) -> bool {
    if premium_weekly {
        !is_premium_within_active_window(last_checkin_at_ms, now_ms, interval_days)
    } else {
        is_checkin_frozen_at_ms(last_checkin_at_ms, now_ms)
    }
}

/// Antecipação desligada — sempre false.
pub fn can_early_checkin_for_next_period(_last: Option<i64>, _now_ms: i64) -> bool {
    false
}

/// Legado: reconhece registo antigo antecipado (não usado no fluxo novo).
pub fn is_early_checkin_timestamp(_last_checkin_at_ms: i64, _now_ms: i64) -> bool {
    false
}

/// Howard Hinnant civil_from_days / days_from_civil.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn days_from_civil(y: i32, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = m as u64;
    let d = d as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era as i64) * 146_097 + doe as i64 - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::MS_PER_HOUR;

    #[test]
    fn utc_day_boundary() {
        assert_eq!(utc_day_from_ms(date_utc(2026, 1, 1, 0, 0, 0)), "2026-01-01");
        assert_eq!(
            utc_day_from_ms(date_utc(2026, 1, 1, 0, 0, 0) - 1),
            "2025-12-31"
        );
        assert_eq!(
            utc_checkin_period_start_ms(date_utc(2026, 1, 1, 15, 30, 0)),
            date_utc(2026, 1, 1, 0, 0, 0)
        );
    }

    #[test]
    fn grace_48h() {
        let last = date_utc(2026, 1, 1, 12, 0, 0);
        assert!(is_within_active_checkin_window(
            Some(last),
            last + CHECKIN_GRACE_MS as i64
        ));
        assert!(!is_within_active_checkin_window(
            Some(last),
            last + CHECKIN_GRACE_MS as i64 + 1
        ));
        assert!(has_checked_in_current_period(
            Some(last),
            date_utc(2026, 1, 1, 23, 0, 0)
        ));
        assert!(!has_checked_in_current_period(
            Some(last),
            date_utc(2026, 1, 2, 0, 0, 0)
        ));
    }

    #[test]
    fn early_always_false() {
        assert!(!can_early_checkin_for_next_period(Some(1), 2));
        assert!(!is_early_checkin_timestamp(1, 2));
    }

    #[test]
    fn premium_7d_active_at_3d_frozen_at_exact_7d() {
        let last = date_utc(2026, 1, 1, 12, 0, 0);
        let three_days = last + 3 * MS_PER_DAY as i64;
        let seven_days = last + 7 * MS_PER_DAY as i64;
        assert!(is_premium_within_active_window(Some(last), three_days, 7));
        assert!(!is_checkin_frozen_for_mining(
            Some(last),
            three_days,
            true,
            7
        ));
        // strict `<` — exactamente no fim do intervalo já está frozen
        assert!(!is_premium_within_active_window(Some(last), seven_days, 7));
        assert!(is_checkin_frozen_for_mining(
            Some(last),
            seven_days,
            true,
            7
        ));
    }

    #[test]
    fn premium_weekly_false_keeps_48h_grace() {
        let last = date_utc(2026, 1, 1, 12, 0, 0);
        let at_grace = last + CHECKIN_GRACE_MS as i64;
        let past_grace = at_grace + 1;
        assert!(!is_checkin_frozen_for_mining(
            Some(last),
            at_grace,
            false,
            7
        ));
        assert!(is_checkin_frozen_for_mining(
            Some(last),
            past_grace,
            false,
            7
        ));
        // ainda dentro de 7d mas fora de 48h → frozen se não-premium
        let at_3d = last + 3 * MS_PER_DAY as i64;
        assert!(is_checkin_frozen_for_mining(Some(last), at_3d, false, 7));
        assert!(!is_checkin_frozen_for_mining(Some(last), at_3d, true, 7));
    }

    #[test]
    fn premium_interval_days_zero_falls_back_to_7() {
        assert_eq!(
            premium_interval_ms(0),
            i64::from(DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS) * MS_PER_DAY as i64
        );
        assert_eq!(premium_interval_ms(0), premium_interval_ms(7));
        let last = date_utc(2026, 1, 1, 0, 0, 0);
        // com days=0 (fallback 7): activo a +3d
        assert!(is_premium_within_active_window(
            Some(last),
            last + 3 * MS_PER_DAY as i64,
            0
        ));
        assert!(!is_premium_within_active_window(
            Some(last),
            last + 7 * MS_PER_DAY as i64,
            0
        ));
    }

    fn date_utc(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        let days = days_from_civil(y, m as i32, d as i32);
        days * MS_PER_DAY as i64
            + (h as i64) * MS_PER_HOUR as i64
            + (mi as i64) * 60_000
            + (s as i64) * 1_000
    }
}
