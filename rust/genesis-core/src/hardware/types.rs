//! Shared hardware intent types — mirror of TS `PlacedRackLoaded` / `RackAuxUpgradeRow`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::room::MachineUpgradeRef;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBattery {
    pub id: String,
    pub item_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedRack {
    pub id: String,
    pub item_id: String,
    #[serde(default)]
    pub slots: Vec<String>,
    #[serde(default)]
    pub slot_lease_ids: Vec<String>,
    #[serde(default)]
    pub multiplier_slots: Vec<String>,
    #[serde(default)]
    pub wiring_id: Option<String>,
    #[serde(default)]
    pub battery_id: Option<String>,
    #[serde(default)]
    pub is_on: bool,
    #[serde(default)]
    pub selected_coin_id: Option<String>,
    #[serde(default)]
    pub room_id: String,
    #[serde(default)]
    pub slot_index: i64,
    #[serde(default)]
    pub battery_catalog_item_id: Option<String>,
    #[serde(default)]
    pub battery_display_name: Option<String>,
    #[serde(default)]
    pub battery_image_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeRow {
    pub id: String,
    #[serde(default, rename = "type")]
    pub type_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub nft_mining_coin_id: Option<String>,
    #[serde(default)]
    pub power_capacity: Option<f64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub slots_capacity: Option<i64>,
    #[serde(default)]
    pub ai_slots_capacity: Option<i64>,
    /// `0` = inactive in catalog.
    #[serde(default)]
    pub is_active: Option<i64>,
    #[serde(default)]
    pub compatible_racks: Option<Vec<String>>,
    #[serde(default)]
    pub asic_duration_amount: Option<i64>,
    #[serde(default)]
    pub asic_duration_unit: Option<String>,
    #[serde(default)]
    pub asic_duration_kind: Option<String>,
    #[serde(default)]
    pub rack_room_affinity: Option<String>,
    /// Catalog status (`legacy` / `exclusive` / `retired` …) — bulk battery filter.
    #[serde(default)]
    pub status: Option<String>,
    /// NFT flag — bulk battery filter.
    #[serde(default)]
    pub is_nft: Option<bool>,
    /// Machine base production — bulk `hashrate_desc` sort.
    #[serde(default)]
    pub base_production: Option<f64>,
    /// Multiplier chip value — bulk `hashrate_desc` sort.
    #[serde(default)]
    pub multiplier: Option<f64>,
}

impl UpgradeRow {
    pub fn machine_ref(&self) -> MachineUpgradeRef {
        MachineUpgradeRef {
            id: self.id.clone(),
            type_name: self.type_name.clone().unwrap_or_default(),
            category: self.category.clone().unwrap_or_default(),
            nft_mining_coin_id: self.nft_mining_coin_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareState {
    pub stock: HashMap<String, i64>,
    pub stored_batteries: Vec<StoredBattery>,
    pub placed_racks: Vec<PlacedRack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareApplyOk {
    pub ok: bool,
    pub stock: HashMap<String, i64>,
    pub stored_batteries: Vec<StoredBattery>,
    pub placed_racks: Vec<PlacedRack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareApplyErr {
    pub ok: bool,
    pub error: String,
}

#[derive(Debug, Clone)]
pub enum HardwareApplyResult {
    Ok(HardwareApplyOk),
    Err(HardwareApplyErr),
}

impl HardwareApplyResult {
    pub fn ok_state(state: HardwareState) -> Self {
        Self::Ok(HardwareApplyOk {
            ok: true,
            stock: state.stock,
            stored_batteries: state.stored_batteries,
            placed_racks: state.placed_racks,
        })
    }

    pub fn fail(error: impl Into<String>) -> Self {
        Self::Err(HardwareApplyErr {
            ok: false,
            error: error.into(),
        })
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok(_))
    }
}

#[derive(Debug, Clone)]
pub enum AuxEquipInput {
    BatteryFromWarehouse {
        stored_battery_id: String,
    },
    BatteryFromStock {
        catalog_item_id: String,
    },
    Wiring {
        catalog_item_id: String,
    },
    Multiplier {
        catalog_item_id: String,
        multiplier_slot_index: i64,
    },
}

#[derive(Debug, Clone)]
pub enum AuxUnequipInput {
    Battery,
    Wiring,
    Multiplier { multiplier_slot_index: i64 },
}

pub const MAX_SLOTS_CAPACITY: i64 = 128;
pub const MAX_SLOT_INDEX_FALLBACK: i64 = 127;
pub const DEFAULT_SLOTS_CAP: i64 = 10;
pub const MAX_AI_SLOTS_CAP: i64 = 64;
pub const MAX_SLOT_INDEX_RAW: i64 = 999;

pub const ASIC_ONLY_CHASSIS_ROOT_IDS: &[&str] = &["rack_army", "rack_promo"];
pub const STANDARD_ONLY_CHASSIS_ROOT_ID: &str = "rack_a63";
pub const NFT_CHASSIS_ID: &str = "rack_armario_1";
/// Prisma `upgrades.rack_room_affinity @default("standard")` — not legacy asic+standard.
pub const COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY: &str = "standard";
