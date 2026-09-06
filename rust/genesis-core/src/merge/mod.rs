//! Merge Station — pure rules (ported from `server/modules/merge/services/{constants,stats}.ts`).

use serde::{Deserialize, Serialize};

pub const DEFAULT_MERGE_GAIN_PERCENT: f64 = 5.0;
pub const MERGE_MAX_COUNT: u32 = 50;
pub const MIN_MERGE_QTY: u32 = 2;

const NEAR_EPSILON: f64 = 1e-6;
const DEFAULT_ROUND_DIGITS: u32 = 8;
const FEE_ROUND_DIGITS: u32 = 2;
const COST_ROUND_DIGITS: u32 = 6;
const POWER_EFFICIENCY_FACTOR: f64 = 0.95;
const PERCENT_BASE: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeRarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
    Supreme,
}

impl MergeRarity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Common => "common",
            Self::Uncommon => "uncommon",
            Self::Rare => "rare",
            Self::Epic => "epic",
            Self::Legendary => "legendary",
            Self::Supreme => "supreme",
        }
    }

    pub fn result_rarity(self) -> Option<MergeRarity> {
        match self {
            Self::Common => Some(Self::Uncommon),
            Self::Uncommon => Some(Self::Rare),
            Self::Rare => Some(Self::Epic),
            Self::Epic => Some(Self::Legendary),
            Self::Legendary => Some(Self::Supreme),
            Self::Supreme => None,
        }
    }

    pub fn is_mergeable_source(self) -> bool {
        !matches!(self, Self::Supreme)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogType {
    Machine,
    Multiplier,
    Infrastructure,
}

impl CatalogType {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "machine" => Some(Self::Machine),
            "multiplier" => Some(Self::Multiplier),
            "infrastructure" => Some(Self::Infrastructure),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRuntimeSettings {
    pub gain_percent: f64,
    pub cost_pct_by_rarity: MergeCostPct,
    pub rack_hs_bonus_pct_by_rarity: RackHsBonusPct,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeCostPct {
    pub common: f64,
    pub uncommon: f64,
    pub rare: f64,
    pub epic: f64,
    pub legendary: f64,
}

impl Default for MergeCostPct {
    fn default() -> Self {
        Self {
            common: 10.0,
            uncommon: 15.0,
            rare: 20.0,
            epic: 25.0,
            legendary: 30.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RackHsBonusPct {
    pub common: f64,
    pub uncommon: f64,
    pub rare: f64,
    pub epic: f64,
    pub legendary: f64,
    pub supreme: f64,
}

impl Default for RackHsBonusPct {
    fn default() -> Self {
        Self {
            common: 0.0,
            uncommon: 0.0,
            rare: 0.0,
            epic: 0.0,
            legendary: 0.0,
            supreme: 0.0,
        }
    }
}

impl Default for MergeRuntimeSettings {
    fn default() -> Self {
        Self {
            gain_percent: DEFAULT_MERGE_GAIN_PERCENT,
            cost_pct_by_rarity: MergeCostPct::default(),
            rack_hs_bonus_pct_by_rarity: RackHsBonusPct::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSourceCatalog {
    pub id: String,
    pub name: String,
    pub category: String,
    pub catalog_type: CatalogType,
    pub rarity: MergeRarity,
    pub base_cost: f64,
    pub base_production: f64,
    pub power_consumption: Option<f64>,
    pub multiplier: Option<f64>,
    pub slots_capacity: Option<i32>,
    pub ai_slots_capacity: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCatalogStats {
    pub base_cost: f64,
    pub base_production: f64,
    pub power_consumption: Option<f64>,
    pub multiplier: Option<f64>,
    pub slots_capacity: Option<i32>,
    pub ai_slots_capacity: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResultStats {
    pub result_rarity: MergeRarity,
    pub name: String,
    pub base_cost: f64,
    pub base_production: f64,
    pub power_consumption: Option<f64>,
    pub multiplier: Option<f64>,
    pub slots_capacity: Option<i32>,
    pub ai_slots_capacity: Option<i32>,
    pub fee_usdc: f64,
    pub cost_pct: f64,
    pub gain_percent: f64,
}

pub fn normalize_merge_rarity(raw: &str) -> MergeRarity {
    match raw.trim().to_lowercase().as_str() {
        "uncommon" => MergeRarity::Uncommon,
        "rare" => MergeRarity::Rare,
        "epic" => MergeRarity::Epic,
        "legendary" => MergeRarity::Legendary,
        "supreme" => MergeRarity::Supreme,
        _ => MergeRarity::Common,
    }
}

pub fn merge_result_display_name(source_name: &str) -> String {
    let trimmed = source_name.trim();
    let base = trimmed
        .strip_prefix("Merged ")
        .or_else(|| trimmed.strip_prefix("merged "))
        .or_else(|| trimmed.strip_prefix("MERGED "))
        .unwrap_or(trimmed);
    let base = if base.is_empty() {
        source_name.trim()
    } else {
        base
    };
    format!("Merged {base}")
}

fn round_stat(n: f64, digits: u32) -> f64 {
    let f = 10_f64.powi(digits as i32);
    (n * f).round() / f
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < NEAR_EPSILON
}

fn cost_pct_for(rarity: MergeRarity, settings: &MergeRuntimeSettings) -> f64 {
    match rarity {
        MergeRarity::Common => settings.cost_pct_by_rarity.common,
        MergeRarity::Uncommon => settings.cost_pct_by_rarity.uncommon,
        MergeRarity::Rare => settings.cost_pct_by_rarity.rare,
        MergeRarity::Epic => settings.cost_pct_by_rarity.epic,
        MergeRarity::Legendary => settings.cost_pct_by_rarity.legendary,
        MergeRarity::Supreme => 0.0,
    }
}

pub fn stats_match_existing(
    row: &MergeCatalogStats,
    stats: &MergeResultStats,
    catalog_type: CatalogType,
) -> bool {
    if !near(row.base_cost, stats.base_cost) {
        return false;
    }
    match catalog_type {
        CatalogType::Machine => {
            if !near(row.base_production, stats.base_production) {
                return false;
            }
            match (row.power_consumption, stats.power_consumption) {
                (None, None) => true,
                (Some(rw), Some(sw)) => near(rw, sw),
                _ => false,
            }
        }
        CatalogType::Multiplier => match (row.multiplier, stats.multiplier) {
            (None, None) => true,
            (Some(rm), Some(sm)) => near(rm, sm),
            _ => false,
        },
        CatalogType::Infrastructure => {
            match (row.multiplier, stats.multiplier) {
                (None, None) => {}
                (Some(rm), Some(sm)) if near(rm, sm) => {}
                _ => return false,
            }
            row.slots_capacity == stats.slots_capacity
                && row.ai_slots_capacity == stats.ai_slots_capacity
        }
    }
}

pub fn merge_source_catalogs_equivalent(a: &MergeSourceCatalog, b: &MergeSourceCatalog) -> bool {
    if a.catalog_type != b.catalog_type || a.rarity != b.rarity || a.name != b.name {
        return false;
    }
    stats_match_existing(
        &MergeCatalogStats {
            base_cost: a.base_cost,
            base_production: a.base_production,
            power_consumption: a.power_consumption,
            multiplier: a.multiplier,
            slots_capacity: a.slots_capacity,
            ai_slots_capacity: a.ai_slots_capacity,
        },
        &MergeResultStats {
            result_rarity: a.rarity,
            name: a.name.clone(),
            base_cost: b.base_cost,
            base_production: b.base_production,
            power_consumption: b.power_consumption,
            multiplier: b.multiplier,
            slots_capacity: b.slots_capacity,
            ai_slots_capacity: b.ai_slots_capacity,
            fee_usdc: 0.0,
            cost_pct: 0.0,
            gain_percent: 0.0,
        },
        a.catalog_type,
    )
}

pub fn compute_merge_result_stats(
    source: &MergeSourceCatalog,
    settings: &MergeRuntimeSettings,
) -> Option<MergeResultStats> {
    if !source.rarity.is_mergeable_source() {
        return None;
    }
    let result_rarity = source.rarity.result_rarity()?;
    let cost_pct = cost_pct_for(source.rarity, settings);
    let gain_factor = 1.0 + settings.gain_percent / PERCENT_BASE;
    let c1 = source.base_cost.max(0.0);
    let fee_usdc = round_stat((c1 + c1) * (cost_pct / PERCENT_BASE), FEE_ROUND_DIGITS);
    let base_cost = round_stat((c1 + c1) * gain_factor, COST_ROUND_DIGITS);

    let (base_production, power_consumption, multiplier, slots_capacity, ai_slots_capacity) =
        match source.catalog_type {
            CatalogType::Machine => {
                let p = source.base_production.max(0.0);
                let w = source.power_consumption.unwrap_or(0.0).max(0.0);
                (
                    round_stat((p + p) * gain_factor, DEFAULT_ROUND_DIGITS),
                    Some(round_stat(
                        (w + w) * POWER_EFFICIENCY_FACTOR,
                        COST_ROUND_DIGITS,
                    )),
                    None,
                    None,
                    None,
                )
            }
            CatalogType::Multiplier => {
                let m = source.multiplier.unwrap_or(0.0).max(0.0);
                (
                    0.0,
                    None,
                    Some(round_stat((m + m) * gain_factor, DEFAULT_ROUND_DIGITS)),
                    None,
                    None,
                )
            }
            CatalogType::Infrastructure => {
                let bonus = match result_rarity {
                    MergeRarity::Common => settings.rack_hs_bonus_pct_by_rarity.common,
                    MergeRarity::Uncommon => settings.rack_hs_bonus_pct_by_rarity.uncommon,
                    MergeRarity::Rare => settings.rack_hs_bonus_pct_by_rarity.rare,
                    MergeRarity::Epic => settings.rack_hs_bonus_pct_by_rarity.epic,
                    MergeRarity::Legendary => settings.rack_hs_bonus_pct_by_rarity.legendary,
                    MergeRarity::Supreme => settings.rack_hs_bonus_pct_by_rarity.supreme,
                }
                .max(0.0);
                (
                    0.0,
                    None,
                    Some(round_stat(bonus / PERCENT_BASE, DEFAULT_ROUND_DIGITS)),
                    source.slots_capacity.filter(|&v| v >= 0),
                    source.ai_slots_capacity.filter(|&v| v >= 0),
                )
            }
        };

    Some(MergeResultStats {
        result_rarity,
        name: merge_result_display_name(&source.name),
        base_cost,
        base_production,
        power_consumption,
        multiplier,
        slots_capacity,
        ai_slots_capacity,
        fee_usdc,
        cost_pct,
        gain_percent: settings.gain_percent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_source() -> MergeSourceCatalog {
        MergeSourceCatalog {
            id: "gpu_1".into(),
            name: "GPU X".into(),
            category: "gpu".into(),
            catalog_type: CatalogType::Machine,
            rarity: MergeRarity::Common,
            base_cost: 100.0,
            base_production: 10.0,
            power_consumption: Some(200.0),
            multiplier: None,
            slots_capacity: None,
            ai_slots_capacity: None,
        }
    }

    #[test]
    fn normalize_merge_rarity_defaults_unknown_to_common() {
        assert_eq!(normalize_merge_rarity("EPIC"), MergeRarity::Epic);
        assert_eq!(normalize_merge_rarity("nope"), MergeRarity::Common);
    }

    #[test]
    fn compute_merge_result_stats_common_gpu() {
        let stats =
            compute_merge_result_stats(&sample_source(), &MergeRuntimeSettings::default()).unwrap();
        assert_eq!(stats.result_rarity, MergeRarity::Uncommon);
        assert_eq!(stats.name, "Merged GPU X");
        assert!(stats.base_production > 20.0);
        assert_eq!(stats.fee_usdc, 20.0);
    }

    #[test]
    fn equivalent_skus_with_same_stats() {
        let a = sample_source();
        let mut b = sample_source();
        b.id = "merge_gpu_1_uncommon_other".into();
        assert!(merge_source_catalogs_equivalent(&a, &b));
    }

    #[test]
    fn non_equivalent_when_stats_differ() {
        let a = sample_source();
        let mut b = sample_source();
        b.base_cost = 6.3;
        b.base_production = 6.3;
        assert!(!merge_source_catalogs_equivalent(&a, &b));
    }
}
