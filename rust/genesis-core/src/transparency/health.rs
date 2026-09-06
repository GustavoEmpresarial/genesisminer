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
    if !raw.is_finite() {
        return TRANSPARENCY_HEALTH_FLOOR;
    }
    let rounded = raw.round() as i32;
    rounded.clamp(TRANSPARENCY_HEALTH_FLOOR, TRANSPARENCY_HEALTH_CEILING)
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

pub fn compute_transparency_health(
    entries: &[TransparencyHealthEntry],
    now_ms: i64,
    cash: &PlayerCashFlows,
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
    let health = clamp_health(
        HEALTH_WEIGHT_INFLOW * inflow_score
            + HEALTH_WEIGHT_RENT * rent_score
            + HEALTH_WEIGHT_LEDGER * ledger_score,
    );

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
        let entries = vec![
            TransparencyHealthEntry {
                category: Some("pool".into()),
                amount_usdc: Some(100.0),
                created_at: Some(1_700_000_000_000.0),
            },
            TransparencyHealthEntry {
                category: Some("expense".into()),
                amount_usdc: Some(10.0),
                created_at: Some(1_700_000_000_000.0),
            },
        ];
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
}
