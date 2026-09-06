//! Merge execute — full resolution in Rust (Node `server/modules/merge/services/merge.ts`
//! `executeMerge`). Client sends only `{ itemId, count }`; this loads the source
//! catalog, validates, computes result stats, plans FIFO stock consumption,
//! resolves-or-creates the result upgrade, then applies USDC fee + stock adjust +
//! `merge_history` in one transaction ([`super::execute::execute_on_tx`]).
//!
//! Not carried over from Node (best-effort `void` there): `recordInventoryMovement`
//! audit rows. `bumpQuestProgress('merge', count)` IS ported — see
//! [`bump_merge_quests`], run best-effort after the merge tx commits.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::nft::is_asic_machine_upgrade;
use genesis_core::{
    compute_merge_result_stats, merge_source_catalogs_equivalent, normalize_merge_rarity,
    stats_match_existing, utc_checkin_period_start_ms, utc_day_from_ms, utc_week_start_ms,
    CatalogType, MergeCatalogStats, MergeRarity, MergeResultStats, MergeSourceCatalog,
};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tracing::warn;

use crate::market::errors::MarketError;
use crate::player_reads::merge::{is_merge_forbidden, load_merge_flags, type_enabled};
use crate::player_reads::{
    f64_cell, i32_cell, opt_f64_cell, opt_i32_cell, opt_string_cell, string_cell,
};

use super::execute::{
    execute_on_tx, round_fee_total, set_merge_tx_timeouts, MergeError, MergeExecuteInput, MergeLine,
};

/// Node `MIN_MERGE_QTY`.
const MIN_MERGE_QTY: i64 = 2;
/// Node `MERGE_MAX_COUNT`.
const MERGE_MAX_COUNT: i32 = 50;
const DEFAULT_ICON: &str = "📦";
const UPGRADES_CATALOG_META_ID: i32 = 1;
/// Node `RESULT_ID_HASH_LENGTH` / `RESULT_ID_SOURCE_MAX_LENGTH` / `RESULT_ID_MAX_LENGTH`.
const RESULT_ID_HASH_LENGTH: usize = 10;
const RESULT_ID_SOURCE_MAX_LENGTH: usize = 48;
const RESULT_ID_MAX_LENGTH: usize = 120;
/// `Math.round(multiplier * 10000) / 100` for the infra description.
const HS_PERCENT_ROUND: f64 = 10_000.0;
const HS_PERCENT_DISPLAY_ROUND: f64 = 100.0;

fn market_to_merge(e: MarketError) -> MergeError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => MergeError::Domain {
            status,
            error,
            code,
        },
        MarketError::Transport(err) => MergeError::Transport(err),
    }
}

/// JS `String(n)` for the id hash — integral floats print without a decimal.
fn js_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn opt_js_num(n: Option<f64>) -> String {
    n.map(js_num).unwrap_or_default()
}

fn opt_js_int(n: Option<i32>) -> String {
    n.map(|v| v.to_string()).unwrap_or_default()
}

/// Node `makeResultCatalogId`.
fn make_result_catalog_id(source_id: &str, result_rarity: &str, stats: &MergeResultStats) -> String {
    let payload = [
        source_id.to_string(),
        result_rarity.to_string(),
        js_num(stats.base_cost),
        js_num(stats.base_production),
        opt_js_num(stats.power_consumption),
        opt_js_num(stats.multiplier),
        opt_js_int(stats.slots_capacity),
        opt_js_int(stats.ai_slots_capacity),
    ]
    .join("|");
    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    let hex = hex::encode(hasher.finalize());
    let h: String = hex.chars().take(RESULT_ID_HASH_LENGTH).collect();
    let safe_src: String = source_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(RESULT_ID_SOURCE_MAX_LENGTH)
        .collect();
    let id = format!("merge_{safe_src}_{result_rarity}_{h}");
    id.chars().take(RESULT_ID_MAX_LENGTH).collect()
}

fn source_catalog_from_row(r: &tokio_postgres::Row) -> Option<(MergeSourceCatalog, i32)> {
    let catalog_type = CatalogType::parse(&string_cell(r, "type"))?;
    Some((
        MergeSourceCatalog {
            id: string_cell(r, "item_id"),
            name: string_cell(r, "name"),
            category: string_cell(r, "category"),
            catalog_type,
            rarity: normalize_merge_rarity(&string_cell(r, "rarity")),
            base_cost: f64_cell(r, "base_cost"),
            base_production: f64_cell(r, "base_production"),
            power_consumption: opt_f64_cell(r, "power_consumption"),
            multiplier: opt_f64_cell(r, "multiplier"),
            slots_capacity: opt_i32_cell(r, "slots_capacity"),
            ai_slots_capacity: opt_i32_cell(r, "ai_slots_capacity"),
        },
        i32_cell(r, "is_nft"),
    ))
}

async fn copy_upgrade_compat<C: GenericClient>(
    client: &C,
    result_id: &str,
    source_id: &str,
) -> Result<(), MergeError> {
    client
        .execute(
            "INSERT INTO upgrade_compat_racks (upgrade_id, rack_id)
             SELECT $1, c.rack_id FROM upgrade_compat_racks c WHERE c.upgrade_id = $2
             ON CONFLICT DO NOTHING",
            &[&result_id, &source_id],
        )
        .await
        .map_err(MergeError::transport)?;
    Ok(())
}

/// Node `resolveOrCreateResultUpgrade` — reuse a matching existing result row,
/// else insert a deterministic new one and bump the catalog revision.
async fn resolve_or_create_result_upgrade<C: GenericClient>(
    client: &C,
    source: &SourceCatalog,
    stats: &MergeResultStats,
) -> Result<String, MergeError> {
    let ct = source.catalog.catalog_type;
    let existing = client
        .query(
            "SELECT id, base_cost::double precision AS base_cost,
                    base_production::double precision AS base_production,
                    power_consumption::double precision AS power_consumption,
                    multiplier::double precision AS multiplier,
                    slots_capacity, ai_slots_capacity
               FROM upgrades
              WHERE type = $1 AND COALESCE(rarity, 'common') = $2 AND name = $3",
            &[
                &type_str(ct),
                &stats.result_rarity.as_str(),
                &stats.name,
            ],
        )
        .await
        .map_err(MergeError::transport)?;
    for row in &existing {
        let row_stats = MergeCatalogStats {
            base_cost: f64_cell(row, "base_cost"),
            base_production: f64_cell(row, "base_production"),
            power_consumption: opt_f64_cell(row, "power_consumption"),
            multiplier: opt_f64_cell(row, "multiplier"),
            slots_capacity: opt_i32_cell(row, "slots_capacity"),
            ai_slots_capacity: opt_i32_cell(row, "ai_slots_capacity"),
        };
        if stats_match_existing(&row_stats, stats, ct) {
            let id = string_cell(row, "id");
            copy_upgrade_compat(client, &id, &source.catalog.id).await?;
            return Ok(id);
        }
    }

    let id = make_result_catalog_id(
        &source.catalog.id,
        stats.result_rarity.as_str(),
        stats,
    );
    let dup = client
        .query_opt("SELECT id FROM upgrades WHERE id = $1", &[&id])
        .await
        .map_err(MergeError::transport)?;
    if let Some(row) = dup {
        let existing_id = string_cell(&row, "id");
        copy_upgrade_compat(client, &existing_id, &source.catalog.id).await?;
        return Ok(existing_id);
    }

    let category = if source.catalog.category.trim().is_empty() {
        match ct {
            CatalogType::Multiplier => "chip_ia",
            CatalogType::Infrastructure => "rig",
            CatalogType::Machine => "gpu",
        }
        .to_string()
    } else {
        source.catalog.category.clone()
    };
    let description = if matches!(ct, CatalogType::Infrastructure) {
        let pct = (stats.multiplier.unwrap_or(0.0) * HS_PERCENT_ROUND).round() / HS_PERCENT_DISPLAY_ROUND;
        format!(
            "Resultado de merge ({}): +{}% H/s.",
            stats.result_rarity.as_str(),
            js_num(pct)
        )
    } else {
        format!(
            "Resultado de merge ({}, +{}%).",
            stats.result_rarity.as_str(),
            js_num(stats.gain_percent)
        )
    };
    let icon = if source.icon.trim().is_empty() {
        DEFAULT_ICON.to_string()
    } else {
        source.icon.clone()
    };
    let status = if source.status.trim().is_empty() {
        "normal".to_string()
    } else {
        source.status.clone()
    };

    // Lock the singleton revision row before the INSERT (Node order).
    client
        .execute(
            "INSERT INTO upgrades_catalog_meta (id, revision) VALUES ($1, 0)
             ON CONFLICT (id) DO NOTHING",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await
        .map_err(MergeError::transport)?;
    client
        .execute(
            "SELECT revision FROM upgrades_catalog_meta WHERE id = $1 FOR UPDATE",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await
        .map_err(MergeError::transport)?;

    let inserted = client
        .execute(
            "INSERT INTO upgrades (
               id, name, category, type, base_cost, base_production, power_consumption, power_capacity,
               multiplier, slots_capacity, ai_slots_capacity, description, icon, status, is_nft,
               image, reward_wh, sell_in_hardware_market, sell_in_black_market, is_active, rarity
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,0,$14,0,0,0,1,$15
             )
             ON CONFLICT (id) DO NOTHING",
            &[
                &id,
                &stats.name,
                &category,
                &type_str(ct),
                &stats.base_cost,
                &stats.base_production,
                &stats.power_consumption,
                &stats.multiplier,
                &stats.slots_capacity,
                &stats.ai_slots_capacity,
                &description,
                &icon,
                &status,
                &source.image,
                &stats.result_rarity.as_str(),
            ],
        )
        .await
        .map_err(MergeError::transport)?;
    if inserted > 0 {
        client
            .execute(
                "UPDATE upgrades_catalog_meta SET revision = revision + 1 WHERE id = $1",
                &[&UPGRADES_CATALOG_META_ID],
            )
            .await
            .map_err(MergeError::transport)?;
    }
    copy_upgrade_compat(client, &id, &source.catalog.id).await?;
    Ok(id)
}

fn type_str(t: CatalogType) -> &'static str {
    match t {
        CatalogType::Machine => "machine",
        CatalogType::Multiplier => "multiplier",
        CatalogType::Infrastructure => "infrastructure",
    }
}

struct SourceCatalog {
    catalog: MergeSourceCatalog,
    icon: String,
    image: Option<String>,
    status: String,
}

const SOURCE_SELECT: &str = "SELECT id AS item_id, name, category, type,
        COALESCE(rarity, 'common') AS rarity,
        base_cost::double precision AS base_cost,
        base_production::double precision AS base_production,
        power_consumption::double precision AS power_consumption,
        multiplier::double precision AS multiplier,
        slots_capacity, ai_slots_capacity,
        icon, image, status, COALESCE(is_nft, 0) AS is_nft
   FROM upgrades WHERE id = $1 FOR SHARE";

const LOTS_SELECT: &str = "SELECT s.item_id, s.qty, u.type, u.category, u.name,
        COALESCE(u.rarity, 'common') AS rarity,
        u.base_cost::double precision AS base_cost,
        u.base_production::double precision AS base_production,
        u.power_consumption::double precision AS power_consumption,
        u.multiplier::double precision AS multiplier,
        u.slots_capacity, u.ai_slots_capacity,
        COALESCE(u.is_nft, 0) AS is_nft
   FROM stock s
   INNER JOIN upgrades u ON u.id = s.item_id
  WHERE s.user_id = $1 AND s.qty > 0
    AND u.type = $2 AND COALESCE(u.rarity, 'common') = $3 AND u.name = $4
  ORDER BY s.item_id ASC
  FOR UPDATE";

/// Full merge — validation + resolve + apply, all in one transaction.
pub async fn run_merge(
    pool: &Pool,
    user_id: i64,
    item_id: &str,
    count_in: i32,
) -> Result<Value, MergeError> {
    if user_id <= 0 {
        return Err(MergeError::bad("BAD_USER", "Invalid session."));
    }
    let item_id = item_id.trim().to_string();
    if item_id.is_empty() {
        return Err(MergeError::bad("BAD_ITEM", "Invalid item."));
    }
    let count = count_in.clamp(1, MERGE_MAX_COUNT);
    let need_qty = i64::from(count) * MIN_MERGE_QTY;

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MergeError::transport)?;
    set_merge_tx_timeouts(&tx).await?;

    let result = run_merge_on_tx(&tx, user_id, &item_id, count, need_qty).await;
    match result {
        Ok(v) => {
            tx.commit().await.map_err(MergeError::transport)?;
            // Node `bumpQuestProgress(userId, 'merge', count)` — best-effort, own tx.
            bump_merge_quests(pool, user_id, count).await;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

/// Advance every enabled `action_type = 'merge'` quest (daily + weekly) by `count`,
/// capped at `target_count`. Best-effort: a failure here never fails the merge
/// (mirrors Node's `void bumpQuestProgress(...)`).
async fn bump_merge_quests(pool: &Pool, user_id: i64, count: i32) {
    if let Err(e) = try_bump_merge_quests(pool, user_id, count).await {
        warn!(err = %e, user_id, "merge quest bump (non-fatal)");
    }
}

async fn try_bump_merge_quests(pool: &Pool, user_id: i64, count: i32) -> anyhow::Result<()> {
    let delta = count.max(0);
    if delta == 0 {
        return Ok(());
    }
    let uid = crate::pg_types::pg_user_id(user_id)?;
    let now_ms = crate::config::current_unix_ms();
    let daily_key = format!("d:{}", utc_day_from_ms(utc_checkin_period_start_ms(now_ms)));
    let weekly_key = format!(
        "w:{}",
        utc_day_from_ms(utc_week_start_ms(now_ms))
            .chars()
            .take(10)
            .collect::<String>()
    );

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let defs = tx
        .query(
            "SELECT id, period, target_count FROM quest_definitions
              WHERE action_type = 'merge' AND COALESCE(enabled, 1) <> 0",
            &[],
        )
        .await?;
    for d in &defs {
        let qid: String = d.get("id");
        let period: String = d.get("period");
        let target: i32 = d.get("target_count");
        let pk = if period == "weekly" {
            &weekly_key
        } else {
            &daily_key
        };
        tx.execute(
            "INSERT INTO user_quest_progress
                (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
             VALUES ($1, $2, $3, 0, NULL, NULL, $4)
             ON CONFLICT (user_id, quest_id, period_key) DO NOTHING",
            &[&uid, &qid, pk, &now_ms],
        )
        .await?;
        let row = tx
            .query_opt(
                "SELECT progress, completed_at, claimed_at FROM user_quest_progress
                  WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE",
                &[&uid, &qid, pk],
            )
            .await?;
        let Some(row) = row else { continue };
        if row.get::<_, Option<i64>>("claimed_at").is_some() {
            continue;
        }
        let cur: i32 = row.get::<_, Option<i32>>("progress").unwrap_or(0).max(0);
        let next = (cur + delta).min(target);
        let completed_at: Option<i64> = if next >= target {
            Some(row.get::<_, Option<i64>>("completed_at").unwrap_or(now_ms))
        } else {
            None
        };
        tx.execute(
            "UPDATE user_quest_progress SET progress = $4, completed_at = $5, updated_at = $6
              WHERE user_id = $1 AND quest_id = $2 AND period_key = $3",
            &[&uid, &qid, pk, &next, &completed_at, &now_ms],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn run_merge_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    count: i32,
    need_qty: i64,
) -> Result<Value, MergeError> {
    crate::market::assert_active_user(client, user_id)
        .await
        .map_err(market_to_merge)?;

    let flags = load_merge_flags(client)
        .await
        .map_err(|e| MergeError::Domain {
            status: e.http_status,
            error: e.error,
            code: e.code,
        })?;
    if !flags.enabled {
        return Err(MergeError::Domain {
            status: 403,
            error: "Merge Station is disabled.".into(),
            code: Some("MERGE_DISABLED".into()),
        });
    }

    let src_row = client
        .query_opt(SOURCE_SELECT, &[&item_id])
        .await
        .map_err(MergeError::transport)?
        .ok_or_else(|| MergeError::not_found("NOT_FOUND", "Catalog item not found."))?;

    let (catalog, is_nft) = source_catalog_from_row(&src_row)
        .ok_or_else(|| MergeError::bad("BAD_TYPE", "Only GPUs, AI Chips, and Rigs can be merged."))?;
    let ct = catalog.catalog_type;

    if !type_enabled(&flags, ct) {
        return Err(MergeError::Domain {
            status: 403,
            error: "This merge type is disabled.".into(),
            code: Some("MERGE_TYPE_DISABLED".into()),
        });
    }
    if is_merge_forbidden(&catalog.id, is_nft, &catalog.category, type_str(ct)) {
        return Err(MergeError::Domain {
            status: 403,
            error: "This item (NFT / Free-to-Play / special) cannot be merged.".into(),
            code: Some("ITEM_FORBIDDEN".into()),
        });
    }
    if is_asic_machine_upgrade(type_str(ct), &catalog.id, Some(catalog.category.as_str())) {
        return Err(MergeError::bad("ASIC_FORBIDDEN", "ASICs cannot be merged."));
    }
    let rarity = catalog.rarity;
    if !rarity.is_mergeable_source() {
        return Err(MergeError::bad("SUPREME", "Supreme items cannot be merged."));
    }

    let stats = compute_merge_result_stats(&catalog, &flags.runtime)
        .ok_or_else(|| MergeError::bad("BAD_STATS", "Could not calculate the result."))?;
    let fee_unit = stats.fee_usdc;
    let fee_total = round_fee_total(fee_unit, count);

    let source = SourceCatalog {
        icon: opt_string_cell(&src_row, "icon").unwrap_or_default(),
        image: opt_string_cell(&src_row, "image"),
        status: opt_string_cell(&src_row, "status").unwrap_or_default(),
        catalog,
    };

    // FIFO stock lots across equivalent SKUs (Node `listEquivalentMergeStockLots`).
    let lot_rows = client
        .query(
            LOTS_SELECT,
            &[
                &user_id_as_i32(user_id)?,
                &type_str(ct),
                &rarity.as_str(),
                &source.catalog.name,
            ],
        )
        .await
        .map_err(MergeError::transport)?;
    let mut lots: Vec<(String, i64)> = Vec::new();
    for r in &lot_rows {
        let lot_id = string_cell(r, "item_id");
        let lot_category = string_cell(r, "category");
        let lot_nft = i32_cell(r, "is_nft");
        if is_merge_forbidden(&lot_id, lot_nft, &lot_category, type_str(ct)) {
            continue;
        }
        if is_asic_machine_upgrade(type_str(ct), &lot_id, Some(lot_category.as_str())) {
            continue;
        }
        let Some((peer, _)) = source_catalog_from_row(r) else {
            continue;
        };
        if !merge_source_catalogs_equivalent(&source.catalog, &peer) {
            continue;
        }
        let qty = i64::from(i32_cell(r, "qty")).max(0);
        if qty > 0 {
            lots.push((lot_id, qty));
        }
    }

    let qty_before: i64 = lots.iter().map(|(_, q)| *q).sum();
    if qty_before < need_qty {
        let max_ok = qty_before / MIN_MERGE_QTY;
        let msg = if max_ok > 0 {
            format!(
                "Insufficient stock for {count} merge(s). Maximum now: {max_ok}."
            )
        } else {
            "You need at least 2 identical units in stock.".to_string()
        };
        return Err(MergeError::unprocessable("INSUFFICIENT_STOCK", msg));
    }

    // FIFO debit plan.
    let mut remaining = need_qty;
    let mut debit: Vec<MergeLine> = Vec::new();
    for (lot_id, lot_qty) in &lots {
        if remaining <= 0 {
            break;
        }
        let take = (*lot_qty).min(remaining);
        if take <= 0 {
            continue;
        }
        remaining -= take;
        debit.push(MergeLine {
            item_id: lot_id.clone(),
            qty: take,
        });
    }

    // Resolve (or create) the result upgrade id in this same transaction.
    let result_id = resolve_or_create_result_upgrade(client, &source, &stats).await?;

    let input = MergeExecuteInput {
        user_id,
        source_item_id: source.catalog.id.clone(),
        result_item_id: result_id.clone(),
        source_rarity: rarity.as_str().to_string(),
        result_rarity: stats.result_rarity.as_str().to_string(),
        fee_unit_usdc: fee_unit,
        count,
        debit,
        credit: vec![MergeLine {
            item_id: result_id.clone(),
            qty: i64::from(count),
        }],
        history_timestamps: None,
    };
    let outcome = execute_on_tx(client, &input).await?;

    Ok(json!({
        "ok": true,
        "sourceItemId": source.catalog.id,
        "resultItemId": result_id,
        "sourceRarity": rarity.as_str(),
        "resultRarity": stats.result_rarity.as_str(),
        "feeUsdc": fee_total,
        "feeUnitUsdc": fee_unit,
        "count": count,
        "newUsdc": outcome.new_usdc,
        "resultQty": outcome.result_qty,
        "sourceQty": (qty_before - need_qty).max(0),
        "result": {
            "id": result_id,
            "name": stats.name,
            "resultRarity": stats.result_rarity.as_str(),
            "baseCost": stats.base_cost,
            "baseProduction": stats.base_production,
            "powerConsumption": stats.power_consumption,
            "multiplier": stats.multiplier,
            "slotsCapacity": stats.slots_capacity,
            "aiSlotsCapacity": stats.ai_slots_capacity,
            "feeUsdc": stats.fee_usdc,
            "costPct": stats.cost_pct,
            "gainPercent": stats.gain_percent,
        },
    }))
}

fn user_id_as_i32(user_id: i64) -> Result<i32, MergeError> {
    crate::pg_types::pg_user_id(user_id).map_err(MergeError::transport)
}

#[allow(dead_code)]
fn _rarity_kind(r: MergeRarity) -> &'static str {
    r.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_num_matches_string_coercion() {
        assert_eq!(js_num(20.0), "20");
        assert_eq!(js_num(246.75), "246.75");
        assert_eq!(opt_js_num(None), "");
        assert_eq!(opt_js_int(Some(4)), "4");
    }

    #[test]
    fn result_id_shape() {
        let stats = MergeResultStats {
            result_rarity: MergeRarity::Uncommon,
            name: "Merged GPU X".into(),
            base_cost: 210.0,
            base_production: 21.0,
            power_consumption: Some(380.0),
            multiplier: None,
            slots_capacity: None,
            ai_slots_capacity: None,
            fee_usdc: 20.0,
            cost_pct: 10.0,
            gain_percent: 5.0,
        };
        let id = make_result_catalog_id("gpu_1", "uncommon", &stats);
        assert!(id.starts_with("merge_gpu_1_uncommon_"));
        assert!(id.len() <= RESULT_ID_MAX_LENGTH);
    }
}
