//! Hardware catalog id normalization — 1:1 with `server/modules/hardware/services/catalog.ts`.

pub const CANONICAL_1000WH_BATTERY_ID: &str = "battery_estelar";

/// IDs purged in `20260516200000_purge_all_legacy_battery_and_charger_residue`.
pub const PURGED_LEGACY_STOCK_IDS: &[&str] = &[
    "charger_a1",
    "charger_a2",
    "battery_aa",
    "battery_car",
    "battery_diesel",
    "battery_fusion",
    "battery_protostar",
    "battery_ups",
    "battery_wall",
    "small_battery",
    "supernova",
];

pub const LEGACY_1000WH_BATTERY_IDS: &[&str] =
    &["small_battery", "battery_protostar", "battery_stellar"];

pub const KNOWN_INFINITE_BATTERY_IDS: &[&str] =
    &["battery_estelar", "battery_protostar", "battery_stellar"];

const CHARGER_PREFIX: &str = "charger_";

fn trim_item_id(item_id_raw: Option<&str>) -> String {
    item_id_raw.unwrap_or("").trim().to_string()
}

fn is_purged_legacy_stock_id(item_id: &str) -> bool {
    PURGED_LEGACY_STOCK_IDS.iter().any(|id| *id == item_id)
}

fn is_purged_remap_to_estelar(item_id: &str) -> bool {
    is_purged_legacy_stock_id(item_id) && !item_id.starts_with(CHARGER_PREFIX)
}

/// Remaps known 1000Wh legacy ids (`small_battery`, `battery_protostar`, `battery_stellar`)
/// to the canonical `battery_estelar`.
pub fn normalize_known_1000wh_battery_catalog_id(item_id_raw: Option<&str>) -> String {
    let item_id = trim_item_id(item_id_raw);
    if item_id.is_empty() {
        return String::new();
    }
    if LEGACY_1000WH_BATTERY_IDS.iter().any(|id| *id == item_id) {
        CANONICAL_1000WH_BATTERY_ID.to_string()
    } else {
        item_id
    }
}

/// Purged batteries remap to Estelar; purged chargers become `""` (dropped).
pub fn remap_purged_stock_item_id(item_id_raw: Option<&str>) -> String {
    let item_id = trim_item_id(item_id_raw);
    if item_id.is_empty() {
        return String::new();
    }
    if is_purged_remap_to_estelar(&item_id) {
        return CANONICAL_1000WH_BATTERY_ID.to_string();
    }
    if is_purged_legacy_stock_id(&item_id) {
        return String::new();
    }
    item_id
}

/// Save-game / DB stock key normalization.
pub fn normalize_stock_catalog_item_id(item_id_raw: Option<&str>) -> String {
    let legacy = normalize_known_1000wh_battery_catalog_id(item_id_raw);
    remap_purged_stock_item_id(Some(&legacy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_legacy_1000wh_to_estelar() {
        assert_eq!(
            normalize_known_1000wh_battery_catalog_id(Some("small_battery")),
            CANONICAL_1000WH_BATTERY_ID
        );
        assert_eq!(
            normalize_known_1000wh_battery_catalog_id(Some("battery_stellar")),
            CANONICAL_1000WH_BATTERY_ID
        );
        assert_eq!(
            normalize_known_1000wh_battery_catalog_id(Some("battery_protostar")),
            CANONICAL_1000WH_BATTERY_ID
        );
    }

    #[test]
    fn normalize_keeps_non_legacy() {
        assert_eq!(
            normalize_known_1000wh_battery_catalog_id(Some("battery_nebula")),
            "battery_nebula"
        );
        assert_eq!(normalize_known_1000wh_battery_catalog_id(None), "");
        assert_eq!(normalize_known_1000wh_battery_catalog_id(Some("  ")), "");
    }

    #[test]
    fn remap_purged_battery_to_estelar_charger_dropped() {
        assert_eq!(
            remap_purged_stock_item_id(Some("battery_aa")),
            CANONICAL_1000WH_BATTERY_ID
        );
        assert_eq!(remap_purged_stock_item_id(Some("charger_a1")), "");
        assert_eq!(remap_purged_stock_item_id(Some("gpu_rx6600")), "gpu_rx6600");
    }

    #[test]
    fn normalize_stock_catalog_collapses_legacy_then_purge() {
        assert_eq!(
            normalize_stock_catalog_item_id(Some("small_battery")),
            CANONICAL_1000WH_BATTERY_ID
        );
        assert_eq!(normalize_stock_catalog_item_id(Some("charger_a2")), "");
        assert_eq!(
            normalize_stock_catalog_item_id(Some("battery_estelar")),
            CANONICAL_1000WH_BATTERY_ID
        );
    }
}
