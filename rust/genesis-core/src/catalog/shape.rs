//! Upsert shape helpers for catalog replace — mirrors Node
//! `upgrade-catalog-shape.ts` + `upgrade-infrastructure-shared-fields.ts`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::hardware::rack_compat::merge_catalog_root_id;

use super::write::{
    is_protected_upgrade_row, UpgradeWriteRow, LEGACY_TEMP_MARKER, TEMP_LEGACY_ID_PREFIX,
};

/// Soft-retire status — column `upgrades.status` (free string; no migration).
pub const UPGRADE_STATUS_RETIRED: &str = "retired";

/// Default rarity when missing / invalid — matches Node `RARITY_DEFAULT`.
pub const RARITY_DEFAULT: &str = "common";

/// Allowed rarity values (admin UPSERT).
pub const RARITY_ALLOWED: &[&str] = &["common", "uncommon", "rare", "epic", "legendary", "supreme"];

/// Default icon when payload omits / empty — matches Node replace UPSERT.
pub const UPGRADE_DEFAULT_ICON: &str = "📦";

/// Hardcoded `asic_duration_kind` on admin UPSERT (Node).
pub const ASIC_DURATION_KIND_NONE: &str = "none";

const INFRASTRUCTURE_TYPE: &str = "infrastructure";

/// Shared chassis-family fields: root → `merge_*` of same `merge_catalog_root_id`.
const INFRASTRUCTURE_SHARED_FIELDS: &[&str] = &[
    "slotsCapacity",
    "aiSlotsCapacity",
    "image",
    "category",
    "isActive",
    "isNft",
    "powerCapacity",
    "layout",
    "rackRoomAffinity",
];

/// Soft-retire only for IDs the admin GET edit set can know (not protected).
pub fn is_soft_retire_eligible_row(
    id: &str,
    category: Option<&str>,
    row_type: Option<&str>,
) -> bool {
    !is_protected_upgrade_row(id, category, row_type)
}

/// Normalize rarity string → allowed set or default.
pub fn normalize_upgrade_rarity(raw: Option<&str>) -> String {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("");
    if trimmed.is_empty() {
        return RARITY_DEFAULT.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if RARITY_ALLOWED.iter().any(|a| *a == lower) {
        lower
    } else {
        RARITY_DEFAULT.to_string()
    }
}

/// UPSERT admin: keep BD duration when payload omits both fields.
pub fn resolve_asic_duration_upsert_fields(
    payload_amount: Option<&Value>,
    payload_unit: Option<&Value>,
    has_explicit_amount_key: bool,
    has_explicit_unit_key: bool,
    existing_amount: Option<i32>,
    existing_unit: Option<&str>,
) -> (i32, Option<String>) {
    let has_explicit = has_explicit_amount_key || has_explicit_unit_key;
    if has_explicit {
        let amt = floor_nonneg_i32(payload_amount);
        let unit = opt_trimmed_string(payload_unit);
        return if amt > 0 && unit.is_some() {
            (amt, unit)
        } else {
            (0, None)
        };
    }
    let amt = existing_amount.unwrap_or(0).max(0);
    let unit = existing_unit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if amt > 0 && unit.is_some() {
        (amt, unit)
    } else {
        (0, None)
    }
}

/// Merges `merge_*` infrastructure rows inherit shared fields from root in the array.
pub fn apply_infrastructure_shared_fields_from_merge_roots(upgrades: &mut [UpgradeWriteRow]) {
    let mut shared_by_root: HashMap<String, Map<String, Value>> = HashMap::new();
    for u in upgrades.iter() {
        let row_type = u.fields.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type != INFRASTRUCTURE_TYPE {
            continue;
        }
        let id = u.id.trim();
        if id.is_empty() {
            continue;
        }
        if merge_catalog_root_id(id) != id {
            continue;
        }
        shared_by_root.insert(id.to_string(), pick_infrastructure_shared(u));
    }

    for u in upgrades.iter_mut() {
        let row_type = u
            .fields
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if row_type != INFRASTRUCTURE_TYPE {
            continue;
        }
        let id = u.id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let root_id = merge_catalog_root_id(&id);
        if root_id == id {
            if let Some(own) = shared_by_root.get(&id) {
                for (k, v) in own {
                    u.fields.insert(k.clone(), v.clone());
                }
            }
            continue;
        }
        if let Some(from_root) = shared_by_root.get(&root_id) {
            for (k, v) in from_root {
                u.fields.insert(k.clone(), v.clone());
            }
        }
    }
}

fn pick_infrastructure_shared(root: &UpgradeWriteRow) -> Map<String, Value> {
    let mut patch = Map::new();
    for key in INFRASTRUCTURE_SHARED_FIELDS {
        if let Some(v) = root.fields.get(*key) {
            patch.insert((*key).to_string(), v.clone());
        }
    }
    patch
}

fn floor_nonneg_i32(v: Option<&Value>) -> i32 {
    match v {
        Some(Value::Number(n)) => n
            .as_f64()
            .map(|f| f.floor() as i32)
            .or_else(|| n.as_i64().map(|i| i as i32))
            .unwrap_or(0)
            .max(0),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| f.floor() as i32)
            .unwrap_or(0)
            .max(0),
        _ => 0,
    }
}

fn opt_trimmed_string(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

/// Re-export protect markers for callers that only need soft-retire policy docs.
#[allow(dead_code)]
pub fn is_protected_upgrade_id_prefix(id: &str) -> bool {
    id.starts_with(TEMP_LEGACY_ID_PREFIX)
}

#[allow(dead_code)]
pub fn is_legacy_temp_marker(s: Option<&str>) -> bool {
    s == Some(LEGACY_TEMP_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, typ: &str, fields: Map<String, Value>) -> UpgradeWriteRow {
        let mut f = fields;
        f.insert("type".into(), json!(typ));
        UpgradeWriteRow {
            id: id.into(),
            name: id.into(),
            previous_id: None,
            fields: f,
        }
    }

    #[test]
    fn soft_retire_skips_protected() {
        assert!(!is_soft_retire_eligible_row(
            "temp_legacy_x",
            Some("gpu"),
            Some("machine")
        ));
        assert!(!is_soft_retire_eligible_row(
            "x",
            Some(LEGACY_TEMP_MARKER),
            None
        ));
        assert!(is_soft_retire_eligible_row(
            "gpu_v1",
            Some("gpu"),
            Some("machine")
        ));
    }

    #[test]
    fn rarity_normalize() {
        assert_eq!(normalize_upgrade_rarity(Some("EPIC")), "epic");
        assert_eq!(normalize_upgrade_rarity(Some("nope")), RARITY_DEFAULT);
        assert_eq!(normalize_upgrade_rarity(None), RARITY_DEFAULT);
    }

    #[test]
    fn asic_duration_preserves_existing_when_omitted() {
        let (amt, unit) =
            resolve_asic_duration_upsert_fields(None, None, false, false, Some(7), Some("day"));
        assert_eq!(amt, 7);
        assert_eq!(unit.as_deref(), Some("day"));
    }

    #[test]
    fn asic_duration_explicit_zero_clears() {
        let (amt, unit) = resolve_asic_duration_upsert_fields(
            Some(&json!(0)),
            Some(&json!("day")),
            true,
            true,
            Some(7),
            Some("day"),
        );
        assert_eq!(amt, 0);
        assert!(unit.is_none());
    }

    #[test]
    fn infrastructure_shared_copies_to_merge_child() {
        let mut rows = vec![
            row(
                "rack_a61",
                INFRASTRUCTURE_TYPE,
                Map::from_iter([
                    ("slotsCapacity".into(), json!(4)),
                    ("rackRoomAffinity".into(), json!("asic")),
                ]),
            ),
            row(
                "merge_rack_a61_uncommon_ab12cd",
                INFRASTRUCTURE_TYPE,
                Map::from_iter([("slotsCapacity".into(), json!(1))]),
            ),
        ];
        apply_infrastructure_shared_fields_from_merge_roots(&mut rows);
        assert_eq!(rows[1].fields.get("slotsCapacity"), Some(&json!(4)));
        assert_eq!(rows[1].fields.get("rackRoomAffinity"), Some(&json!("asic")));
    }
}
