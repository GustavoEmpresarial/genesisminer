//! Check-in diário — ciclo UTC 00:00 + grace 48h para mineração.
//! Espelha `server/modules/checkin/services/checkin.ts` (math pura).

mod window;

pub use window::{
    can_early_checkin_for_next_period, has_checked_in_current_period, is_checkin_frozen_at_ms,
    is_checkin_frozen_for_mining, is_early_checkin_timestamp, is_premium_within_active_window,
    is_within_active_checkin_window, next_checkin_period_end_ms, next_checkin_period_start_ms,
    next_utc_day, premium_interval_ms, previous_utc_day, utc_checkin_period_start_ms,
    utc_day_from_ms, utc_day_start_ms, CHECKIN_CYCLE_HOUR_UTC, CHECKIN_EARLY_WINDOW_MS,
    CHECKIN_GRACE_MS, CHECKIN_TIMEZONE, CHECKIN_WINDOW_MS, DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
    DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
};
