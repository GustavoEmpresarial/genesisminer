//! Time unit constants — mirror of `server/shared/utils/time.ts`.

pub const MS_PER_SECOND: u64 = 1_000;
pub const SECONDS_PER_MINUTE: u64 = 60;
pub const MINUTES_PER_HOUR: u64 = 60;
pub const HOURS_PER_DAY: u64 = 24;

pub const MS_PER_MINUTE: u64 = MS_PER_SECOND * SECONDS_PER_MINUTE;
pub const MS_PER_HOUR: u64 = MS_PER_MINUTE * MINUTES_PER_HOUR;
pub const MS_PER_DAY: u64 = MS_PER_HOUR * HOURS_PER_DAY;

/// Seconds in one hour.
pub const SECONDS_PER_HOUR: u64 = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
/// Seconds in one calendar day (24h).
pub const SECONDS_PER_DAY: u64 = SECONDS_PER_HOUR * HOURS_PER_DAY;
