//! Calculator domain constants — mirror of `projection.ts` / `snapshot.ts`.

use crate::time::HOURS_PER_DAY;

pub const PROJECTION_DAYS_PER_MONTH: f64 = 30.0;
pub const PROJECTION_DAYS_PER_WEEK: f64 = 7.0;
pub const PROJECTION_DAYS_PER_YEAR: f64 = 365.0;
pub const PROJECTION_30D_DAYS: f64 = PROJECTION_DAYS_PER_MONTH;

pub const BLOCK_HISTORY_LIMIT: usize = 120;
pub const MIN_NETWORK_HASHRATE: f64 = 1.0;

/// Seconds in a distribution month (30 * 86400). Denominator for the
/// `usd_month` distribution mode — see `mining::yield_boundary`.
pub const SECONDS_PER_MONTH: f64 = PROJECTION_DAYS_PER_MONTH * 86_400.0;

/// Spike guard for `usd_month` distribution: the per-boundary divisor is
/// `max(active_hashrate, DIST_MIN_HASHRATE)`. Below this the coin
/// under-distributes (`budget * active / DIST_MIN_HASHRATE`), never over —
/// the safe direction for a perpetual rate and for catch-up replay. `10.0`
/// makes a "$10 / 10 H/s" unit the break-even point.
pub const DIST_MIN_HASHRATE: f64 = 10.0;

/// Cadência de crédito (grade UTC de 10 min). No modo `usd_month` a linha da
/// moeda não tem mais `block_time` significativo, então a calculadora reporta
/// esta cadência — a real — junto do reward por bloco derivado do orçamento.
pub const USD_MONTH_DISPLAY_BLOCK_TIME_SEC: f64 = 600.0;

/// `snapshot.ts` `SCOPE_TOTAL`.
pub const SCOPE_TOTAL: &str = "total";
/// `snapshot.ts` `ROOM_ID_PATTERN` `{1,120}`.
pub const ROOM_ID_MAX_LEN: usize = 120;
/// `snapshot.ts` scopesUi name for `SCOPE_TOTAL`.
pub const SCOPE_TOTAL_UI_NAME: &str = "Poder Total";
/// `snapshot.ts` `ROOM_INITIAL_FALLBACK_NAME`.
pub const ROOM_INITIAL_FALLBACK_NAME: &str = "Sala Principal";

pub const HOUR_MULTIPLIER: f64 = 1.0 / HOURS_PER_DAY as f64;
pub const DAY_MULTIPLIER: f64 = 1.0;

pub const NFT_AUTO_ROOM_ID: &str = "room_1777158991085";
pub const NFT_AUTO_ALLOWED_CHASSIS_ID: &str = "rack_armario_1";
pub const ASIC_ROOM_ID: &str = "room_1775484506874";
/// Node `EXTRA_ROOM_ID` in `rack-room-id.ts` — granted with ASIC room on signup.
pub const EXTRA_ROOM_ID: &str = "room_1776433944492";
pub const ROOM_INITIAL_ID: &str = "room_initial";

pub const NFT_EXCLUSIVE_SYMBOLS: &[&str] = &["USDT", "USDC", "CBBTC", "DAI", "GHO", "GEMT", "GENT"];
pub const NFT_EXCLUSIVE_ID_KEYS: &[&str] = &["usdt", "usdc", "cbbtc", "dai", "gho", "gemt", "gent"];
pub const NFT_STABLE_USD_SYMBOLS: &[&str] = &["DAI", "USDT", "USDC", "GHO"];
pub const NFT_ROOM_NON_EXCLUSIVE_IDS: &[&str] = &["usdc_interno"];
pub const NFT_ROOM_NON_EXCLUSIVE_SYMBOLS: &[&str] = &["USDC_INT"];
pub const NFT_ROOM_EXCLUDED_MACHINE_IDS: &[&str] = &["gpu_iceberg_v1", "rally_v3"];
