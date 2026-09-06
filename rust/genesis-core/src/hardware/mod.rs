//! Hardware domain: catalog ids, rack compatibility, save-game item ids, rack intents.
//! Pure — no I/O. I/O lives in `genesis-hardware`.

pub mod bulk_batteries;
pub mod capacity;
pub mod catalog;
pub mod duration;
pub mod intent;
pub mod item_id;
pub mod rack_compat;
pub mod room;
pub mod types;

pub use bulk_batteries::{
    is_rack_battery_instance_uuid, is_valid_battery_rig_sort, is_valid_battery_selection_id,
    is_valid_room_id, parse_boolean_smart_fill, run_bulk_room_battery, BulkBatteryPrev,
    BulkRoomBatteryResult, RIG_SORT_HASHRATE_DESC, RIG_SORT_SLOT_ASC,
    STORED_BATTERY_CATALOG_PENDING_ID,
};
pub use capacity::{
    count_racks_in_room, room_effective_capacity, to_count, ASIC_ROOM_COIN_LOCKED_ERROR,
    ERR_COIN_DISABLED, ERR_INVALID_COIN, ERR_ROOM_CAPACITY_EXHAUSTED, ERR_ROOM_NOT_AVAILABLE,
    ERR_ROOM_PURCHASE_ACCESS, ERR_UNKNOWN_COIN, NFT_ROOM_COIN_LOCKED_ERROR,
    NFT_ROOM_EXCLUSIVE_COIN_ERROR,
};
pub use catalog::{
    normalize_known_1000wh_battery_catalog_id, normalize_stock_catalog_item_id,
    remap_purged_stock_item_id, CANONICAL_1000WH_BATTERY_ID, LEGACY_1000WH_BATTERY_IDS,
    PURGED_LEGACY_STOCK_IDS,
};
pub use intent::{
    apply_place_rack_from_stock, apply_rack_aux_equip, apply_rack_aux_unequip,
    apply_rack_miner_equip, apply_rack_miner_unequip, apply_remove_rack_to_stock,
    is_chassis_affinity_allowed_in_room, resolve_chassis_affinity_for_place,
};
pub use item_id::{
    is_valid_coin_id, is_valid_rack_id, is_valid_save_game_item_id, COIN_ID_MAX_LEN,
    RACK_ID_MAX_LEN, SAVE_GAME_ITEM_ID_MAX_LEN,
};
pub use rack_compat::{is_compatible_with_rack, merge_catalog_root_id, peel_merge_catalog_layer};
pub use room::{
    is_asic_machine_upgrade_row, is_nft_collectible_machine_row, rack_power_is_on,
    HARDWARE_ASIC_ROOM_ID, HARDWARE_NFT_AUTO_ROOM_ID,
};
pub use types::{
    AuxEquipInput, AuxUnequipInput, HardwareApplyResult, HardwareState, PlacedRack, StoredBattery,
    UpgradeRow, DEFAULT_SLOTS_CAP, MAX_AI_SLOTS_CAP, MAX_SLOTS_CAPACITY, MAX_SLOT_INDEX_FALLBACK,
    MAX_SLOT_INDEX_RAW,
};
