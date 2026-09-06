//! Semana UTC (segunda 00:00 → domingo). Espelho de `server/shared/utils/utc-week.ts`.
//!
//! Sem crate `chrono`: meia-noite UTC via `div_euclid(MS_PER_DAY)`; weekday JS
//! (`getUTCDay`, domingo = 0). 1970-01-01 foi quinta-feira → weekday 4.

use crate::time::MS_PER_DAY;

/// `getUTCDay()`: domingo = 0.
pub const UTC_WEEKDAY_SUNDAY: i64 = 0;
pub const UTC_WEEKDAY_MONDAY: i64 = 1;
/// Dias a subir de domingo até à segunda anterior.
pub const DAYS_FROM_SUNDAY_TO_MONDAY: i64 = 6;
pub const DAYS_PER_WEEK: i64 = 7;

/// 1970-01-01 UTC foi quinta-feira (`getUTCDay()` = 4).
const EPOCH_UTC_WEEKDAY_THURSDAY: i64 = 4;

/// Segunda 00:00 UTC da semana que contém `now_ms`.
pub fn utc_week_start_ms(now_ms: i64) -> i64 {
    let day_ms = MS_PER_DAY as i64;
    let midnight = now_ms.div_euclid(day_ms) * day_ms;
    let days_since_epoch = midnight.div_euclid(day_ms);
    let weekday = (days_since_epoch + EPOCH_UTC_WEEKDAY_THURSDAY).rem_euclid(DAYS_PER_WEEK);
    let diff = if weekday == UTC_WEEKDAY_SUNDAY {
        DAYS_FROM_SUNDAY_TO_MONDAY
    } else {
        weekday - UTC_WEEKDAY_MONDAY
    };
    midnight - diff * day_ms
}

/// Início da semana UTC anterior à actual.
pub fn previous_utc_week_start_ms(now_ms: i64) -> i64 {
    utc_week_start_ms(now_ms) - DAYS_PER_WEEK * (MS_PER_DAY as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures = `Date.UTC(...)` em Node (espelho de `tests/shared/utils/utc-week.test.ts`).
    const WED_2026_01_07_1530: i64 = 1_767_799_800_000;
    const MON_2026_01_05: i64 = 1_767_571_200_000;
    const SUN_2026_01_11_1200: i64 = 1_768_132_800_000;
    const MON_2025_12_29: i64 = 1_766_966_400_000;

    #[test]
    fn wed_belongs_to_monday_week() {
        assert_eq!(utc_week_start_ms(WED_2026_01_07_1530), MON_2026_01_05);
    }

    #[test]
    fn sunday_belongs_to_previous_monday() {
        assert_eq!(utc_week_start_ms(SUN_2026_01_11_1200), MON_2026_01_05);
    }

    #[test]
    fn monday_midnight_is_itself() {
        assert_eq!(utc_week_start_ms(MON_2026_01_05), MON_2026_01_05);
    }

    #[test]
    fn previous_week_of_wednesday() {
        assert_eq!(
            previous_utc_week_start_ms(WED_2026_01_07_1530),
            MON_2025_12_29
        );
    }
}
