//! `GET /api/inventory/state` + `/me` — Node `inventory/services/snapshot.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::catalog::TEMP_LEGACY_ID_PREFIX;
use genesis_core::hardware::catalog::{
    normalize_known_1000wh_battery_catalog_id, CANONICAL_1000WH_BATTERY_ID, PURGED_LEGACY_STOCK_IDS,
};
use genesis_core::hardware::duration::is_timed_asic_duration;
use serde::Serialize;
use serde_json::{json, Value};

use crate::leases::load_asic_duration_config;
use crate::persist::fold_warehouse_ids;
use crate::pg_types::pg_user_id;

use super::{f64_cell, i32_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError};

/// Node `PUBLIC_REF_LENGTH`.
const PUBLIC_REF_LENGTH: usize = 8;
/// Node `PUBLIC_REF_FALLBACK_LENGTH`.
const PUBLIC_REF_FALLBACK_LENGTH: usize = 6;
const PUBLIC_REF_FALLBACK: &str = "—";
const CAT_INFRA: &str = "Infraestrutura";
const CAT_ENERGY: &str = "Energia & Cabeamento";
const CAT_OTHERS: &str = "Outros";
const CAT_LEGACY_TEMP: &str = "legacy-temp";
const BATTERY_STATUS_INVENTORY: &str = "INVENTORY";
const BATTERY_STATUS_EQUIPPED: &str = "EQUIPPED";
const BATTERY_STATUS_BROKEN: &str = "BROKEN";
const BATTERY_STATUS_CONSUMED: &str = "CONSUMED";
const BATTERY_STATUS_LOCKED: &str = "LOCKED";
const BATTERY_LOC_WAREHOUSE: &str = "WAREHOUSE";
const BATTERY_LOC_INVENTORY: &str = "INVENTORY";
const NO_SLOT_INDEX: i32 = 0;
const CHARGER_PREFIX: &str = "charger_";
const STATE_VERSION: i32 = 1;

const _: () = assert!(PUBLIC_REF_LENGTH == 8);
const _: () = assert!(PUBLIC_REF_FALLBACK_LENGTH == 6);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StackRow {
    stock_key: String,
    catalog_item_id: String,
    display_quantity: i64,
    available_quantity: i64,
    name: String,
    description: String,
    category: String,
    #[serde(rename = "type")]
    row_type: String,
    image: Option<String>,
    icon: String,
    base_production: f64,
    power_consumption: f64,
    power_capacity: f64,
    slots_capacity: f64,
    ai_slots_capacity: f64,
    is_nft: bool,
}

#[derive(Debug, Clone)]
struct UpgradeSelect {
    id: String,
    name: String,
    category: String,
    row_type: String,
    description: String,
    icon: String,
    image: Option<String>,
    base_production: f64,
    power_consumption: f64,
    power_capacity: f64,
    slots_capacity: f64,
    ai_slots_capacity: f64,
    is_nft: bool,
}

pub async fn run_inventory_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let out = build_inventory_state(&tx, user_id).await?;
    tx.commit().await?;
    Ok(out)
}

async fn build_inventory_state<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rack_rows = client
        .query(
            "SELECT battery_id FROM placed_racks WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut mounted = HashSet::new();
    for r in &rack_rows {
        if let Some(id) = opt_string_cell(r, "battery_id") {
            mounted.insert(id.trim().to_string());
        }
    }

    let stock_rows = client
        .query("SELECT item_id, qty FROM stock WHERE user_id = $1", &[&uid])
        .await?;
    let mut stock: HashMap<String, i64> = HashMap::new();
    for r in &stock_rows {
        let id = string_cell(r, "item_id").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let q = i64::from(i32_cell(r, "qty"));
        if q > 0 {
            stock.insert(id, q);
        }
    }
    overlay_timed_lease_stock_counts(client, user_id, &mut stock).await?;

    let bat_rows = client
        .query(
            "SELECT id, item_id, display_name, image_url, status, location, rack_id, slot_id, room_id
             FROM stored_batteries WHERE user_id = $1",
            &[&uid],
        )
        .await?;

    let gs = client
        .query_opt(
            "SELECT last_updated_at, server_updated_at FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let last = gs
        .as_ref()
        .map(|r| i64_ms_cell(r, "last_updated_at"))
        .unwrap_or(0);
    let srv = gs
        .as_ref()
        .map(|r| i64_ms_cell(r, "server_updated_at"))
        .unwrap_or(0);
    let server_updated_at = last.max(srv);

    let mut loose_ids = Vec::new();
    let mut loose_dtos = Vec::new();
    for b in &bat_rows {
        let id = string_cell(b, "id").trim().to_string();
        let item_id = string_cell(b, "item_id").trim().to_string();
        if id.is_empty() || item_id.is_empty() {
            continue;
        }
        if !should_expose_battery(
            &id,
            opt_string_cell(b, "status").as_deref(),
            opt_string_cell(b, "location").as_deref(),
            opt_string_cell(b, "rack_id").as_deref(),
            opt_i32_cell(b, "slot_id"),
            opt_string_cell(b, "room_id").as_deref(),
            &mounted,
        ) {
            continue;
        }
        loose_ids.push(id.clone());
        loose_dtos.push(battery_dto(
            &id,
            &item_id,
            opt_string_cell(b, "display_name"),
            opt_string_cell(b, "image_url"),
        ));
    }

    let mut stored_batteries = Vec::new();
    if !loose_ids.is_empty() {
        match fold_warehouse_ids(client, user_id, &loose_ids).await {
            Ok(credited) => {
                for (item_id, qty) in credited {
                    if qty > 0 {
                        *stock.entry(item_id).or_insert(0) += qty;
                    }
                }
            }
            Err(_) => {
                stored_batteries = loose_dtos;
            }
        }
    }

    let mut upgrade_ids: HashSet<String> = stock.keys().cloned().collect();
    for b in &bat_rows {
        let item_id = string_cell(b, "item_id").trim().to_string();
        if !item_id.is_empty() {
            upgrade_ids.insert(item_id);
        }
    }
    upgrade_ids.insert(CANONICAL_1000WH_BATTERY_ID.to_string());
    let upgrade_list: Vec<String> = upgrade_ids.into_iter().collect();
    let upgrade_by_id = load_upgrades(client, &upgrade_list).await?;
    let stack_rows = resolve_stackable_rows(&stock, &upgrade_by_id);
    let stackable_categories = group_stackables(stack_rows);

    let stock_json: BTreeMap<String, i64> = stock.into_iter().filter(|(_, q)| *q > 0).collect();
    Ok(json!({
        "version": STATE_VERSION,
        "serverUpdatedAt": server_updated_at,
        "stateVersion": server_updated_at,
        "stock": stock_json,
        "storedBatteries": stored_batteries,
        "stackableCategories": stackable_categories,
    }))
}

fn i64_ms_cell(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v as i64;
        }
    }
    0
}

pub(crate) async fn overlay_timed_lease_stock_counts<C: GenericClient>(
    client: &C,
    user_id: i64,
    stock: &mut HashMap<String, i64>,
) -> Result<(), PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let now_ms = crate::config::current_unix_ms();
    let lease_rows = client
        .query(
            "SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut item_ids: HashSet<String> = HashSet::new();
    for r in &lease_rows {
        let id = string_cell(r, "item_id").trim().to_string();
        if !id.is_empty() {
            item_ids.insert(id);
        }
    }
    for id in stock.keys() {
        item_ids.insert(id.clone());
    }
    for item_id in item_ids {
        let cfg = load_asic_duration_config(client, &item_id).await?;
        if !is_timed_asic_duration(&cfg) {
            continue;
        }
        let cnt = client
            .query_one(
                "SELECT COUNT(*)::int AS n FROM player_asic_leases
                  WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3",
                &[&uid, &item_id, &now_ms],
            )
            .await?;
        let qty = i64::from(i32_cell(&cnt, "n"));
        if qty > 0 {
            stock.insert(item_id, qty);
        } else {
            stock.remove(&item_id);
        }
    }
    Ok(())
}

async fn load_upgrades<C: GenericClient>(
    client: &C,
    ids: &[String],
) -> Result<HashMap<String, UpgradeSelect>, PlayerReadError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = client
        .query(
            "SELECT id, name, category, type, description, icon, image,
                    base_production::double precision AS base_production,
                    power_consumption::double precision AS power_consumption,
                    power_capacity::double precision AS power_capacity,
                    slots_capacity::double precision AS slots_capacity,
                    ai_slots_capacity::double precision AS ai_slots_capacity,
                    is_nft
               FROM upgrades WHERE id = ANY($1::text[])",
            &[&ids],
        )
        .await?;
    let mut map = HashMap::new();
    for r in &rows {
        let id = string_cell(r, "id");
        if id.is_empty() {
            continue;
        }
        map.insert(
            id.clone(),
            UpgradeSelect {
                id,
                name: string_cell(r, "name"),
                category: string_cell(r, "category"),
                row_type: string_cell(r, "type"),
                description: string_cell(r, "description"),
                icon: string_cell(r, "icon"),
                image: opt_string_cell(r, "image"),
                base_production: f64_cell(r, "base_production"),
                power_consumption: f64_cell(r, "power_consumption"),
                power_capacity: f64_cell(r, "power_capacity"),
                slots_capacity: f64_cell(r, "slots_capacity"),
                ai_slots_capacity: f64_cell(r, "ai_slots_capacity"),
                is_nft: i32_cell(r, "is_nft") != 0,
            },
        );
    }
    Ok(map)
}

fn map_upgrade_to_stack(stock_key: &str, qty: i64, u: &UpgradeSelect) -> StackRow {
    StackRow {
        stock_key: stock_key.to_string(),
        catalog_item_id: u.id.clone(),
        display_quantity: qty,
        available_quantity: qty,
        name: if u.name.is_empty() {
            stock_key.to_string()
        } else {
            u.name.clone()
        },
        description: u.description.clone(),
        category: if u.category.is_empty() {
            CAT_OTHERS.to_string()
        } else {
            u.category.clone()
        },
        row_type: if u.row_type.is_empty() {
            "other".into()
        } else {
            u.row_type.clone()
        },
        image: u.image.clone(),
        icon: u.icon.clone(),
        base_production: u.base_production,
        power_consumption: u.power_consumption,
        power_capacity: u.power_capacity,
        slots_capacity: u.slots_capacity,
        ai_slots_capacity: u.ai_slots_capacity,
        is_nft: u.is_nft,
    }
}

fn is_legacy_temp_key(item_id: &str) -> bool {
    item_id.starts_with(TEMP_LEGACY_ID_PREFIX)
}

fn parse_orig_catalog_id_from_legacy_temp(
    temp_upgrade_id: &str,
    description: Option<&str>,
) -> Option<String> {
    if let Some(desc) = description {
        if let Some(start) = desc.find("original=") {
            let rest = &desc[start + "original=".len()..];
            if let Some(end) = rest.find(" email=") {
                let id = rest[..end].trim();
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    let prefix = TEMP_LEGACY_ID_PREFIX;
    if let Some(rest) = temp_upgrade_id.strip_prefix(prefix) {
        if let Some(us) = rest.find('_') {
            let slug = rest[us + 1..].trim();
            if !slug.is_empty() {
                return Some(slug.to_string());
            }
        }
    }
    None
}

fn purged_remap_to_estelar(id: &str) -> bool {
    PURGED_LEGACY_STOCK_IDS.iter().any(|x| *x == id) && !id.starts_with(CHARGER_PREFIX)
}

fn resolve_stackable_rows(
    stock: &HashMap<String, i64>,
    upgrade_by_id: &HashMap<String, UpgradeSelect>,
) -> Vec<StackRow> {
    let mut rows = Vec::new();
    for (stock_key, qty) in stock {
        if *qty <= 0 {
            continue;
        }
        let u = upgrade_by_id.get(stock_key);
        let is_legacy = is_legacy_temp_key(stock_key)
            || u.is_some_and(|x| x.category == CAT_LEGACY_TEMP && x.row_type == CAT_LEGACY_TEMP);
        if is_legacy {
            let orig = parse_orig_catalog_id_from_legacy_temp(
                stock_key,
                u.map(|x| x.description.as_str()),
            );
            if let Some(orig_id) = orig.as_deref() {
                if purged_remap_to_estelar(orig_id) {
                    if let Some(estelar) = upgrade_by_id.get(CANONICAL_1000WH_BATTERY_ID) {
                        if !estelar.name.is_empty() {
                            let mut base = map_upgrade_to_stack(stock_key, *qty, estelar);
                            base.stock_key = stock_key.clone();
                            base.catalog_item_id = CANONICAL_1000WH_BATTERY_ID.to_string();
                            rows.push(base);
                            continue;
                        }
                    }
                }
                if let Some(real) = upgrade_by_id.get(orig_id) {
                    if !real.name.is_empty() {
                        let mut base = map_upgrade_to_stack(stock_key, *qty, real);
                        base.stock_key = stock_key.clone();
                        base.catalog_item_id = real.id.clone();
                        rows.push(base);
                        continue;
                    }
                }
            }
            continue;
        }
        let Some(u) = u else { continue };
        rows.push(map_upgrade_to_stack(stock_key, *qty, u));
    }
    rows
}

pub fn sort_inventory_category_keys(mut categories: Vec<String>) -> Vec<String> {
    categories.sort_by(|a, b| {
        if a == CAT_INFRA {
            return std::cmp::Ordering::Less;
        }
        if b == CAT_INFRA {
            return std::cmp::Ordering::Greater;
        }
        if a == CAT_ENERGY {
            return std::cmp::Ordering::Less;
        }
        if b == CAT_ENERGY {
            return std::cmp::Ordering::Greater;
        }
        a.cmp(b)
    });
    categories
}

fn group_stackables(rows: Vec<StackRow>) -> Value {
    let mut by_cat: BTreeMap<String, Vec<StackRow>> = BTreeMap::new();
    for r in rows {
        let c = if r.category.is_empty() {
            CAT_OTHERS.to_string()
        } else {
            r.category.clone()
        };
        by_cat.entry(c).or_default().push(r);
    }
    let keys = sort_inventory_category_keys(by_cat.keys().cloned().collect());
    let cats: Vec<Value> = keys
        .into_iter()
        .map(|category| {
            json!({
                "category": category,
                "items": by_cat.remove(&category).unwrap_or_default(),
            })
        })
        .collect();
    Value::Array(cats)
}

fn public_ref_from_instance_id(id: &str) -> String {
    let t = id.trim();
    if t.len() >= PUBLIC_REF_LENGTH {
        return t[..PUBLIC_REF_LENGTH].to_ascii_lowercase();
    }
    let fallback = t
        .chars()
        .take(PUBLIC_REF_FALLBACK_LENGTH)
        .collect::<String>();
    if fallback.is_empty() {
        PUBLIC_REF_FALLBACK.to_string()
    } else {
        fallback
    }
}

fn battery_dto(
    id: &str,
    item_id: &str,
    display_name: Option<String>,
    image_url: Option<String>,
) -> Value {
    json!({
        "id": id,
        "itemId": item_id,
        "displayName": display_name,
        "imageUrl": image_url,
        "publicRef": public_ref_from_instance_id(id),
    })
}

fn normalize_battery_status(status: Option<&str>) -> String {
    status.unwrap_or("").trim().to_ascii_uppercase()
}

fn is_warehouse_location(location: Option<&str>) -> bool {
    let l = location.unwrap_or("").trim().to_ascii_uppercase();
    l.is_empty() || l == BATTERY_LOC_WAREHOUSE || l == BATTERY_LOC_INVENTORY
}

pub fn should_expose_battery(
    id: &str,
    status: Option<&str>,
    location: Option<&str>,
    rack_id: Option<&str>,
    slot_id: Option<i32>,
    room_id: Option<&str>,
    mounted: &HashSet<String>,
) -> bool {
    let id = id.trim();
    if id.is_empty() {
        return false;
    }
    if mounted.contains(id) {
        return false;
    }
    let st = normalize_battery_status(status);
    if st == BATTERY_STATUS_EQUIPPED {
        return false;
    }
    if st == BATTERY_STATUS_CONSUMED || st == BATTERY_STATUS_LOCKED || st == BATTERY_STATUS_BROKEN {
        return false;
    }
    if !rack_id.unwrap_or("").trim().is_empty() {
        return false;
    }
    if let Some(sid) = slot_id {
        if sid != NO_SLOT_INDEX {
            return false;
        }
    }
    if !room_id.unwrap_or("").trim().is_empty() {
        return false;
    }
    if st == BATTERY_STATUS_INVENTORY || st.is_empty() {
        return is_warehouse_location(location);
    }
    false
}

pub fn inventory_me_from_state(state: &Value) -> Value {
    let stock = state.get("stock").cloned().unwrap_or(json!({}));
    let batteries = state
        .get("storedBatteries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|b| {
                    json!({
                        "id": b.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                        "itemId": b.get("itemId").and_then(|x| x.as_str()).unwrap_or(""),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "stock": stock,
        "storedBatteries": batteries,
        "serverUpdatedAt": state.get("serverUpdatedAt").cloned().unwrap_or(json!(0)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_sort_infra_then_energy() {
        let keys = sort_inventory_category_keys(vec![
            "Outros".into(),
            CAT_ENERGY.into(),
            CAT_INFRA.into(),
            "Bots".into(),
        ]);
        assert_eq!(
            keys,
            vec![
                CAT_INFRA.to_string(),
                CAT_ENERGY.to_string(),
                "Bots".to_string(),
                "Outros".to_string()
            ]
        );
    }

    #[test]
    fn public_ref_truncates() {
        assert_eq!(public_ref_from_instance_id("ABCDEF12-3456"), "abcdef12");
        assert_eq!(public_ref_from_instance_id(""), PUBLIC_REF_FALLBACK);
    }

    #[test]
    fn expose_warehouse_inventory() {
        let mounted = HashSet::new();
        assert!(should_expose_battery(
            "bat-1",
            Some("INVENTORY"),
            Some("WAREHOUSE"),
            None,
            None,
            None,
            &mounted
        ));
        let mut mounted = HashSet::new();
        mounted.insert("bat-1".into());
        assert!(!should_expose_battery(
            "bat-1",
            Some("INVENTORY"),
            Some("WAREHOUSE"),
            None,
            None,
            None,
            &mounted
        ));
    }

    #[test]
    fn normalize_estelar_id() {
        assert_eq!(
            normalize_known_1000wh_battery_catalog_id(Some("battery_stellar")),
            CANONICAL_1000WH_BATTERY_ID
        );
    }
}
