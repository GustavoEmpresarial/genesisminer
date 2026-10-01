use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorUpgradeLite {
    pub id: String,
    #[serde(rename = "type")]
    pub upgrade_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub base_production: f64,
    pub multiplier: Option<f64>,
    pub power_capacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_mining_coin_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningCoinInput {
    pub id: String,
    pub symbol: String,
    pub name: String,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
    #[serde(rename = "priceUSD", alias = "price_usd", default)]
    pub price_usd: f64,
    #[serde(alias = "usdcRate", default)]
    pub usdc_rate: f64,
    pub nft_room_only: bool,
    /// `legacy` vs `usd_month` — espelha `mining_coins.distribution_mode`.
    #[serde(default)]
    pub distribution_mode: crate::mining::DistributionMode,
    /// Orçamento USD/mês quando `distribution_mode = usd_month`.
    #[serde(default)]
    pub distribution_usd_month: f64,
}

#[derive(Debug, Clone)]
pub struct SlotMiningCredit {
    pub coin_id: String,
    pub effective_base_prod: f64,
    pub counts_toward_general_power: bool,
}

#[derive(Debug, Clone)]
pub struct CheckinHashEntry {
    pub coin_id: String,
    pub room_id: Option<String>,
    pub base_hps: f64,
    /// When false, excluded from check-in bonus base / distribution (ASIC / NFT special).
    pub counts_toward_general_power: bool,
}
