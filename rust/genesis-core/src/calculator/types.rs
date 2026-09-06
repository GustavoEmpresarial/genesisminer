use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
pub struct CalculatorRackInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub room_id: Option<String>,
    pub wiring_id: Option<String>,
    pub battery_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery_catalog_item_id: Option<String>,
    pub is_on: bool,
    pub selected_coin_id: Option<String>,
    pub slots: Vec<Option<String>>,
    #[serde(default)]
    pub multiplier_slots: Vec<Option<String>>,
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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHistoryRowInput {
    pub id: String,
    pub coin_id: String,
    pub room_id: Option<String>,
    pub window_start_ms: f64,
    pub window_end_ms: f64,
    pub credit_blocks: f64,
    pub amount_coins: f64,
    pub amount_usd: f64,
    pub user_hash_hps: f64,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScopeOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorComputeInput {
    pub scope: String,
    pub scopes_ui: Vec<ScopeOption>,
    pub checkin_frozen: bool,
    pub checkin_bonus_hps: f64,
    pub racks: Vec<CalculatorRackInput>,
    pub upgrades_by_id: HashMap<String, CalculatorUpgradeLite>,
    pub coins: Vec<MiningCoinInput>,
    pub nft_room_ids: Vec<String>,
    #[serde(default)]
    pub asic_room_ids: Vec<String>,
    #[serde(default)]
    pub runtime_network_by_coin: HashMap<String, f64>,
    #[serde(default)]
    pub implied_network_by_coin: HashMap<String, f64>,
    #[serde(default)]
    pub block_history_rows: Vec<BlockHistoryRowInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCalculatorCoinRow {
    pub label: String,
    pub coins: f64,
    pub usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockHistoryEntry {
    pub id: String,
    pub room_id: Option<String>,
    pub window_start_ms: f64,
    pub window_end_ms: f64,
    pub credited_blocks: f64,
    pub amount_coins: f64,
    pub amount_usd: f64,
    pub user_hash_hps: f64,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCalculatorCoinPayload {
    pub id: String,
    pub symbol: String,
    pub name: String,
    #[serde(rename = "priceUSD")]
    pub price_usd: f64,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
    pub user_power_hps: f64,
    pub daily_coins: f64,
    pub daily_usd: f64,
    pub projection30_usd: f64,
    pub nft_room_only: bool,
    pub independent_pool: bool,
    pub rows: Vec<PlayerCalculatorCoinRow>,
    pub block_history: Vec<BlockHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCalculatorCoinComparison {
    pub id: String,
    pub symbol: String,
    pub name: String,
    #[serde(rename = "priceUSD")]
    pub price_usd: f64,
    pub is_actively_mining: bool,
    pub daily_coins: f64,
    pub daily_usd: f64,
    pub projection30_usd: f64,
    pub rows: Vec<PlayerCalculatorCoinRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCalculatorSnapshot {
    pub scope: String,
    pub scopes_ui: Vec<ScopeOption>,
    pub general_power_hps: f64,
    pub coin_comparisons: Vec<PlayerCalculatorCoinComparison>,
    pub coins: Vec<PlayerCalculatorCoinPayload>,
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

#[derive(Debug, Clone)]
pub struct ProjectionPeriod {
    pub label: &'static str,
    pub multiplier: f64,
}
