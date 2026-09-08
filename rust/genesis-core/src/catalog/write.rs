//! Pure parse / identity / protect rules for hardware catalog writes.
//! Mirrors `server/modules/catalog/services/upgrades-write.ts` domain slice.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Matches TS `SHOP_PRODUCT_ID_RE` `{1,160}`.
pub const SHOP_PRODUCT_ID_MIN_LEN: usize = 1;
pub const SHOP_PRODUCT_ID_MAX_LEN: usize = 160;

pub const HTTP_BAD_REQUEST: u16 = 400;
pub const HTTP_CONFLICT: u16 = 409;

pub const TEMP_LEGACY_ID_PREFIX: &str = "temp_legacy_";
pub const LEGACY_TEMP_MARKER: &str = "legacy-temp";

const IDENTITY_META_KEYS: &[&str] = &["previousId", "editingSourceId", "sourceId", "fromId"];

/// Mutable fields allowed on write (excl. `id`; `name` required separately).
/// Keep in sync with TS `UPGRADE_WRITE_ALLOWED_FIELDS`.
pub const UPGRADE_WRITE_ALLOWED_FIELDS: &[&str] = &[
    "name",
    "category",
    "type",
    "baseCost",
    "baseProduction",
    "powerConsumption",
    "powerCapacity",
    "multiplier",
    "slotsCapacity",
    "aiSlotsCapacity",
    "description",
    "icon",
    "status",
    "isNft",
    "nftContract",
    "nftTokenId",
    "maxGlobalStock",
    "image",
    "layout",
    "rewardWh",
    "sellInHardwareMarket",
    "sellInBlackMarket",
    "isActive",
    "nftMiningCoinId",
    "asicDurationAmount",
    "asicDurationUnit",
    "rarity",
    "compatibleRacks",
    "rackRoomAffinity",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWriteError {
    pub status_code: u16,
    pub code: String,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_id: Option<String>,
}

impl CatalogWriteError {
    fn bad_request(code: &str, error: impl Into<String>) -> Self {
        Self {
            status_code: HTTP_BAD_REQUEST,
            code: code.to_string(),
            error: error.into(),
            previous_id: None,
            attempted_id: None,
        }
    }

    fn conflict_immutable(previous_id: String, attempted_id: String) -> Self {
        Self {
            status_code: HTTP_CONFLICT,
            code: "CATALOG_ID_IMMUTABLE".to_string(),
            error: format!(
                "Identidade canônica imutável: não é permitido alterar o ID de «{previous_id}» para «{attempted_id}»."
            ),
            previous_id: Some(previous_id),
            attempted_id: Some(attempted_id),
        }
    }
}

/// Parsed row after allowlist — values kept as JSON (same as TS unknown).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeWriteRow {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

pub fn is_valid_shop_product_id(id: &str) -> bool {
    let len = id.len();
    if len < SHOP_PRODUCT_ID_MIN_LEN || len > SHOP_PRODUCT_ID_MAX_LEN {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

pub fn is_protected_upgrade_id(id: &str) -> bool {
    id.starts_with(TEMP_LEGACY_ID_PREFIX)
}

pub fn is_protected_upgrade_row(id: &str, category: Option<&str>, row_type: Option<&str>) -> bool {
    if is_protected_upgrade_id(id) {
        return true;
    }
    if category == Some(LEGACY_TEMP_MARKER) {
        return true;
    }
    if row_type == Some(LEGACY_TEMP_MARKER) {
        return true;
    }
    false
}

/// Extract first non-empty identity meta string (previousId / editingSourceId / …).
pub fn read_identity_previous_id(obj: &Map<String, Value>) -> Option<String> {
    for key in IDENTITY_META_KEYS {
        if let Some(Value::String(s)) = obj.get(*key) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Parse + allowlist; does not remap IDs.
pub fn parse_upgrade_write_rows(
    raw_list: &[Value],
) -> Result<Vec<UpgradeWriteRow>, CatalogWriteError> {
    let mut out = Vec::with_capacity(raw_list.len());
    for raw in raw_list {
        let obj = match raw {
            Value::Object(m) => m,
            _ => {
                return Err(CatalogWriteError::bad_request(
                    "CATALOG_ROW_INVALID",
                    "Cada item do catálogo deve ser um objeto.",
                ));
            }
        };

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();

        if !is_valid_shop_product_id(&id) {
            let shown = if id.is_empty() {
                "(vazio)"
            } else {
                id.as_str()
            };
            return Err(CatalogWriteError::bad_request(
                "CATALOG_ID_INVALID",
                format!(
                    "ID de item inválido: {shown}. Use apenas letras, números, \".\", \"_\" ou \"-\"."
                ),
            ));
        }
        if name.is_empty() {
            return Err(CatalogWriteError::bad_request(
                "CATALOG_NAME_REQUIRED",
                format!("Nome em falta para o item {id}."),
            ));
        }

        let previous_id = read_identity_previous_id(obj);

        let mut fields = Map::new();
        // Required-ish shape fields always present (may be null).
        for key in [
            "category",
            "type",
            "baseCost",
            "baseProduction",
            "description",
            "status",
        ] {
            if let Some(v) = obj.get(key) {
                fields.insert(key.to_string(), v.clone());
            } else {
                fields.insert(key.to_string(), Value::Null);
            }
        }

        for key in UPGRADE_WRITE_ALLOWED_FIELDS {
            if *key == "name" {
                continue;
            }
            if matches!(
                *key,
                "category" | "type" | "baseCost" | "baseProduction" | "description" | "status"
            ) {
                continue;
            }
            if let Some(v) = obj.get(*key) {
                fields.insert((*key).to_string(), v.clone());
            }
        }

        // Máquinas NFT (id `nft_*`): o H/s efetivo é o preço em USD. Força
        // `baseProduction == baseCost` no save — o admin não consegue dessincronizar
        // e mudar o preço propaga pro H/s. Só quando baseCost é número finito >= 0.
        if id.starts_with("nft_") {
            if let Some(cost) = fields.get("baseCost").and_then(Value::as_f64) {
                if cost.is_finite() && cost >= 0.0 {
                    fields.insert("baseProduction".to_string(), fields["baseCost"].clone());
                }
            }
        }

        out.push(UpgradeWriteRow {
            id,
            name,
            previous_id,
            fields,
        });
    }
    Ok(out)
}

/// previousId ≠ id → rename → reject (CATALOG_ID_IMMUTABLE).
pub fn assert_canonical_ids_immutable(rows: &[UpgradeWriteRow]) -> Result<(), CatalogWriteError> {
    for row in rows {
        if let Some(prev) = row
            .previous_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if prev != row.id {
                return Err(CatalogWriteError::conflict_immutable(
                    prev.to_string(),
                    row.id.clone(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nft_row_forces_base_production_equals_base_cost() {
        let rows = parse_upgrade_write_rows(&[json!({
            "id": "nft_pool_v3_mitico", "name": "NFT MÍTICO",
            "category": "NFT", "type": "machine",
            "baseCost": 200, "baseProduction": 2
        })])
        .unwrap();
        assert_eq!(rows[0].fields["baseProduction"].as_f64(), Some(200.0));
    }

    #[test]
    fn non_nft_row_keeps_base_production() {
        let rows = parse_upgrade_write_rows(&[json!({
            "id": "asic_aura-tec", "name": "USDC AURA MINER",
            "category": "ASIC", "type": "machine",
            "baseCost": 5, "baseProduction": 20
        })])
        .unwrap();
        assert_eq!(rows[0].fields["baseProduction"].as_f64(), Some(20.0));
    }

    #[test]
    fn nft_row_null_base_cost_leaves_base_production() {
        let rows = parse_upgrade_write_rows(&[json!({
            "id": "nft_x", "name": "X", "category": "NFT", "type": "machine",
            "baseCost": null, "baseProduction": 7
        })])
        .unwrap();
        assert_eq!(rows[0].fields["baseProduction"].as_f64(), Some(7.0));
    }

    #[test]
    fn shop_id_regex_parity() {
        assert!(is_valid_shop_product_id("gpu_v1"));
        assert!(is_valid_shop_product_id("a"));
        assert!(!is_valid_shop_product_id(""));
        assert!(!is_valid_shop_product_id("bad id!"));
        assert!(!is_valid_shop_product_id(
            &"x".repeat(SHOP_PRODUCT_ID_MAX_LEN + 1)
        ));
        assert!(is_valid_shop_product_id(
            &"x".repeat(SHOP_PRODUCT_ID_MAX_LEN)
        ));
    }

    #[test]
    fn protected_rows() {
        assert!(is_protected_upgrade_id("temp_legacy_foo"));
        assert!(is_protected_upgrade_row(
            "x",
            Some(LEGACY_TEMP_MARKER),
            None
        ));
        assert!(is_protected_upgrade_row(
            "x",
            None,
            Some(LEGACY_TEMP_MARKER)
        ));
        assert!(!is_protected_upgrade_row(
            "gpu_v1",
            Some("gpu"),
            Some("machine")
        ));
    }

    #[test]
    fn parse_ok_and_strips_junk() {
        let raw = json!([{
            "id": "gpu_v1",
            "name": " GPU ",
            "category": "gpu",
            "type": "machine",
            "baseCost": 10,
            "baseProduction": 1,
            "description": "d",
            "status": "normal",
            "totalSold": 999,
            "arbitraryHack": "drop"
        }]);
        let arr = raw.as_array().unwrap();
        let rows = parse_upgrade_write_rows(arr).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "gpu_v1");
        assert_eq!(rows[0].name, "GPU");
        assert!(!rows[0].fields.contains_key("totalSold"));
        assert!(!rows[0].fields.contains_key("arbitraryHack"));
        assert_eq!(rows[0].fields.get("category"), Some(&json!("gpu")));
    }

    #[test]
    fn parse_keeps_rack_room_affinity() {
        let raw = json!([{
            "id": "rack_a61",
            "name": "Rack",
            "category": "infrastructure",
            "type": "infrastructure",
            "baseCost": 1,
            "baseProduction": 0,
            "description": "d",
            "status": "normal",
            "rackRoomAffinity": "asic+standard"
        }]);
        let rows = parse_upgrade_write_rows(raw.as_array().unwrap()).unwrap();
        assert_eq!(
            rows[0].fields.get("rackRoomAffinity"),
            Some(&json!("asic+standard"))
        );
    }

    #[test]
    fn parse_reads_previous_id() {
        let raw = json!([{
            "id": "a",
            "name": "A",
            "category": "c",
            "type": "t",
            "baseCost": 1,
            "baseProduction": 1,
            "description": "d",
            "status": "normal",
            "editingSourceId": "a"
        }]);
        let rows = parse_upgrade_write_rows(raw.as_array().unwrap()).unwrap();
        assert_eq!(rows[0].previous_id.as_deref(), Some("a"));
    }

    #[test]
    fn parse_rejects_bad_id() {
        let raw = json!([{ "id": "bad id!", "name": "X" }]);
        let err = parse_upgrade_write_rows(raw.as_array().unwrap()).unwrap_err();
        assert_eq!(err.code, "CATALOG_ID_INVALID");
        assert_eq!(err.status_code, HTTP_BAD_REQUEST);
    }

    #[test]
    fn identity_immutable() {
        let row = UpgradeWriteRow {
            id: "new".into(),
            name: "N".into(),
            previous_id: Some("old".into()),
            fields: Map::new(),
        };
        let err = assert_canonical_ids_immutable(&[row]).unwrap_err();
        assert_eq!(err.code, "CATALOG_ID_IMMUTABLE");
        assert_eq!(err.status_code, HTTP_CONFLICT);
    }

    #[test]
    fn identity_same_id_ok() {
        let row = UpgradeWriteRow {
            id: "same".into(),
            name: "N".into(),
            previous_id: Some("same".into()),
            fields: Map::new(),
        };
        assert!(assert_canonical_ids_immutable(&[row]).is_ok());
    }
}
