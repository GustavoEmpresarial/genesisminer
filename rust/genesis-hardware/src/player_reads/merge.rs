//! Merge Station reads — Node `GET /api/merge/{config,inventory,history}`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::nft::is_asic_machine_upgrade;
use genesis_core::{
    compute_merge_result_stats, normalize_merge_rarity, CatalogType, MergeCostPct, MergeRarity,
    MergeRuntimeSettings, MergeSourceCatalog, RackHsBonusPct, DEFAULT_MERGE_GAIN_PERCENT,
    MERGE_MAX_COUNT, MIN_MERGE_QTY,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::pg_types::pg_user_id;

use super::{
    f64_cell, i32_cell, i64_cell, opt_f64_cell, opt_i32_cell, opt_string_cell, string_cell,
    PlayerReadError,
};

/// Node `GAIN_PERCENT_MAX` / `MERGE_COST_PCT_MAX`.
const PERCENT_MAX: f64 = 100.0;
/// Node `RACK_HS_BONUS_PCT_MAX`.
const RACK_HS_BONUS_PCT_MAX: f64 = 500.0;
/// Node `PERCENT_ROUND_FACTOR` / `FEE_TOTAL_ROUND_FACTOR`.
const PERCENT_ROUND_FACTOR: f64 = 100.0;
/// Node `HISTORY_RECENT_LIMIT_DEFAULT`.
const HISTORY_LIMIT_DEFAULT: i64 = 40;
/// Node `HISTORY_RECENT_LIMIT_MAX`.
const HISTORY_LIMIT_MAX: i64 = 100;
/// Node `DEFAULT_ICON`.
const DEFAULT_ICON: &str = "📦";
/// Node `MERGE_FORBIDDEN_ROOT_IDS`.
const MERGE_FORBIDDEN_ROOT_IDS: &[&str] = &[
    "dolar_f2p",
    "dolar_f2p2",
    "armario_1",
    "battery_nebula",
    "cic",
];
const MERGE_CATALOG_PREFIX: &str = "merge_";
const IS_NFT_FLAG: i32 = 1;
const MERGE_SETTINGS_ID: i32 = 1;
const TYPE_MACHINE: &str = "machine";
const TYPE_MULTIPLIER: &str = "multiplier";
const TYPE_INFRASTRUCTURE: &str = "infrastructure";

const _: () = assert!(HISTORY_LIMIT_DEFAULT == 40);
const _: () = assert!(HISTORY_LIMIT_MAX == 100);
const _: () = assert!(PERCENT_MAX as i64 == 100);
const _: () = assert!(RACK_HS_BONUS_PCT_MAX as i64 == 500);
const _: () = assert!(MERGE_MAX_COUNT == 50);
const _: () = assert!(MIN_MERGE_QTY == 2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub(crate) struct MergeFlags {
    pub(crate) enabled: bool,
    pub(crate) enabled_machine: bool,
    pub(crate) enabled_multiplier: bool,
    pub(crate) enabled_infrastructure: bool,
    pub(crate) runtime: MergeRuntimeSettings,
}

pub async fn run_merge_config(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let flags = load_merge_flags(&conn).await?;
    let enabled_by_type = json!({
        "machine": flags.enabled_machine,
        "multiplier": flags.enabled_multiplier,
        "infrastructure": flags.enabled_infrastructure,
    });
    let allowed = allowed_types(&flags);
    Ok(json!({
        "enabled": flags.enabled && any_type_enabled(&flags),
        "enabledByType": enabled_by_type,
        "gainPercent": flags.runtime.gain_percent,
        "costPctByRarity": json!({
            "common": flags.runtime.cost_pct_by_rarity.common,
            "uncommon": flags.runtime.cost_pct_by_rarity.uncommon,
            "rare": flags.runtime.cost_pct_by_rarity.rare,
            "epic": flags.runtime.cost_pct_by_rarity.epic,
            "legendary": flags.runtime.cost_pct_by_rarity.legendary,
        }),
        "rackHsBonusPctByRarity": json!({
            "common": flags.runtime.rack_hs_bonus_pct_by_rarity.common,
            "uncommon": flags.runtime.rack_hs_bonus_pct_by_rarity.uncommon,
            "rare": flags.runtime.rack_hs_bonus_pct_by_rarity.rare,
            "epic": flags.runtime.rack_hs_bonus_pct_by_rarity.epic,
            "legendary": flags.runtime.rack_hs_bonus_pct_by_rarity.legendary,
            "supreme": flags.runtime.rack_hs_bonus_pct_by_rarity.supreme,
        }),
        "resultRarityBySource": json!({
            "common": "uncommon",
            "uncommon": "rare",
            "rare": "epic",
            "epic": "legendary",
            "legendary": "supreme",
        }),
        "rarities": [
            { "id": "common", "label": "Common" },
            { "id": "uncommon", "label": "Uncommon" },
            { "id": "rare", "label": "Rare" },
            { "id": "epic", "label": "Epic" },
            { "id": "legendary", "label": "Legendary" },
            { "id": "supreme", "label": "Supreme" },
        ],
        "allowedTypes": allowed,
    }))
}

pub async fn run_merge_inventory(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let flags = load_merge_flags(&conn).await?;
    if !flags.enabled {
        return Err(PlayerReadError::forbidden("Merge Station is disabled."));
    }
    let active = allowed_types(&flags);
    if active.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let uid = pg_user_id(user_id)?;
    let rows = conn
        .query(
            "SELECT s.item_id, s.qty, u.name, u.type, u.category, COALESCE(u.rarity, 'common') AS rarity,
                    u.base_cost::double precision AS base_cost,
                    u.base_production::double precision AS base_production,
                    u.power_consumption::double precision AS power_consumption,
                    u.multiplier::double precision AS multiplier,
                    u.slots_capacity, u.ai_slots_capacity, u.image, u.icon,
                    COALESCE(u.is_nft, 0) AS is_nft
               FROM stock s
               INNER JOIN upgrades u ON u.id = s.item_id
              WHERE s.user_id = $1
                AND s.qty > 0
                AND u.type = ANY($2::text[])
              ORDER BY u.type ASC, u.name ASC",
            &[&uid, &active],
        )
        .await?;
    let mut items = Vec::new();
    for r in &rows {
        let catalog_type = match CatalogType::parse(&string_cell(r, "type")) {
            Some(t) => t,
            None => continue,
        };
        if !type_enabled(&flags, catalog_type) {
            continue;
        }
        let item_id = string_cell(r, "item_id");
        let category = string_cell(r, "category");
        let typ = string_cell(r, "type");
        if is_merge_forbidden(&item_id, i32_cell(r, "is_nft"), &category, &typ) {
            continue;
        }
        if is_asic_machine_upgrade(&typ, &item_id, Some(category.as_str())) {
            continue;
        }
        let rarity = normalize_merge_rarity(&string_cell(r, "rarity"));
        let source = MergeSourceCatalog {
            id: item_id.clone(),
            name: string_cell(r, "name"),
            category,
            catalog_type,
            rarity,
            base_cost: f64_cell(r, "base_cost"),
            base_production: f64_cell(r, "base_production"),
            power_consumption: opt_f64_cell(r, "power_consumption"),
            multiplier: opt_f64_cell(r, "multiplier"),
            slots_capacity: opt_i32_cell(r, "slots_capacity"),
            ai_slots_capacity: opt_i32_cell(r, "ai_slots_capacity"),
        };
        let preview = compute_merge_result_stats(&source, &flags.runtime);
        let qty = i32_cell(r, "qty").max(0);
        let max_merges = (qty as u32 / MIN_MERGE_QTY).min(MERGE_MAX_COUNT);
        let (can_merge, block_reason) = merge_block(qty as u32, rarity, preview.is_some());
        items.push(json!({
            "itemId": item_id,
            "qty": qty,
            "name": string_cell(r, "name"),
            "type": typ,
            "rarity": rarity.as_str(),
            "resultRarity": preview.as_ref().map(|p| p.result_rarity.as_str()),
            "baseCost": f64_cell(r, "base_cost"),
            "baseProduction": f64_cell(r, "base_production"),
            "powerConsumption": opt_f64_cell(r, "power_consumption"),
            "multiplier": opt_f64_cell(r, "multiplier"),
            "image": opt_string_cell(r, "image"),
            "icon": opt_string_cell(r, "icon").unwrap_or_else(|| DEFAULT_ICON.to_string()),
            "feeUsdc": preview.as_ref().map(|p| p.fee_usdc).unwrap_or(0.0),
            "maxMerges": max_merges,
            "canMerge": can_merge,
            "blockReason": block_reason,
            "preview": preview.as_ref().map(|p| json!({
                "resultRarity": p.result_rarity.as_str(),
                "name": p.name,
                "baseCost": p.base_cost,
                "baseProduction": p.base_production,
                "powerConsumption": p.power_consumption,
                "multiplier": p.multiplier,
                "slotsCapacity": p.slots_capacity,
                "aiSlotsCapacity": p.ai_slots_capacity,
                "feeUsdc": p.fee_usdc,
                "costPct": p.cost_pct,
                "gainPercent": p.gain_percent,
            })),
        }));
    }
    Ok(json!({ "items": group_merge_items(items) }))
}

pub async fn run_merge_history(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let recent_limit = clamp_history_limit(limit);
    let totals = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS total,
                    COALESCE(SUM(fee_usdc), 0)::double precision AS fee_total
               FROM merge_history WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let summary_rows = conn
        .query(
            "SELECT h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity,
                    COUNT(*)::int AS merge_count,
                    COALESCE(SUM(h.fee_usdc), 0)::double precision AS fee_total,
                    MAX(h.created_at) AS last_at,
                    MAX(us.name) AS source_name,
                    MAX(ur.name) AS result_name,
                    MAX(us.image) AS source_image,
                    MAX(us.icon) AS source_icon,
                    MAX(us.type) AS source_type
               FROM merge_history h
               LEFT JOIN upgrades us ON us.id = h.source_item_id
               LEFT JOIN upgrades ur ON ur.id = h.result_item_id
              WHERE h.user_id = $1
              GROUP BY h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity
              ORDER BY MAX(h.created_at) DESC",
            &[&uid],
        )
        .await?;
    let recent_rows = conn
        .query(
            "SELECT h.id, h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity,
                    h.fee_usdc::double precision AS fee_usdc, h.created_at,
                    us.name AS source_name, ur.name AS result_name,
                    us.image AS source_image, us.icon AS source_icon, us.type AS source_type
               FROM merge_history h
               LEFT JOIN upgrades us ON us.id = h.source_item_id
               LEFT JOIN upgrades ur ON ur.id = h.result_item_id
              WHERE h.user_id = $1
              ORDER BY h.created_at DESC
              LIMIT $2",
            &[&uid, &recent_limit],
        )
        .await?;
    let summary: Vec<Value> = summary_rows
        .iter()
        .map(|r| {
            json!({
                "sourceItemId": string_cell(r, "source_item_id"),
                "sourceName": opt_string_cell(r, "source_name").unwrap_or_else(|| string_cell(r, "source_item_id")),
                "sourceRarity": normalize_merge_rarity(&string_cell(r, "source_rarity")).as_str(),
                "resultItemId": string_cell(r, "result_item_id"),
                "resultName": opt_string_cell(r, "result_name").unwrap_or_else(|| string_cell(r, "result_item_id")),
                "resultRarity": normalize_merge_rarity(&string_cell(r, "result_rarity")).as_str(),
                "type": opt_string_cell(r, "source_type"),
                "icon": opt_string_cell(r, "source_icon").unwrap_or_else(|| DEFAULT_ICON.to_string()),
                "image": opt_string_cell(r, "source_image"),
                "mergeCount": i32_cell(r, "merge_count").max(0),
                "feeTotalUsdc": round_fee(f64_cell(r, "fee_total")),
                "lastAt": i64_cell(r, "last_at"),
            })
        })
        .collect();
    let recent: Vec<Value> = recent_rows
        .iter()
        .map(|r| {
            json!({
                "id": i64_cell(r, "id").to_string(),
                "sourceItemId": string_cell(r, "source_item_id"),
                "sourceName": opt_string_cell(r, "source_name").unwrap_or_else(|| string_cell(r, "source_item_id")),
                "sourceRarity": normalize_merge_rarity(&string_cell(r, "source_rarity")).as_str(),
                "resultItemId": string_cell(r, "result_item_id"),
                "resultName": opt_string_cell(r, "result_name").unwrap_or_else(|| string_cell(r, "result_item_id")),
                "resultRarity": normalize_merge_rarity(&string_cell(r, "result_rarity")).as_str(),
                "type": opt_string_cell(r, "source_type"),
                "icon": opt_string_cell(r, "source_icon").unwrap_or_else(|| DEFAULT_ICON.to_string()),
                "image": opt_string_cell(r, "source_image"),
                "feeUsdc": round_fee(f64_cell(r, "fee_usdc")),
                "createdAt": i64_cell(r, "created_at"),
            })
        })
        .collect();
    Ok(json!({
        "totalMerges": i64_cell(&totals, "total").max(0),
        "feeTotalUsdc": round_fee(f64_cell(&totals, "fee_total")),
        "summary": summary,
        "recent": recent,
    }))
}

pub(crate) async fn load_merge_flags<C: GenericClient>(client: &C) -> Result<MergeFlags, PlayerReadError> {
    let row = client
        .query_opt(
            "SELECT gain_percent::double precision AS gain_percent, cost_pct_json,
                    COALESCE(rack_hs_bonus_pct_json, '{}') AS rack_hs_bonus_pct_json,
                    enabled, enabled_machine, enabled_multiplier, enabled_infrastructure
               FROM merge_settings WHERE id = $1",
            &[&MERGE_SETTINGS_ID],
        )
        .await?;
    let Some(r) = row else {
        return Ok(MergeFlags {
            enabled: true,
            enabled_machine: true,
            enabled_multiplier: true,
            enabled_infrastructure: true,
            runtime: MergeRuntimeSettings::default(),
        });
    };
    let gain = f64_cell(&r, "gain_percent");
    let gain_percent = if gain.is_finite() && (0.0..=PERCENT_MAX).contains(&gain) {
        gain
    } else {
        DEFAULT_MERGE_GAIN_PERCENT
    };
    Ok(MergeFlags {
        enabled: flag_on(opt_i32_cell(&r, "enabled")),
        enabled_machine: flag_on(opt_i32_cell(&r, "enabled_machine")),
        enabled_multiplier: flag_on(opt_i32_cell(&r, "enabled_multiplier")),
        enabled_infrastructure: flag_on(opt_i32_cell(&r, "enabled_infrastructure")),
        runtime: MergeRuntimeSettings {
            gain_percent,
            cost_pct_by_rarity: parse_cost_pct(opt_string_cell(&r, "cost_pct_json").as_deref()),
            rack_hs_bonus_pct_by_rarity: parse_rack_bonus(
                opt_string_cell(&r, "rack_hs_bonus_pct_json").as_deref(),
            ),
        },
    })
}

fn flag_on(v: Option<i32>) -> bool {
    v.map(|n| n != 0).unwrap_or(true)
}

fn any_type_enabled(f: &MergeFlags) -> bool {
    f.enabled_machine || f.enabled_multiplier || f.enabled_infrastructure
}

pub(crate) fn type_enabled(f: &MergeFlags, t: CatalogType) -> bool {
    match t {
        CatalogType::Machine => f.enabled_machine,
        CatalogType::Multiplier => f.enabled_multiplier,
        CatalogType::Infrastructure => f.enabled_infrastructure,
    }
}

fn allowed_types(f: &MergeFlags) -> Vec<String> {
    let mut out = Vec::new();
    if f.enabled && f.enabled_machine {
        out.push(TYPE_MACHINE.to_string());
    }
    if f.enabled && f.enabled_multiplier {
        out.push(TYPE_MULTIPLIER.to_string());
    }
    if f.enabled && f.enabled_infrastructure {
        out.push(TYPE_INFRASTRUCTURE.to_string());
    }
    out
}

fn parse_cost_pct(raw: Option<&str>) -> MergeCostPct {
    let mut out = MergeCostPct::default();
    let Some(s) = raw.filter(|v| !v.trim().is_empty()) else {
        return out;
    };
    let Ok(j) = serde_json::from_str::<Value>(s) else {
        return out;
    };
    for (k, slot) in [
        ("common", &mut out.common),
        ("uncommon", &mut out.uncommon),
        ("rare", &mut out.rare),
        ("epic", &mut out.epic),
        ("legendary", &mut out.legendary),
    ] {
        if let Some(n) = j
            .get(k)
            .and_then(|v| v.as_f64())
            .filter(|n| n.is_finite() && (0.0..=PERCENT_MAX).contains(n))
        {
            *slot = (n * PERCENT_ROUND_FACTOR).round() / PERCENT_ROUND_FACTOR;
        }
    }
    out
}

fn parse_rack_bonus(raw: Option<&str>) -> RackHsBonusPct {
    let mut out = RackHsBonusPct::default();
    let Some(s) = raw.filter(|v| !v.trim().is_empty()) else {
        return out;
    };
    let Ok(j) = serde_json::from_str::<Value>(s) else {
        return out;
    };
    for (k, slot) in [
        ("common", &mut out.common),
        ("uncommon", &mut out.uncommon),
        ("rare", &mut out.rare),
        ("epic", &mut out.epic),
        ("legendary", &mut out.legendary),
        ("supreme", &mut out.supreme),
    ] {
        if let Some(n) = j
            .get(k)
            .and_then(|v| v.as_f64())
            .filter(|n| n.is_finite() && (0.0..=RACK_HS_BONUS_PCT_MAX).contains(n))
        {
            *slot = (n * PERCENT_ROUND_FACTOR).round() / PERCENT_ROUND_FACTOR;
        }
    }
    out
}

pub(crate) fn is_merge_forbidden(id: &str, is_nft: i32, category: &str, typ: &str) -> bool {
    if is_nft == IS_NFT_FLAG {
        return true;
    }
    if is_forbidden_root(id) {
        return true;
    }
    is_asic_machine_upgrade(typ, id, Some(category))
}

fn is_forbidden_root(item_id: &str) -> bool {
    let id = item_id.trim();
    if id.is_empty() {
        return false;
    }
    if MERGE_FORBIDDEN_ROOT_IDS.contains(&id) {
        return true;
    }
    if !id.starts_with(MERGE_CATALOG_PREFIX) {
        return false;
    }
    for root in MERGE_FORBIDDEN_ROOT_IDS {
        if id.starts_with(&format!("merge_{root}_"))
            || id.starts_with(&format!("merge_merge_{root}_"))
        {
            return true;
        }
        if id.contains(&format!("_{root}_")) {
            return true;
        }
    }
    false
}

fn merge_block(qty: u32, rarity: MergeRarity, has_preview: bool) -> (bool, Option<&'static str>) {
    if qty < MIN_MERGE_QTY {
        return (false, Some("Precisas de 2 unidades iguais no stock."));
    }
    if !rarity.is_mergeable_source() {
        return (false, Some("Supreme não pode ser mergeado."));
    }
    if !has_preview {
        return (false, Some("Item não mergeável."));
    }
    (true, None)
}

fn group_merge_items(items: Vec<Value>) -> Vec<Value> {
    let mut grouped: Vec<Value> = Vec::new();
    for item in items {
        if let Some(idx) = grouped.iter().position(|g| inventory_peers(g, &item)) {
            let g = &grouped[idx];
            let qty = g.get("qty").and_then(|v| v.as_i64()).unwrap_or(0)
                + item.get("qty").and_then(|v| v.as_i64()).unwrap_or(0);
            let max_merges = ((qty as u32) / MIN_MERGE_QTY).min(MERGE_MAX_COUNT);
            let preview = g
                .get("preview")
                .cloned()
                .filter(|v| !v.is_null())
                .or_else(|| item.get("preview").cloned());
            let rarity = g.get("rarity").and_then(|v| v.as_str()).unwrap_or("common");
            let can = qty as u32 >= MIN_MERGE_QTY
                && normalize_merge_rarity(rarity).is_mergeable_source()
                && preview.as_ref().is_some_and(|v| !v.is_null());
            let block = if can {
                Value::Null
            } else if (qty as u32) < MIN_MERGE_QTY {
                json!("Precisas de 2 unidades iguais no stock.")
            } else if !normalize_merge_rarity(rarity).is_mergeable_source() {
                json!("Supreme não pode ser mergeado.")
            } else {
                g.get("blockReason")
                    .cloned()
                    .filter(|v| !v.is_null())
                    .or_else(|| item.get("blockReason").cloned())
                    .unwrap_or_else(|| json!("Item não mergeável."))
            };
            let keep_id = g.get("qty").and_then(|v| v.as_i64()).unwrap_or(0)
                >= item.get("qty").and_then(|v| v.as_i64()).unwrap_or(0);
            let item_id = if keep_id {
                g.get("itemId").cloned()
            } else {
                item.get("itemId").cloned()
            };
            if let Some(Value::Object(ref mut m)) = grouped.get_mut(idx) {
                if let Some(id) = item_id {
                    m.insert("itemId".into(), id);
                }
                m.insert("qty".into(), json!(qty));
                m.insert("maxMerges".into(), json!(max_merges));
                m.insert("canMerge".into(), json!(can));
                m.insert("blockReason".into(), block);
                if let Some(p) = preview {
                    m.insert("preview".into(), p);
                }
            }
        } else {
            grouped.push(item);
        }
    }
    grouped
}

fn inventory_peers(a: &Value, b: &Value) -> bool {
    a.get("type") == b.get("type")
        && a.get("rarity") == b.get("rarity")
        && a.get("name") == b.get("name")
        && a.get("baseCost") == b.get("baseCost")
        && a.get("baseProduction") == b.get("baseProduction")
        && a.get("powerConsumption") == b.get("powerConsumption")
        && a.get("multiplier") == b.get("multiplier")
}

fn clamp_history_limit(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n >= 1 => n.min(HISTORY_LIMIT_MAX),
        _ => HISTORY_LIMIT_DEFAULT,
    }
}

fn round_fee(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * PERCENT_ROUND_FACTOR).round() / PERCENT_ROUND_FACTOR
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_limit_clamps() {
        assert_eq!(clamp_history_limit(None), HISTORY_LIMIT_DEFAULT);
        assert_eq!(clamp_history_limit(Some(0)), HISTORY_LIMIT_DEFAULT);
        assert_eq!(
            clamp_history_limit(Some(HISTORY_LIMIT_MAX + 1)),
            HISTORY_LIMIT_MAX
        );
        assert_eq!(clamp_history_limit(Some(10)), 10);
    }

    #[test]
    fn forbidden_roots() {
        assert!(is_forbidden_root("dolar_f2p"));
        assert!(is_forbidden_root("merge_dolar_f2p_x"));
        assert!(!is_forbidden_root("gpu_1"));
    }
}
