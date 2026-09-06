//! Admin catalog replace — OCC lock / assert / UPSERT / soft-retire / bump in one TX.
//!
//! Mirrors Node `replaceShopUpgrades` I/O. Domain parse/identity via `genesis-core::catalog`.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::{GenericClient, Pool, Transaction};
use genesis_core::catalog::{
    apply_infrastructure_shared_fields_from_merge_roots, assert_canonical_ids_immutable,
    is_soft_retire_eligible_row, normalize_upgrade_rarity, parse_upgrade_write_rows,
    resolve_asic_duration_upsert_fields, UpgradeWriteRow, ASIC_DURATION_KIND_NONE,
    UPGRADE_DEFAULT_ICON, UPGRADE_STATUS_RETIRED,
};
use serde_json::Value;
use tokio_postgres::types::ToSql;

use crate::market::{BUY_LOCK_TIMEOUT_MS, TX_BUY_TIMEOUT_MS};
use crate::upgrades::purchase::PURCHASE_TX_TIMEOUT_MS;

use super::errors::{
    CatalogError, CODE_CATALOG_PAYLOAD_INVALID, CODE_CATALOG_REVISION_REQUIRED,
    ERR_CATALOG_PAYLOAD_INVALID, ERR_CATALOG_REVISION_INVALID, ERR_CATALOG_REVISION_REQUIRED,
};

/// Node `UPGRADES_CATALOG_META_ID`.
pub const UPGRADES_CATALOG_META_ID: i32 = 1;

/// Bulk catalog UPSERT — same budget as upgrade package purchase TX.
pub const CATALOG_REPLACE_TX_TIMEOUT_MS: u64 = PURCHASE_TX_TIMEOUT_MS;
/// Lock wait — same as market buy lock.
pub const CATALOG_REPLACE_LOCK_TIMEOUT_MS: u64 = BUY_LOCK_TIMEOUT_MS;

const _: () = assert!(CATALOG_REPLACE_TX_TIMEOUT_MS == 60_000);
const _: () = assert!(CATALOG_REPLACE_LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(TX_BUY_TIMEOUT_MS >= CATALOG_REPLACE_TX_TIMEOUT_MS);

pub const CATALOG_UPGRADES_REPLACE_PATH: &str = "/v1/catalog/upgrades/replace";

#[derive(Debug, Clone)]
pub struct ReplaceOutcome {
    pub catalog_revision: i64,
}

pub async fn replace_shop_upgrades(
    pool: &Pool,
    raw_upgrades: &[Value],
    expected_catalog_revision: i64,
) -> Result<ReplaceOutcome, CatalogError> {
    if expected_catalog_revision < 0 {
        return Err(CatalogError::bad_code(
            ERR_CATALOG_REVISION_INVALID,
            CODE_CATALOG_REVISION_REQUIRED,
        ));
    }

    let mut rows = parse_upgrade_write_rows(raw_upgrades)?;
    apply_infrastructure_shared_fields_from_merge_roots(&mut rows);

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.execute(
        &format!("SET LOCAL statement_timeout = {CATALOG_REPLACE_TX_TIMEOUT_MS}"),
        &[],
    )
    .await?;
    tx.execute(
        &format!("SET LOCAL lock_timeout = {CATALOG_REPLACE_LOCK_TIMEOUT_MS}"),
        &[],
    )
    .await?;

    let current = lock_upgrades_catalog_revision(&tx).await?;
    if current != expected_catalog_revision {
        // Explicit ROLLBACK via drop — return domain conflict.
        return Err(CatalogError::version_conflict(
            current,
            expected_catalog_revision,
        ));
    }

    let existing = load_existing_upgrade_rows(&tx).await?;

    assert_canonical_ids_immutable(&rows)?;

    let dur_by_id = load_asic_duration_by_id(&tx).await?;

    let incoming_ids: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();

    for u in &rows {
        upsert_upgrade_row(&tx, u, dur_by_id.get(&u.id)).await?;
        replace_compat_racks(&tx, u).await?;
    }

    for (id, meta) in &existing {
        if incoming_ids.contains(id) {
            continue;
        }
        if !is_soft_retire_eligible_row(id, meta.category.as_deref(), meta.row_type.as_deref()) {
            continue;
        }
        soft_retire_upgrade(&tx, id).await?;
    }

    sync_nft_room_only_flags(&tx).await?;
    let catalog_revision = bump_upgrades_catalog_revision(&tx).await?;
    tx.commit().await?;
    Ok(ReplaceOutcome { catalog_revision })
}

struct ExistingMeta {
    category: Option<String>,
    row_type: Option<String>,
}

struct ExistingDuration {
    amount: i32,
    unit: Option<String>,
}

async fn ensure_meta_row<C: GenericClient>(client: &C) -> Result<(), CatalogError> {
    client
        .execute(
            "INSERT INTO upgrades_catalog_meta (id, revision) VALUES ($1, 0)
             ON CONFLICT (id) DO NOTHING",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await?;
    Ok(())
}

async fn lock_upgrades_catalog_revision<C: GenericClient>(client: &C) -> Result<i64, CatalogError> {
    ensure_meta_row(client).await?;
    let row = client
        .query_one(
            "SELECT revision FROM upgrades_catalog_meta WHERE id = $1 FOR UPDATE",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await?;
    Ok(row_revision(&row)?)
}

async fn bump_upgrades_catalog_revision<C: GenericClient>(client: &C) -> Result<i64, CatalogError> {
    let row = client
        .query_one(
            "UPDATE upgrades_catalog_meta SET revision = revision + 1 WHERE id = $1 RETURNING revision",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await?;
    Ok(row_revision(&row)?)
}

fn row_revision(row: &tokio_postgres::Row) -> Result<i64, CatalogError> {
    // Prisma BigInt → INT8
    if let Ok(v) = row.try_get::<_, i64>("revision") {
        return Ok(v);
    }
    if let Ok(v) = row.try_get::<_, i32>("revision") {
        return Ok(i64::from(v));
    }
    Err(CatalogError::transport(anyhow::anyhow!(
        "upgrades_catalog_meta.revision unreadable"
    )))
}

async fn load_existing_upgrade_rows<C: GenericClient>(
    client: &C,
) -> Result<HashMap<String, ExistingMeta>, CatalogError> {
    let rows = client
        .query("SELECT id, category, type FROM upgrades", &[])
        .await?;
    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        let id: String = r.try_get("id")?;
        let category: String = r.try_get("category")?;
        let row_type: String = r.try_get("type")?;
        out.insert(
            id,
            ExistingMeta {
                category: Some(category),
                row_type: Some(row_type),
            },
        );
    }
    Ok(out)
}

async fn load_asic_duration_by_id<C: GenericClient>(
    client: &C,
) -> Result<HashMap<String, ExistingDuration>, CatalogError> {
    let rows = client
        .query(
            "SELECT id, asic_duration_amount, asic_duration_unit FROM upgrades",
            &[],
        )
        .await?;
    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        let id: String = r.try_get("id")?;
        let amount: i32 = r
            .try_get::<_, Option<i32>>("asic_duration_amount")?
            .unwrap_or(0);
        let unit: Option<String> = r.try_get("asic_duration_unit").ok().flatten();
        out.insert(id, ExistingDuration { amount, unit });
    }
    Ok(out)
}

async fn soft_retire_upgrade<C: GenericClient>(client: &C, id: &str) -> Result<(), CatalogError> {
    client
        .execute(
            "UPDATE upgrades SET
               status = $2,
               is_active = 0,
               sell_in_hardware_market = 0,
               sell_in_black_market = 0
             WHERE id = $1",
            &[&id, &UPGRADE_STATUS_RETIRED],
        )
        .await?;
    Ok(())
}

async fn sync_nft_room_only_flags<C: GenericClient>(client: &C) -> Result<(), CatalogError> {
    client
        .execute(
            "UPDATE mining_coins SET nft_room_only = 1
    WHERE id IN (
      SELECT DISTINCT btrim(nft_mining_coin_id)
      FROM upgrades
      WHERE nft_mining_coin_id IS NOT NULL AND btrim(nft_mining_coin_id) <> ''
    )
      AND id NOT IN ('usdc_interno')
      AND upper(btrim(symbol)) NOT IN ('USDC_INT')",
            &[],
        )
        .await?;
    client
        .execute(
            "UPDATE mining_coins SET nft_room_only = 0
    WHERE nft_room_only = 1
      AND id NOT IN (
        SELECT DISTINCT btrim(nft_mining_coin_id)
        FROM upgrades
        WHERE nft_mining_coin_id IS NOT NULL AND btrim(nft_mining_coin_id) <> ''
      )
      AND lower(btrim(id)) NOT IN ('usdt', 'cbbtc', 'dai', 'gho', 'gemt')
      AND upper(btrim(symbol)) NOT IN ('USDT', 'CBBTC', 'DAI', 'GHO', 'GEMT')
      AND NOT (lower(btrim(id)) ~ '(^|[_-])(usdt|cbbtc|dai|gho|gemt)([_-]|$)')",
            &[],
        )
        .await?;
    client
        .execute(
            "UPDATE mining_coins SET nft_room_only = 0
    WHERE id = 'usdc_interno'
       OR upper(btrim(symbol)) = 'USDC_INT'",
            &[],
        )
        .await?;
    Ok(())
}

async fn replace_compat_racks<C: GenericClient>(
    client: &C,
    u: &UpgradeWriteRow,
) -> Result<(), CatalogError> {
    client
        .execute(
            "DELETE FROM upgrade_compat_racks WHERE upgrade_id = $1",
            &[&u.id],
        )
        .await?;
    let racks = u
        .fields
        .get("compatibleRacks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for rid in racks {
        let Some(rack_id) = rid.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        client
            .execute(
                "INSERT INTO upgrade_compat_racks (upgrade_id, rack_id) VALUES ($1, $2)",
                &[&u.id, &rack_id],
            )
            .await?;
    }
    Ok(())
}

async fn upsert_upgrade_row(
    tx: &Transaction<'_>,
    u: &UpgradeWriteRow,
    existing_dur: Option<&ExistingDuration>,
) -> Result<(), CatalogError> {
    let has_amt = u.fields.contains_key("asicDurationAmount");
    let has_unit = u.fields.contains_key("asicDurationUnit");
    let (asic_amt, asic_unit) = resolve_asic_duration_upsert_fields(
        u.fields.get("asicDurationAmount"),
        u.fields.get("asicDurationUnit"),
        has_amt,
        has_unit,
        existing_dur.map(|d| d.amount),
        existing_dur.and_then(|d| d.unit.as_deref()),
    );

    let rarity = normalize_upgrade_rarity(u.fields.get("rarity").and_then(|v| v.as_str()));

    let rack_room_affinity = u
        .fields
        .get("rackRoomAffinity")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let category = json_text_or_empty(u.fields.get("category"));
    let row_type = json_text_or_empty(u.fields.get("type"));
    let base_cost = json_f64(u.fields.get("baseCost")).unwrap_or(0.0);
    let base_production = json_f64(u.fields.get("baseProduction")).unwrap_or(0.0);
    let power_consumption = json_f64_opt(u.fields.get("powerConsumption"));
    let power_capacity = json_f64_opt(u.fields.get("powerCapacity"));
    let multiplier = json_f64_opt(u.fields.get("multiplier"));
    let slots_capacity = json_i32_opt(u.fields.get("slotsCapacity"));
    let ai_slots_capacity = json_i32_opt(u.fields.get("aiSlotsCapacity"));
    let description = json_text_or_empty(u.fields.get("description"));
    let icon = u
        .fields
        .get("icon")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(UPGRADE_DEFAULT_ICON)
        .to_string();
    let status = json_text_or_empty(u.fields.get("status"));
    let is_nft: i32 = if json_truthy(u.fields.get("isNft")) {
        1
    } else {
        0
    };
    let nft_contract = json_opt_string(u.fields.get("nftContract"));
    let nft_token_id = json_opt_string(u.fields.get("nftTokenId"));
    let max_global_stock = json_i32_opt(u.fields.get("maxGlobalStock"));
    let image = json_opt_string(u.fields.get("image"));
    let layout = layout_json_string(u.fields.get("layout"));
    let reward_wh = json_f64(u.fields.get("rewardWh")).unwrap_or(0.0);
    let sell_hw: i32 = if json_default_true(u.fields.get("sellInHardwareMarket")) {
        1
    } else {
        0
    };
    let sell_bm: i32 = if json_default_true(u.fields.get("sellInBlackMarket")) {
        1
    } else {
        0
    };
    let is_active: i32 = if json_default_true(u.fields.get("isActive")) {
        1
    } else {
        0
    };
    let nft_mining_coin_id = u
        .fields
        .get("nftMiningCoinId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let asic_kind = ASIC_DURATION_KIND_NONE.to_string();

    let params: [&(dyn ToSql + Sync); 30] = [
        &u.id,
        &u.name,
        &category,
        &row_type,
        &base_cost,
        &base_production,
        &power_consumption,
        &power_capacity,
        &multiplier,
        &slots_capacity,
        &ai_slots_capacity,
        &description,
        &icon,
        &status,
        &is_nft,
        &nft_contract,
        &nft_token_id,
        &max_global_stock,
        &image,
        &layout,
        &reward_wh,
        &sell_hw,
        &sell_bm,
        &is_active,
        &nft_mining_coin_id,
        &asic_kind,
        &asic_amt,
        &asic_unit,
        &rarity,
        &rack_room_affinity,
    ];

    tx.execute(
        "INSERT INTO upgrades (
          id,name,category,type,base_cost,base_production,power_consumption,power_capacity,
          multiplier,slots_capacity,ai_slots_capacity,description,icon,status,is_nft,
          nft_contract,nft_token_id,max_global_stock,image,layout,reward_wh,
          sell_in_hardware_market,sell_in_black_market,is_active,nft_mining_coin_id,asic_duration_kind,
          asic_duration_amount,asic_duration_unit,rarity,rack_room_affinity
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
        ON CONFLICT (id) DO UPDATE SET
          name=EXCLUDED.name, category=EXCLUDED.category, type=EXCLUDED.type,
          base_cost=EXCLUDED.base_cost, base_production=EXCLUDED.base_production,
          power_consumption=EXCLUDED.power_consumption, power_capacity=EXCLUDED.power_capacity,
          multiplier=EXCLUDED.multiplier, slots_capacity=EXCLUDED.slots_capacity,
          ai_slots_capacity=EXCLUDED.ai_slots_capacity, description=EXCLUDED.description,
          icon=EXCLUDED.icon, status=EXCLUDED.status, is_nft=EXCLUDED.is_nft,
          nft_contract=EXCLUDED.nft_contract, nft_token_id=EXCLUDED.nft_token_id,
          max_global_stock=EXCLUDED.max_global_stock, image=EXCLUDED.image,
          layout=EXCLUDED.layout, reward_wh=EXCLUDED.reward_wh,
          sell_in_hardware_market=EXCLUDED.sell_in_hardware_market,
          sell_in_black_market=EXCLUDED.sell_in_black_market,
          is_active=EXCLUDED.is_active,
          nft_mining_coin_id=EXCLUDED.nft_mining_coin_id,
          asic_duration_kind=EXCLUDED.asic_duration_kind,
          asic_duration_amount=EXCLUDED.asic_duration_amount,
          asic_duration_unit=EXCLUDED.asic_duration_unit,
          rarity=EXCLUDED.rarity,
          rack_room_affinity=EXCLUDED.rack_room_affinity",
        &params,
    )
    .await?;
    Ok(())
}

fn json_text_or_empty(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string().trim_matches('"').to_string(),
    }
}

fn json_opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string().trim_matches('"').to_string()),
    }
}

fn json_f64(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

fn json_f64_opt(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        other => json_f64(other),
    }
}

fn json_i32_opt(v: Option<&Value>) -> Option<i32> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n
            .as_i64()
            .map(|i| i as i32)
            .or_else(|| n.as_f64().map(|f| f.floor() as i32)),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().map(|f| f.floor() as i32),
        _ => None,
    }
}

fn json_truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => {
            let t = s.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes"
        }
        _ => false,
    }
}

/// Node `!== false` — missing/null defaults to true.
fn json_default_true(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => {
            let t = s.trim().to_ascii_lowercase();
            !(t == "0" || t == "false" || t == "no")
        }
        _ => true,
    }
}

fn layout_json_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Some(other) => Some(other.to_string()),
    }
}

/// Parse expected revision from JSON number / numeric string (Node `parseExpectedCatalogRevision`).
pub fn parse_expected_catalog_revision(raw: &Value) -> Result<i64, CatalogError> {
    match raw {
        Value::Number(n) => {
            let f = n.as_f64().ok_or_else(|| {
                CatalogError::bad_code(
                    ERR_CATALOG_REVISION_REQUIRED,
                    CODE_CATALOG_REVISION_REQUIRED,
                )
            })?;
            if !f.is_finite() || f < 0.0 {
                return Err(CatalogError::bad_code(
                    ERR_CATALOG_REVISION_REQUIRED,
                    CODE_CATALOG_REVISION_REQUIRED,
                ));
            }
            Ok(f.floor() as i64)
        }
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Err(CatalogError::bad_code(
                    ERR_CATALOG_REVISION_REQUIRED,
                    CODE_CATALOG_REVISION_REQUIRED,
                ));
            }
            let f: f64 = t.parse().map_err(|_| {
                CatalogError::bad_code(
                    ERR_CATALOG_REVISION_REQUIRED,
                    CODE_CATALOG_REVISION_REQUIRED,
                )
            })?;
            if !f.is_finite() || f < 0.0 {
                return Err(CatalogError::bad_code(
                    ERR_CATALOG_REVISION_REQUIRED,
                    CODE_CATALOG_REVISION_REQUIRED,
                ));
            }
            Ok(f.floor() as i64)
        }
        _ => Err(CatalogError::bad_code(
            ERR_CATALOG_REVISION_REQUIRED,
            CODE_CATALOG_REVISION_REQUIRED,
        )),
    }
}

pub fn require_upgrades_array(raw: &Value) -> Result<&[Value], CatalogError> {
    match raw {
        Value::Array(a) => Ok(a.as_slice()),
        _ => Err(CatalogError::bad_code(
            ERR_CATALOG_PAYLOAD_INVALID,
            CODE_CATALOG_PAYLOAD_INVALID,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timeout_constants() {
        assert_eq!(CATALOG_REPLACE_TX_TIMEOUT_MS, 60_000);
        assert_eq!(CATALOG_REPLACE_LOCK_TIMEOUT_MS, 45_000);
        assert!(TX_BUY_TIMEOUT_MS >= CATALOG_REPLACE_TX_TIMEOUT_MS);
    }

    #[test]
    fn parse_revision() {
        assert_eq!(parse_expected_catalog_revision(&json!(42)).unwrap(), 42);
        assert_eq!(parse_expected_catalog_revision(&json!("7")).unwrap(), 7);
        assert!(parse_expected_catalog_revision(&json!(-1)).is_err());
        assert!(parse_expected_catalog_revision(&json!(null)).is_err());
    }

    #[test]
    fn default_true_parity() {
        assert!(json_default_true(None));
        assert!(json_default_true(Some(&Value::Null)));
        assert!(!json_default_true(Some(&json!(false))));
        assert!(json_default_true(Some(&json!(true))));
    }
}
