//! Saúde do projecto a partir das publicações de transparência.
//! Fonte única espelhada do client (`health.ts`).
//!
//! Caixa real: Relatórios → Transações USDC on-chain (entradas/saídas tesouraria).
//! Portal: pool + trade − despesa.
//! `investment` e `other` são informativos — não entram na base.
//! Piso 50. Dia = America/Sao_Paulo (BRT, offset fixo −03:00 desde 2019).

use serde::{Deserialize, Serialize};

use crate::time::{MS_PER_DAY, MS_PER_HOUR};

pub const TRANSPARENCY_HEALTH_FLOOR: i32 = 50;
pub const TRANSPARENCY_HEALTH_CEILING: i32 = 100;
pub const TRANSPARENCY_HEALTH_TZ: &str = "America/Sao_Paulo";
/// BRT fixed offset (no DST).
const BRT_OFFSET_MS: i64 = -3 * MS_PER_HOUR as i64;

pub const HEALTH_WEIGHT_INFLOW: f64 = 0.4;
pub const HEALTH_WEIGHT_RENT: f64 = 0.35;
pub const HEALTH_WEIGHT_LEDGER: f64 = 0.25;

/// Season window default — `2026-09-01T00:00:00Z`. Seeds `transparency_health_settings`.
pub const HEALTH_SEASON_START_MS_DEFAULT: i64 = 1_788_220_800_000;

/// Which published entries are charged against the season's cash flows.
///
/// The on-chain side (deposits/withdrawals) is always windowed by `season_start_ms`.
/// Before this existed, entries were summed all-time against one month of deposits —
/// a single 2025-12 expense could pin the index at the floor forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthPeriodScope {
    /// `period_ym` at or after the season start month.
    Season,
    /// Everything, regardless of `period_ym` (legacy behaviour).
    AllTime,
    /// Only the current UTC month.
    CurrentMonth,
}

impl HealthPeriodScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Season => "season",
            Self::AllTime => "all_time",
            Self::CurrentMonth => "current_month",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "season" => Some(Self::Season),
            "all_time" => Some(Self::AllTime),
            "current_month" => Some(Self::CurrentMonth),
            _ => None,
        }
    }
}

/// Admin-tunable knobs. `Default` reproduces the historical hard-coded behaviour, so a
/// fresh install (or a failed settings read) computes exactly what it computed before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSettings {
    pub weight_inflow: f64,
    pub weight_rent: f64,
    pub weight_ledger: f64,
    pub floor: i32,
    pub season_start_ms: i64,
    pub period_scope: HealthPeriodScope,
    /// Entries with no `period_ym` ("geral / permanente") count in every window.
    pub count_undated: bool,
    pub override_enabled: bool,
    pub override_value: Option<i32>,
}

impl Default for HealthSettings {
    fn default() -> Self {
        Self {
            weight_inflow: HEALTH_WEIGHT_INFLOW,
            weight_rent: HEALTH_WEIGHT_RENT,
            weight_ledger: HEALTH_WEIGHT_LEDGER,
            floor: TRANSPARENCY_HEALTH_FLOOR,
            season_start_ms: HEALTH_SEASON_START_MS_DEFAULT,
            period_scope: HealthPeriodScope::AllTime,
            count_undated: true,
            override_enabled: false,
            override_value: None,
        }
    }
}

impl HealthSettings {
    /// Weights that always sum to 1. Bad input (non-finite, negative, all-zero) falls back
    /// to the defaults rather than producing a silently meaningless score.
    pub fn normalized_weights(&self) -> (f64, f64, f64) {
        let (i, r, l) = (self.weight_inflow, self.weight_rent, self.weight_ledger);
        if ![i, r, l].iter().all(|w| w.is_finite() && *w >= 0.0) {
            return (
                HEALTH_WEIGHT_INFLOW,
                HEALTH_WEIGHT_RENT,
                HEALTH_WEIGHT_LEDGER,
            );
        }
        let sum = i + r + l;
        if sum <= 0.0 {
            return (
                HEALTH_WEIGHT_INFLOW,
                HEALTH_WEIGHT_RENT,
                HEALTH_WEIGHT_LEDGER,
            );
        }
        (i / sum, r / sum, l / sum)
    }

    pub fn effective_floor(&self) -> i32 {
        self.floor.clamp(0, TRANSPARENCY_HEALTH_CEILING)
    }

    /// The manual score, when the admin pinned one.
    pub fn manual_health(&self) -> Option<i32> {
        if !self.override_enabled {
            return None;
        }
        self.override_value
            .map(|v| v.clamp(0, TRANSPARENCY_HEALTH_CEILING))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransparencyHealthCategory {
    Pool,
    Trade,
    Investment,
    Expense,
    Other,
}

impl TransparencyHealthCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pool => "pool",
            Self::Trade => "trade",
            Self::Investment => "investment",
            Self::Expense => "expense",
            Self::Other => "other",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pool" => Some(Self::Pool),
            "trade" => Some(Self::Trade),
            "investment" => Some(Self::Investment),
            "expense" => Some(Self::Expense),
            "other" => Some(Self::Other),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthBand {
    Excellent,
    Healthy,
    Neutral,
}

impl HealthBand {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Excellent => "excellent",
            Self::Healthy => "healthy",
            Self::Neutral => "neutral",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransparencyHealthEntry {
    pub category: Option<String>,
    pub amount_usdc: Option<f64>,
    pub created_at: Option<f64>,
    /// `YYYY-MM`, or `None` for "geral / permanente". Mirrors `transparency_entries.period_ym`.
    #[serde(default)]
    pub period_ym: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCashFlows {
    pub deposits_usdc: Option<f64>,
    pub withdrawals_usdc: Option<f64>,
    pub day_deposits_usdc: Option<f64>,
    pub day_withdrawals_usdc: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransparencyHealthSnapshot {
    pub pool_usdc: f64,
    pub trade_usdc: f64,
    pub investment_usdc: f64,
    pub expense_usdc: f64,
    pub other_usdc: f64,
    pub deposits_usdc: f64,
    pub withdrawals_usdc: f64,
    pub total_in_usdc: f64,
    pub total_out_usdc: f64,
    pub net_profit_usdc: f64,
    pub day_in_usdc: f64,
    pub day_out_usdc: f64,
    pub day_profit_usdc: f64,
    pub day_deposits_usdc: f64,
    pub day_withdrawals_usdc: f64,
    pub efficiency_pct: f64,
    pub inflow_score: f64,
    pub rent_score: f64,
    pub ledger_score: f64,
    pub health: i32,
    pub band: HealthBand,
    pub has_amounts: bool,
}

pub fn normalize_health_category(raw: Option<&str>) -> TransparencyHealthCategory {
    raw.and_then(TransparencyHealthCategory::parse)
        .unwrap_or(TransparencyHealthCategory::Other)
}

pub fn entry_time_ms(created_at: Option<f64>) -> i64 {
    let Some(n) = created_at else {
        return 0;
    };
    if !n.is_finite() {
        return 0;
    }
    if n < 1e12 {
        (n * 1000.0) as i64
    } else {
        n as i64
    }
}

/// Civil Y-M-D from Unix day count (Howard Hinnant).
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

fn ymd_brt(ms: i64) -> Option<(i32, u32, u32)> {
    if ms <= 0 {
        return None;
    }
    let local = ms + BRT_OFFSET_MS;
    let days = local.div_euclid(MS_PER_DAY as i64);
    Some(civil_from_days(days))
}

pub fn is_same_zoned_day(ms: i64, now_ms: i64) -> bool {
    match (ymd_brt(ms), ymd_brt(now_ms)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

pub fn health_band(score: i32) -> HealthBand {
    if score >= 85 {
        HealthBand::Excellent
    } else if score >= 70 {
        HealthBand::Healthy
    } else {
        HealthBand::Neutral
    }
}

pub fn clamp_health(raw: f64) -> i32 {
    clamp_health_with(raw, TRANSPARENCY_HEALTH_FLOOR)
}

pub fn clamp_health_with(raw: f64, floor: i32) -> i32 {
    let floor = floor.clamp(0, TRANSPARENCY_HEALTH_CEILING);
    if !raw.is_finite() {
        return floor;
    }
    let rounded = raw.round() as i32;
    rounded.clamp(floor, TRANSPARENCY_HEALTH_CEILING)
}

/// `YYYY-MM` for a UTC instant. Period keys are UTC — same basis as the client's
/// `currentPeriodYmUtc` in `client/src/features/transparency/lib/periodYm.ts`.
pub fn period_ym_from_ms(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    let days = ms.div_euclid(MS_PER_DAY as i64);
    let (y, m, _) = civil_from_days(days);
    Some(format!("{y:04}-{m:02}"))
}

/// Trims and validates `YYYY-MM`; "", "geral" and "standing" mean "no period".
/// Twin of `normalizePeriodYm` in `client/src/features/transparency/lib/periodYm.ts`.
pub fn normalize_period_ym(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s == "geral" || s == "standing" {
        return None;
    }
    let b = s.as_bytes();
    if b.len() != 7 || b[4] != b'-' {
        return None;
    }
    if !b[0..4].iter().all(u8::is_ascii_digit) || !b[5..7].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let month = (b[5] - b'0') * 10 + (b[6] - b'0');
    if !(1..=12).contains(&month) {
        return None;
    }
    Some(s.to_string())
}

/// Whether a published entry is charged against the current window.
pub fn entry_in_scope(
    period_ym: Option<&str>,
    now_ms: i64,
    settings: &HealthSettings,
) -> bool {
    let period = normalize_period_ym(period_ym);
    let Some(period) = period else {
        // "Geral / permanente": counted in every window unless the admin says otherwise.
        return settings.count_undated;
    };
    match settings.period_scope {
        HealthPeriodScope::AllTime => true,
        // `YYYY-MM` sorts lexicographically, so string compare is date compare.
        HealthPeriodScope::Season => match period_ym_from_ms(settings.season_start_ms) {
            Some(start) => period.as_str() >= start.as_str(),
            None => true,
        },
        HealthPeriodScope::CurrentMonth => match period_ym_from_ms(now_ms) {
            Some(current) => period == current,
            None => true,
        },
    }
}

fn clamp_pct(raw: f64) -> f64 {
    if !raw.is_finite() {
        return 0.0;
    }
    raw.clamp(0.0, 100.0)
}

pub fn score_inflow(deposits_usdc: f64, withdrawals_usdc: f64) -> f64 {
    let volume = (20.0 * (1.0 + deposits_usdc.max(0.0)).log10()).min(100.0);
    let both = deposits_usdc + withdrawals_usdc;
    let coverage = if both <= 0.0 {
        50.0
    } else {
        (deposits_usdc / both) * 100.0
    };
    clamp_pct(0.55 * volume + 0.45 * coverage)
}

pub fn score_rent(deposits_usdc: f64, withdrawals_usdc: f64) -> f64 {
    if !(deposits_usdc > 0.0) {
        return 50.0;
    }
    clamp_pct(((deposits_usdc - withdrawals_usdc) / deposits_usdc) * 100.0)
}

pub fn score_published_ledger(pool_usdc: f64, trade_usdc: f64, expense_usdc: f64) -> f64 {
    let published_in = pool_usdc.max(0.0) + trade_usdc.max(0.0);
    let published_out = expense_usdc.max(0.0);
    if published_in <= 0.0 && published_out <= 0.0 {
        return 50.0;
    }
    if published_in <= 0.0 {
        return if published_out > 0.0 { 0.0 } else { 50.0 };
    }
    clamp_pct(((published_in - published_out) / published_in) * 100.0)
}

fn counts_in_portal_ledger(cat: TransparencyHealthCategory) -> bool {
    matches!(
        cat,
        TransparencyHealthCategory::Pool
            | TransparencyHealthCategory::Trade
            | TransparencyHealthCategory::Expense
    )
}

fn finite_or_zero(v: Option<f64>) -> f64 {
    v.filter(|n| n.is_finite()).unwrap_or(0.0)
}

/// Back-compat wrapper: historical behaviour (all-time entries, fixed 40/35/25, floor 50).
pub fn compute_transparency_health(
    entries: &[TransparencyHealthEntry],
    now_ms: i64,
    cash: &PlayerCashFlows,
) -> TransparencyHealthSnapshot {
    compute_transparency_health_with(entries, now_ms, cash, &HealthSettings::default())
}

pub fn compute_transparency_health_with(
    entries: &[TransparencyHealthEntry],
    now_ms: i64,
    cash: &PlayerCashFlows,
    settings: &HealthSettings,
) -> TransparencyHealthSnapshot {
    let mut pool_usdc = 0.0;
    let mut trade_usdc = 0.0;
    let mut investment_usdc = 0.0;
    let mut expense_usdc = 0.0;
    let mut other_usdc = 0.0;
    let mut day_published_in = 0.0;
    let mut day_published_out = 0.0;
    let deposits_usdc = finite_or_zero(cash.deposits_usdc);
    let withdrawals_usdc = finite_or_zero(cash.withdrawals_usdc);
    let day_deposits_usdc = finite_or_zero(cash.day_deposits_usdc);
    let day_withdrawals_usdc = finite_or_zero(cash.day_withdrawals_usdc);
    let mut has_amounts = deposits_usdc > 0.0 || withdrawals_usdc > 0.0;

    for entry in entries {
        let Some(amt) = entry.amount_usdc.filter(|n| n.is_finite()) else {
            continue;
        };
        if !entry_in_scope(entry.period_ym.as_deref(), now_ms, settings) {
            continue;
        }
        has_amounts = true;
        let cat = normalize_health_category(entry.category.as_deref());
        match cat {
            TransparencyHealthCategory::Pool => pool_usdc += amt,
            TransparencyHealthCategory::Trade => trade_usdc += amt,
            TransparencyHealthCategory::Investment => investment_usdc += amt,
            TransparencyHealthCategory::Expense => expense_usdc += amt,
            TransparencyHealthCategory::Other => other_usdc += amt,
        }
        let when = entry_time_ms(entry.created_at);
        if when > 0 && is_same_zoned_day(when, now_ms) && counts_in_portal_ledger(cat) {
            if cat == TransparencyHealthCategory::Expense {
                day_published_out += amt;
            } else {
                day_published_in += amt;
            }
        }
    }

    let total_in_usdc = deposits_usdc + pool_usdc + trade_usdc;
    let total_out_usdc = withdrawals_usdc + expense_usdc;
    let net_profit_usdc = total_in_usdc - total_out_usdc;
    let day_in_usdc = day_deposits_usdc + day_published_in;
    let day_out_usdc = day_withdrawals_usdc + day_published_out;
    let day_profit_usdc = day_in_usdc - day_out_usdc;
    let inflow_score = score_inflow(deposits_usdc, withdrawals_usdc);
    let rent_score = score_rent(deposits_usdc, withdrawals_usdc);
    let ledger_score = score_published_ledger(pool_usdc, trade_usdc, expense_usdc);
    let efficiency_pct = ledger_score;
    let (w_inflow, w_rent, w_ledger) = settings.normalized_weights();
    let computed = clamp_health_with(
        w_inflow * inflow_score + w_rent * rent_score + w_ledger * ledger_score,
        settings.effective_floor(),
    );
    // A pinned score wins outright, and the band follows the number actually shown so the
    // badge colour never contradicts it.
    let health = settings.manual_health().unwrap_or(computed);

    TransparencyHealthSnapshot {
        pool_usdc,
        trade_usdc,
        investment_usdc,
        expense_usdc,
        other_usdc,
        deposits_usdc,
        withdrawals_usdc,
        total_in_usdc,
        total_out_usdc,
        net_profit_usdc,
        day_in_usdc,
        day_out_usdc,
        day_profit_usdc,
        day_deposits_usdc,
        day_withdrawals_usdc,
        efficiency_pct,
        inflow_score,
        rent_score,
        ledger_score,
        health,
        band: health_band(health),
        has_amounts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_789_000_000_000; // 2026-09-09 UTC

    fn entry(cat: &str, amt: f64, period: Option<&str>) -> TransparencyHealthEntry {
        TransparencyHealthEntry {
            category: Some(cat.into()),
            amount_usdc: Some(amt),
            created_at: Some(1_700_000_000_000.0),
            period_ym: period.map(str::to_string),
        }
    }

    fn season_settings() -> HealthSettings {
        HealthSettings {
            period_scope: HealthPeriodScope::Season,
            ..HealthSettings::default()
        }
    }

    #[test]
    fn empty_ledger_neutral_floorish() {
        let snap = compute_transparency_health(&[], 1_700_000_000_000, &PlayerCashFlows::default());
        assert_eq!(snap.health, 50);
        assert_eq!(snap.band, HealthBand::Neutral);
        assert!(!snap.has_amounts);
        assert_eq!(snap.ledger_score, 50.0);
    }

    #[test]
    fn pool_beats_expense() {
        let entries = vec![entry("pool", 100.0, None), entry("expense", 10.0, None)];
        let snap =
            compute_transparency_health(&entries, 1_700_000_000_000, &PlayerCashFlows::default());
        assert!(snap.ledger_score > 80.0);
        assert!(snap.has_amounts);
        assert_eq!(snap.pool_usdc, 100.0);
        assert_eq!(snap.expense_usdc, 10.0);
    }

    #[test]
    fn same_brt_day() {
        // 2024-01-15 15:00 UTC = 12:00 BRT
        let a = 1_705_330_800_000i64;
        let b = a + 3_600_000;
        assert!(is_same_zoned_day(a, b));
        // cross midnight BRT
        let next = a + 20 * 3_600_000;
        assert!(!is_same_zoned_day(a, next));
    }

    #[test]
    fn clamp_and_band() {
        assert_eq!(clamp_health(f64::NAN), 50);
        assert_eq!(clamp_health(10.0), 50);
        assert_eq!(clamp_health(99.4), 99);
        assert_eq!(health_band(85), HealthBand::Excellent);
        assert_eq!(health_band(70), HealthBand::Healthy);
        assert_eq!(health_band(69), HealthBand::Neutral);
    }

    // ---- period scoping ----

    #[test]
    fn normalize_period_ym_accepts_only_valid_months() {
        assert_eq!(normalize_period_ym(Some("2026-09")).as_deref(), Some("2026-09"));
        assert_eq!(normalize_period_ym(Some("  2026-09 ")).as_deref(), Some("2026-09"));
        assert_eq!(normalize_period_ym(Some("geral")), None);
        assert_eq!(normalize_period_ym(Some("standing")), None);
        assert_eq!(normalize_period_ym(Some("")), None);
        assert_eq!(normalize_period_ym(Some("2026-13")), None);
        assert_eq!(normalize_period_ym(Some("2026-00")), None);
        assert_eq!(normalize_period_ym(Some("2026-9")), None);
        assert_eq!(normalize_period_ym(Some("202609")), None);
        assert_eq!(normalize_period_ym(None), None);
    }

    #[test]
    fn period_ym_from_ms_matches_utc_month() {
        assert_eq!(
            period_ym_from_ms(HEALTH_SEASON_START_MS_DEFAULT).as_deref(),
            Some("2026-09")
        );
        assert_eq!(period_ym_from_ms(0), None);
        assert_eq!(period_ym_from_ms(-1), None);
    }

    #[test]
    fn season_scope_drops_older_periods() {
        let s = season_settings();
        assert!(!entry_in_scope(Some("2025-12"), NOW, &s));
        assert!(!entry_in_scope(Some("2026-08"), NOW, &s));
        assert!(entry_in_scope(Some("2026-09"), NOW, &s));
        assert!(entry_in_scope(Some("2026-10"), NOW, &s));
    }

    #[test]
    fn all_time_scope_keeps_everything() {
        let s = HealthSettings::default(); // AllTime
        assert!(entry_in_scope(Some("2025-12"), NOW, &s));
        assert!(entry_in_scope(None, NOW, &s));
    }

    #[test]
    fn current_month_scope_is_exact() {
        let s = HealthSettings {
            period_scope: HealthPeriodScope::CurrentMonth,
            ..HealthSettings::default()
        };
        assert!(entry_in_scope(Some("2026-09"), NOW, &s));
        assert!(!entry_in_scope(Some("2026-10"), NOW, &s));
        assert!(!entry_in_scope(Some("2026-08"), NOW, &s));
    }

    #[test]
    fn undated_entries_follow_count_undated() {
        let mut s = season_settings();
        assert!(entry_in_scope(None, NOW, &s));
        assert!(entry_in_scope(Some("geral"), NOW, &s));
        s.count_undated = false;
        assert!(!entry_in_scope(None, NOW, &s));
        assert!(!entry_in_scope(Some("geral"), NOW, &s));
        // a real period is unaffected by count_undated
        assert!(entry_in_scope(Some("2026-09"), NOW, &s));
    }

    /// The bug this whole change exists for: one 2025-12 expense swamping a season.
    #[test]
    fn season_scope_excludes_the_2025_12_expense() {
        let entries = vec![
            entry("expense", 36_500.0, Some("2025-12")), // "Prejuízo golpe do DEV"
            entry("pool", 449.0, Some("2026-08")),
            entry("pool", 1_582.0, Some("2026-07")),
            entry("expense", 1_600.0, Some("2026-09")),
            entry("pool", 2_000.0, Some("2026-09")),
        ];

        let all = compute_transparency_health_with(
            &entries,
            NOW,
            &PlayerCashFlows::default(),
            &HealthSettings::default(),
        );
        assert_eq!(all.expense_usdc, 38_100.0);
        assert_eq!(all.ledger_score, 0.0, "expenses dwarf inflow => portal pinned at 0");

        let season = compute_transparency_health_with(
            &entries,
            NOW,
            &PlayerCashFlows::default(),
            &season_settings(),
        );
        assert_eq!(season.expense_usdc, 1_600.0);
        assert_eq!(season.pool_usdc, 2_000.0);
        assert_eq!(season.ledger_score, 20.0); // (2000-1600)/2000

        // With the floor at 50 both cases read 50 — the floor is exactly what hides the
        // broken ledger from the public number. Drop it to see the real improvement.
        let bare = |scope| HealthSettings {
            period_scope: scope,
            floor: 0,
            ..HealthSettings::default()
        };
        let all_bare = compute_transparency_health_with(
            &entries,
            NOW,
            &PlayerCashFlows::default(),
            &bare(HealthPeriodScope::AllTime),
        );
        let season_bare = compute_transparency_health_with(
            &entries,
            NOW,
            &PlayerCashFlows::default(),
            &bare(HealthPeriodScope::Season),
        );
        assert_eq!(all.health, 50);
        assert_eq!(season.health, 50);
        assert!(
            season_bare.health > all_bare.health,
            "season {} should beat all-time {}",
            season_bare.health,
            all_bare.health
        );
    }

    // ---- weights / floor / override ----

    #[test]
    fn weights_are_normalized_and_bad_input_falls_back() {
        let d = HealthSettings::default();
        let (i, r, l) = d.normalized_weights();
        assert!((i - 0.4).abs() < 1e-9 && (r - 0.35).abs() < 1e-9 && (l - 0.25).abs() < 1e-9);

        // sums to 2.0 -> renormalized to the same ratios
        let doubled = HealthSettings {
            weight_inflow: 0.8,
            weight_rent: 0.7,
            weight_ledger: 0.5,
            ..HealthSettings::default()
        };
        let (i2, r2, l2) = doubled.normalized_weights();
        assert!((i2 - 0.4).abs() < 1e-9 && (r2 - 0.35).abs() < 1e-9 && (l2 - 0.25).abs() < 1e-9);

        for bad in [
            HealthSettings { weight_inflow: f64::NAN, ..HealthSettings::default() },
            HealthSettings { weight_rent: -1.0, ..HealthSettings::default() },
            HealthSettings {
                weight_inflow: 0.0,
                weight_rent: 0.0,
                weight_ledger: 0.0,
                ..HealthSettings::default()
            },
        ] {
            assert_eq!(bad.normalized_weights(), (0.4, 0.35, 0.25));
        }
    }

    #[test]
    fn configurable_floor_lets_the_score_drop() {
        let entries = vec![entry("expense", 1_000.0, None)];
        let cash = PlayerCashFlows {
            deposits_usdc: Some(10.0),
            withdrawals_usdc: Some(500.0),
            ..PlayerCashFlows::default()
        };
        let default_floor =
            compute_transparency_health_with(&entries, NOW, &cash, &HealthSettings::default());
        assert_eq!(default_floor.health, 50);

        let no_floor = compute_transparency_health_with(
            &entries,
            NOW,
            &cash,
            &HealthSettings { floor: 0, ..HealthSettings::default() },
        );
        assert!(no_floor.health < 50, "got {}", no_floor.health);
    }

    #[test]
    fn weights_change_the_blend() {
        let entries = vec![entry("pool", 1_000.0, None)]; // ledger_score = 100
        let cash = PlayerCashFlows {
            deposits_usdc: Some(1.0),
            withdrawals_usdc: Some(1_000.0),
            ..PlayerCashFlows::default()
        };
        let ledger_only = compute_transparency_health_with(
            &entries,
            NOW,
            &cash,
            &HealthSettings {
                weight_inflow: 0.0,
                weight_rent: 0.0,
                weight_ledger: 1.0,
                floor: 0,
                ..HealthSettings::default()
            },
        );
        assert_eq!(ledger_only.health, 100);
    }

    #[test]
    fn override_wins_and_band_follows_it() {
        let entries = vec![entry("pool", 1_000.0, None)];
        let s = HealthSettings {
            override_enabled: true,
            override_value: Some(92),
            ..HealthSettings::default()
        };
        let snap =
            compute_transparency_health_with(&entries, NOW, &PlayerCashFlows::default(), &s);
        assert_eq!(snap.health, 92);
        assert_eq!(snap.band, HealthBand::Excellent);
        // sub-scores stay honest — only the headline number is pinned
        assert_eq!(snap.ledger_score, 100.0);
    }

    #[test]
    fn override_is_clamped_and_needs_a_value() {
        let base = HealthSettings { override_enabled: true, ..HealthSettings::default() };
        assert_eq!(base.manual_health(), None, "enabled without a value = no override");

        let high = HealthSettings { override_value: Some(500), ..base.clone() };
        assert_eq!(high.manual_health(), Some(100));

        let low = HealthSettings { override_value: Some(-5), ..base.clone() };
        assert_eq!(low.manual_health(), Some(0));

        let off = HealthSettings {
            override_enabled: false,
            override_value: Some(92),
            ..HealthSettings::default()
        };
        assert_eq!(off.manual_health(), None);
    }

    #[test]
    fn defaults_reproduce_legacy_behaviour() {
        let entries = vec![
            entry("pool", 100.0, Some("2025-01")),
            entry("expense", 10.0, None),
        ];
        let cash = PlayerCashFlows {
            deposits_usdc: Some(500.0),
            withdrawals_usdc: Some(120.0),
            ..PlayerCashFlows::default()
        };
        let legacy = compute_transparency_health(&entries, NOW, &cash);
        let with_defaults =
            compute_transparency_health_with(&entries, NOW, &cash, &HealthSettings::default());
        assert_eq!(legacy, with_defaults);
    }
}
