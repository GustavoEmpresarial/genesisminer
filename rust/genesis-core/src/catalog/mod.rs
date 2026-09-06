//! Catalog / Shop hardware write-path domain validation.
//! OCC lock/mutate/bump + soft-retire I/O: `genesis-hardware` `/v1/catalog/upgrades/replace`.

mod shape;
mod write;

pub use shape::{
    apply_infrastructure_shared_fields_from_merge_roots, is_soft_retire_eligible_row,
    normalize_upgrade_rarity, resolve_asic_duration_upsert_fields, ASIC_DURATION_KIND_NONE,
    RARITY_ALLOWED, RARITY_DEFAULT, UPGRADE_DEFAULT_ICON, UPGRADE_STATUS_RETIRED,
};
pub use write::{
    assert_canonical_ids_immutable, is_protected_upgrade_id, is_protected_upgrade_row,
    is_valid_shop_product_id, parse_upgrade_write_rows, read_identity_previous_id,
    CatalogWriteError, UpgradeWriteRow, HTTP_BAD_REQUEST, HTTP_CONFLICT, LEGACY_TEMP_MARKER,
    SHOP_PRODUCT_ID_MAX_LEN, SHOP_PRODUCT_ID_MIN_LEN, TEMP_LEGACY_ID_PREFIX,
    UPGRADE_WRITE_ALLOWED_FIELDS,
};
