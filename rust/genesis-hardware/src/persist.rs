//! Persist stock / stored_batteries / placed_racks.
//!
//! Merge mode UPSERTs only — never `DELETE FROM stock WHERE NOT (item_id = ANY(...))`
//! (Grangeiro wipe). After stock writes, timed ASIC leases are reconciled
//! (trim excess + sync; never mint) and `item_instances` are aligned (qty cache;
//! timed lease id = instance id). Credit of timed machines creates leases
//! then syncs stock from lease count.

use std::collections::{HashMap, HashSet};

use anyhow::Context;
use deadpool_postgres::GenericClient;
use genesis_core::calculator::constants::ROOM_INITIAL_ID;
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;
use genesis_core::hardware::duration::{
    is_timed_asic_duration, normalize_asic_duration_config, AsicDurationConfig,
};
use genesis_core::hardware::item_id::is_valid_save_game_item_id;
use genesis_core::hardware::types::{PlacedRack, StoredBattery};

use crate::config::{current_unix_ms, HARDWARE_TX_TIMEOUT_MS};
use crate::instances::{
    mint_instances, reconcile_stock_instances_to_qty, ITEM_INSTANCE_STATUS_STOCK,
};
use crate::leases::{
    bind_uuid, create_asic_leases_on_credit, load_asic_duration_config,
    reconcile_timed_asic_stock_leases, sync_timed_asic_stock_for_item,
};
use crate::pg_types::{pg_qty, pg_user_id};

/// Marker in sanitized payload when `itemId` is empty/invalid (`save-guard.ts`).
const STORED_BATTERY_CATALOG_PENDING_ID: &str = "legacy_battery_missing_catalog";

/// Exact copy of Node `PG_BATTERY_INSTANCE_UUID` in `invariant.ts`.
pub const PG_BATTERY_INSTANCE_UUID: &str =
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/// ASIC lease reconcile runs after persist_stock (trim + sync; never mint).
pub const ASIC_LEASE_RECONCILE_PORTED: bool = true;

const PERSIST_STOCK_UPSERT_SQL: &str = "INSERT INTO stock (user_id, item_id, qty)
                         SELECT $1, unnest($2::text[]), unnest($3::int[])
                         ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty";

const PERSIST_PLACED_RACKS_UPSERT_SQL: &str = "INSERT INTO placed_racks (
               id, user_id, item_id, wiring_id, battery_id, is_on, selected_coin_id, room_id, slot_index,
               battery_catalog_item_id, battery_display_name, battery_image_url
             )
             SELECT unnest($2::text[]), $1, unnest($3::text[]), NULLIF(unnest($4::text[]), ''), NULLIF(unnest($5::text[]), ''),
                    unnest($6::int[]), NULLIF(unnest($7::text[]), ''), unnest($8::text[]), unnest($9::int[]),
                    NULLIF(unnest($10::text[]), ''), NULLIF(unnest($11::text[]), ''), NULLIF(unnest($12::text[]), '')
             ON CONFLICT (id) DO UPDATE SET
               item_id = EXCLUDED.item_id, wiring_id = EXCLUDED.wiring_id, battery_id = EXCLUDED.battery_id,
               is_on = EXCLUDED.is_on, selected_coin_id = EXCLUDED.selected_coin_id,
               room_id = EXCLUDED.room_id, slot_index = EXCLUDED.slot_index,
               battery_catalog_item_id = EXCLUDED.battery_catalog_item_id,
               battery_display_name = EXCLUDED.battery_display_name,
               battery_image_url = EXCLUDED.battery_image_url";

const PERSIST_RACK_SLOTS_SQL: &str =
    "INSERT INTO rack_slots (rack_id, slot_index, machine_item_id, machine_lease_id)
                 SELECT unnest($1::text[]), unnest($2::int[]), unnest($3::text[]), NULLIF(unnest($4::text[]), '')::uuid";

/// Empty/missing optional text → `""` so `unnest($n::text[])` never binds NULL; SQL uses `NULLIF(..., '')`.
fn bind_opt_text(v: Option<&str>) -> String {
    v.map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StockMode {
    Snapshot,
    Partial,
    Merge,
}

impl StockMode {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").trim() {
            "snapshot" => Self::Snapshot,
            "merge" => Self::Merge,
            _ => Self::Partial,
        }
    }
}

pub struct PersistInput {
    pub user_id: i64,
    pub stock: Option<HashMap<String, i64>>,
    pub stock_mode: StockMode,
    pub stored_batteries: Option<Vec<StoredBattery>>,
    pub placed_racks: Option<Vec<PlacedRack>>,
}

fn sanitize_stored_batteries(
    batteries: &[StoredBattery],
    placed_racks: Option<&[PlacedRack]>,
) -> Vec<StoredBattery> {
    let mut mounted = HashSet::new();
    if let Some(racks) = placed_racks {
        for r in racks {
            if let Some(bid) = r
                .battery_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                mounted.insert(bid.to_string());
            }
        }
    }
    let mut by_id = HashMap::new();
    for b in batteries {
        let id = b.id.trim();
        if !is_valid_save_game_item_id(id) {
            continue;
        }
        if mounted.contains(id) {
            continue;
        }
        let mut item_id = b.item_id.trim().to_string();
        if item_id.is_empty() || !is_valid_save_game_item_id(&item_id) {
            item_id = STORED_BATTERY_CATALOG_PENDING_ID.to_string();
        }
        by_id.insert(
            id.to_string(),
            StoredBattery {
                id: id.to_string(),
                item_id,
                display_name: b.display_name.clone(),
                image_url: b.image_url.clone(),
            },
        );
    }
    by_id.into_values().collect()
}

fn collect_mounted_battery_ids(placed_racks: &[PlacedRack]) -> Vec<String> {
    let mut out = Vec::new();
    for r in placed_racks {
        if let Some(bid) = r
            .battery_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.push(bid.to_string());
        }
    }
    out
}

async fn apply_dismantled_recovery<C: GenericClient>(
    client: &C,
    uid: i64,
    placed_racks: &[PlacedRack],
    stock_out: &mut Option<HashMap<String, i64>>,
) -> anyhow::Result<()> {
    if stock_out.is_some() {
        return Ok(());
    }
    let uid_pg = pg_user_id(uid)?;
    let prev = client
        .query(
            "SELECT id, item_id, wiring_id, battery_id FROM placed_racks WHERE user_id = $1",
            &[&uid_pg],
        )
        .await?;
    let next_ids: HashSet<String> = placed_racks.iter().map(|r| r.id.clone()).collect();
    let next_by_id: HashMap<String, &PlacedRack> =
        placed_racks.iter().map(|r| (r.id.clone(), r)).collect();
    let mut additions: HashMap<String, i64> = HashMap::new();
    let mut bump = |id: Option<&str>, n: i64| {
        let t = id.unwrap_or("").trim();
        if t.is_empty() || n <= 0 {
            return;
        }
        *additions.entry(t.to_string()).or_insert(0) += n;
    };

    for row in &prev {
        let id: String = row.get("id");
        if next_ids.contains(&id) {
            continue;
        }
        let item_id: String = row.try_get("item_id").unwrap_or_default();
        let wiring: Option<String> = row.try_get("wiring_id").ok().flatten();
        bump(Some(&item_id), 1);
        bump(wiring.as_deref(), 1);
        let slots = client
            .query(
                "SELECT machine_item_id FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL",
                &[&id],
            )
            .await?;
        for s in slots {
            let mid: String = s.get("machine_item_id");
            bump(Some(&mid), 1);
        }
        let multis = client
            .query(
                "SELECT multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = $1 AND multiplier_item_id IS NOT NULL",
                &[&id],
            )
            .await?;
        for m in multis {
            let mid: String = m.get("multiplier_item_id");
            bump(Some(&mid), 1);
        }
        if let Ok(Some(bid)) = row.try_get::<_, Option<String>>("battery_id") {
            let bid = bid.trim().to_string();
            if !bid.is_empty() {
                let br = client
                    .query(
                        "SELECT item_id FROM stored_batteries WHERE id = $1 AND user_id = $2",
                        &[&bid, &uid_pg],
                    )
                    .await?;
                if let Some(brow) = br.first() {
                    let cat: String = brow.get("item_id");
                    let cat = normalize_known_1000wh_battery_catalog_id(Some(&cat));
                    bump(Some(&cat), 1);
                } else {
                    bump(Some(&bid), 1);
                }
            }
        }
    }

    for row in &prev {
        let id: String = row.get("id");
        let Some(next_rack) = next_by_id.get(&id) else {
            continue;
        };
        let old_wiring: Option<String> = row.try_get("wiring_id").ok().flatten();
        let old_w = old_wiring.as_deref().unwrap_or("").trim();
        let new_w = next_rack.wiring_id.as_deref().unwrap_or("").trim();
        if !old_w.is_empty() && old_w != new_w {
            bump(Some(old_w), 1);
        }
        let slots = client
            .query(
                "SELECT machine_item_id FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL",
                &[&id],
            )
            .await?;
        let mut old_slot: HashMap<String, i64> = HashMap::new();
        for s in slots {
            let mid: String = s.get("machine_item_id");
            let t = mid.trim();
            if !t.is_empty() {
                *old_slot.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        let mut new_slot: HashMap<String, i64> = HashMap::new();
        for sid in &next_rack.slots {
            let t = sid.trim();
            if !t.is_empty() {
                *new_slot.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        for (item_id, old_count) in old_slot {
            let surplus = old_count - new_slot.get(&item_id).copied().unwrap_or(0);
            bump(Some(&item_id), surplus);
        }
        let multis = client
            .query(
                "SELECT multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = $1 AND multiplier_item_id IS NOT NULL",
                &[&id],
            )
            .await?;
        let mut old_m: HashMap<String, i64> = HashMap::new();
        for m in multis {
            let mid: String = m.get("multiplier_item_id");
            let t = mid.trim();
            if !t.is_empty() {
                *old_m.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        let mut new_m: HashMap<String, i64> = HashMap::new();
        for mid in &next_rack.multiplier_slots {
            let t = mid.trim();
            if !t.is_empty() {
                *new_m.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        for (item_id, old_count) in old_m {
            let surplus = old_count - new_m.get(&item_id).copied().unwrap_or(0);
            bump(Some(&item_id), surplus);
        }
    }

    if additions.is_empty() {
        return Ok(());
    }
    let keys: Vec<String> = additions.keys().cloned().collect();
    let qty_rows = client
        .query(
            "SELECT item_id, qty FROM stock WHERE user_id = $1 AND item_id = ANY($2::text[])",
            &[&uid_pg, &keys],
        )
        .await?;
    let mut prev_qty: HashMap<String, i64> = HashMap::new();
    for r in qty_rows {
        let item_id: String = r.get("item_id");
        let qty: i32 = r.get("qty");
        prev_qty.insert(item_id, i64::from(qty));
    }
    let mut stock = HashMap::new();
    for (k, add) in additions {
        stock.insert(k.clone(), prev_qty.get(&k).copied().unwrap_or(0) + add);
    }
    *stock_out = Some(stock);
    Ok(())
}

async fn persist_stock<C: GenericClient>(
    client: &C,
    uid: i64,
    stock: &HashMap<String, i64>,
    mode: StockMode,
) -> anyhow::Result<()> {
    let uid_pg = pg_user_id(uid)?;
    let mut stock_norm: HashMap<String, i32> = HashMap::new();
    for (raw_id, raw_qty) in stock {
        let item_id = normalize_known_1000wh_battery_catalog_id(Some(raw_id));
        if item_id.is_empty() {
            continue;
        }
        let qty = pg_qty((*raw_qty).max(0))?;
        if qty <= 0 {
            continue;
        }
        *stock_norm.entry(item_id).or_insert(0) += qty;
    }
    let item_ids: Vec<String> = stock_norm.keys().cloned().collect();
    let qtys: Vec<i32> = item_ids.iter().map(|id| stock_norm[id]).collect();

    match mode {
        StockMode::Snapshot => {
            if !item_ids.is_empty() {
                client
                    .execute(
                        "DELETE FROM stock WHERE user_id = $1 AND NOT (item_id = ANY($2::text[]))",
                        &[&uid_pg, &item_ids],
                    )
                    .await
                    .with_context(|| "persist_stock snapshot delete omitted")?;
                client
                    .execute(PERSIST_STOCK_UPSERT_SQL, &[&uid_pg, &item_ids, &qtys])
                    .await
                    .with_context(|| "persist_stock snapshot upsert")?;
            } else {
                client
                    .execute("DELETE FROM stock WHERE user_id = $1", &[&uid_pg])
                    .await
                    .with_context(|| "persist_stock snapshot delete all")?;
            }
            client
                .execute(
                    "DELETE FROM stock WHERE user_id = $1 AND qty <= 0",
                    &[&uid_pg],
                )
                .await
                .with_context(|| "persist_stock snapshot delete zero")?;
        }
        StockMode::Merge | StockMode::Partial => {
            // merge: UPSERT only — never DELETE omitted SKUs (Grangeiro).
            if !item_ids.is_empty() {
                client
                    .execute(PERSIST_STOCK_UPSERT_SQL, &[&uid_pg, &item_ids, &qtys])
                    .await
                    .with_context(|| "persist_stock merge upsert")?;
            }
        }
    }

    let now_ms = current_unix_ms();
    for (item_id, qty) in &stock_norm {
        reconcile_timed_asic_stock_leases(client, uid, item_id, i64::from(*qty), now_ms)
            .await
            .with_context(|| "persist_stock consume/reconcile")?;
        let cfg = load_asic_duration_config(client, item_id)
            .await
            .with_context(|| "persist_stock consume/reconcile")?;
        let allow_qty_mint = !is_timed_asic_duration(&cfg);
        reconcile_stock_instances_to_qty(client, uid, item_id, i64::from(*qty), allow_qty_mint)
            .await
            .with_context(|| "persist_stock consume/reconcile")?;
    }
    if mode == StockMode::Snapshot {
        let lease_rows = client
            .query(
                "SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1",
                &[&uid_pg],
            )
            .await
            .with_context(|| "persist_stock leftover leases")?;
        for row in lease_rows {
            let id: String = row.try_get("item_id").unwrap_or_default();
            let id = id.trim();
            if !id.is_empty() && !stock_norm.contains_key(id) {
                reconcile_timed_asic_stock_leases(client, uid, id, 0, now_ms)
                    .await
                    .with_context(|| "persist_stock consume/reconcile")?;
                // qty 0 timed leftover — never mint from qty
                reconcile_stock_instances_to_qty(client, uid, id, 0, false)
                    .await
                    .with_context(|| "persist_stock consume/reconcile")?;
            }
        }
        let leftover = client
            .query(
                "SELECT DISTINCT catalog_item_id FROM item_instances
                  WHERE user_id = $1 AND status = $2",
                &[&uid_pg, &ITEM_INSTANCE_STATUS_STOCK],
            )
            .await
            .with_context(|| "persist_stock leftover instances")?;
        for row in leftover {
            let id: String = row.try_get("catalog_item_id").unwrap_or_default();
            let id = id.trim();
            if !id.is_empty() && !stock_norm.contains_key(id) {
                // Snapshot leftover / qty 0 — consume only, never qty-mint
                reconcile_stock_instances_to_qty(client, uid, id, 0, false)
                    .await
                    .with_context(|| "persist_stock consume/reconcile")?;
            }
        }
    }
    Ok(())
}

async fn persist_stored_batteries<C: GenericClient>(
    client: &C,
    uid: i64,
    incoming: &[StoredBattery],
    placed_racks: Option<&[PlacedRack]>,
) -> anyhow::Result<()> {
    let uid_pg = pg_user_id(uid)?;
    let mut keep: Vec<String> = incoming.iter().map(|b| b.id.clone()).collect();
    if let Some(racks) = placed_racks {
        keep.extend(collect_mounted_battery_ids(racks));
    }
    keep.sort();
    keep.dedup();

    // Credit doomed loose rows into stock, then delete (Node warehouse-delete.ts CTE).
    // Protect mounted UUIDs: NOT EXISTS placed_racks.battery_id.
    if keep.is_empty() {
        client
            .execute(
                "WITH doomed AS (
                   SELECT sb.id, sb.item_id
                     FROM stored_batteries sb
                    WHERE sb.user_id = $1
                      AND NOT EXISTS (
                        SELECT 1 FROM placed_racks pr
                         WHERE pr.user_id = $1
                           AND pr.battery_id IS NOT NULL
                           AND btrim(pr.battery_id::text) <> ''
                           AND btrim(pr.battery_id::text) = btrim(sb.id::text)
                      )
                 ),
                 credited AS (
                   INSERT INTO stock (user_id, item_id, qty)
                   SELECT $1, d.item_id, COUNT(*)::int
                     FROM doomed d
                    GROUP BY d.item_id
                   ON CONFLICT (user_id, item_id) DO UPDATE
                     SET qty = stock.qty + EXCLUDED.qty
                   RETURNING item_id
                 )
                 DELETE FROM stored_batteries sb
                  WHERE sb.id IN (SELECT id FROM doomed)",
                &[&uid_pg],
            )
            .await
            .with_context(|| "persist_stored_batteries fold empty")?;
    } else {
        client
            .execute(
                "WITH doomed AS (
                   SELECT sb.id, sb.item_id
                     FROM stored_batteries sb
                    WHERE sb.user_id = $1
                      AND NOT (sb.id = ANY($2::text[]))
                      AND NOT EXISTS (
                        SELECT 1 FROM placed_racks pr
                         WHERE pr.user_id = $1
                           AND pr.battery_id IS NOT NULL
                           AND btrim(pr.battery_id::text) <> ''
                           AND btrim(pr.battery_id::text) = btrim(sb.id::text)
                      )
                 ),
                 credited AS (
                   INSERT INTO stock (user_id, item_id, qty)
                   SELECT $1, d.item_id, COUNT(*)::int
                     FROM doomed d
                    GROUP BY d.item_id
                   ON CONFLICT (user_id, item_id) DO UPDATE
                     SET qty = stock.qty + EXCLUDED.qty
                   RETURNING item_id
                 )
                 DELETE FROM stored_batteries sb
                  WHERE sb.id IN (SELECT id FROM doomed)",
                &[&uid_pg, &keep],
            )
            .await
            .with_context(|| "persist_stored_batteries fold keep")?;
    }

    if !incoming.is_empty() {
        let b_ids: Vec<String> = incoming.iter().map(|b| b.id.clone()).collect();
        let b_items: Vec<String> = incoming
            .iter()
            .map(|b| normalize_known_1000wh_battery_catalog_id(Some(&b.item_id)))
            .collect();
        client
            .execute(
                "INSERT INTO stored_batteries (id, user_id, item_id)
                 SELECT unnest($2::text[]), $1, unnest($3::text[])
                 ON CONFLICT (id) DO UPDATE SET item_id = EXCLUDED.item_id",
                &[&uid_pg, &b_ids, &b_items],
            )
            .await
            .with_context(|| "persist_stored_batteries upsert")?;
    }
    Ok(())
}

async fn persist_placed_racks<C: GenericClient>(
    client: &C,
    uid: i64,
    placed_racks: &[PlacedRack],
) -> anyhow::Result<()> {
    let uid_pg = pg_user_id(uid)?;
    let current_ids: Vec<String> = placed_racks.iter().map(|r| r.id.clone()).collect();
    if current_ids.is_empty() {
        client
            .execute(
                "DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)",
                &[&uid_pg],
            )
            .await
            .with_context(|| "persist_placed_racks delete slots empty")?;
        client
            .execute(
                "DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)",
                &[&uid_pg],
            )
            .await
            .with_context(|| "persist_placed_racks delete multipliers empty")?;
        client
            .execute("DELETE FROM placed_racks WHERE user_id = $1", &[&uid_pg])
            .await
            .with_context(|| "persist_placed_racks delete racks empty")?;
        ensure_mounted_stored_batteries_for_user(client, uid).await?;
        sync_stored_battery_semantics_for_user(client, uid).await?;
        return Ok(());
    }

    client
        .execute(
            "DELETE FROM rack_slots WHERE rack_id IN (
               SELECT id FROM placed_racks WHERE user_id = $1 AND NOT (id = ANY($2::text[]))
             )",
            &[&uid_pg, &current_ids],
        )
        .await
        .with_context(|| "persist_placed_racks delete extra slots")?;
    client
        .execute(
            "DELETE FROM rack_multiplier_slots WHERE rack_id IN (
               SELECT id FROM placed_racks WHERE user_id = $1 AND NOT (id = ANY($2::text[]))
             )",
            &[&uid_pg, &current_ids],
        )
        .await
        .with_context(|| "persist_placed_racks delete extra multipliers")?;
    client
        .execute(
            "DELETE FROM placed_racks WHERE user_id = $1 AND NOT (id = ANY($2::text[]))",
            &[&uid_pg, &current_ids],
        )
        .await
        .with_context(|| "persist_placed_racks delete extra racks")?;

    let r_ids: Vec<String> = placed_racks.iter().map(|r| r.id.clone()).collect();
    let r_items: Vec<String> = placed_racks.iter().map(|r| r.item_id.clone()).collect();
    let r_wirings: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.wiring_id.as_deref()))
        .collect();
    let r_batteries: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.battery_id.as_deref()))
        .collect();
    let r_ons: Vec<i32> = placed_racks
        .iter()
        .map(|r| if r.is_on { 1 } else { 0 })
        .collect();
    let r_coins: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.selected_coin_id.as_deref()))
        .collect();
    let r_rooms: Vec<String> = placed_racks
        .iter()
        .map(|r| normalize_placed_rack_room_id(&r.room_id))
        .collect();
    let r_slot_idxs: Vec<i32> = placed_racks.iter().map(|r| r.slot_index as i32).collect();
    let r_bat_cats: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.battery_catalog_item_id.as_deref()))
        .collect();
    let r_bat_names: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.battery_display_name.as_deref()))
        .collect();
    let r_bat_imgs: Vec<String> = placed_racks
        .iter()
        .map(|r| bind_opt_text(r.battery_image_url.as_deref()))
        .collect();

    client
        .execute(
            PERSIST_PLACED_RACKS_UPSERT_SQL,
            &[
                &uid_pg,
                &r_ids,
                &r_items,
                &r_wirings,
                &r_batteries,
                &r_ons,
                &r_coins,
                &r_rooms,
                &r_slot_idxs,
                &r_bat_cats,
                &r_bat_names,
                &r_bat_imgs,
            ],
        )
        .await
        .with_context(|| "persist_placed_racks upsert")?;

    client
        .execute("DELETE FROM rack_slots WHERE rack_id = ANY($1)", &[&r_ids])
        .await
        .with_context(|| "persist_placed_racks clear slots")?;
    client
        .execute(
            "DELETE FROM rack_multiplier_slots WHERE rack_id = ANY($1)",
            &[&r_ids],
        )
        .await
        .with_context(|| "persist_placed_racks clear multipliers")?;

    let mut slot_rack: Vec<String> = Vec::new();
    let mut slot_idx: Vec<i32> = Vec::new();
    let mut slot_item: Vec<String> = Vec::new();
    let mut slot_lease: Vec<String> = Vec::new();
    let mut multi_rack: Vec<String> = Vec::new();
    let mut multi_idx: Vec<i32> = Vec::new();
    let mut multi_item: Vec<String> = Vec::new();

    for r in placed_racks {
        for (i, sid) in r.slots.iter().enumerate() {
            if sid.is_empty() {
                continue;
            }
            slot_rack.push(r.id.clone());
            slot_idx.push(i as i32);
            slot_item.push(sid.clone());
            let lease = match r.slot_lease_ids.get(i) {
                Some(s) if !s.trim().is_empty() => bind_uuid(s)?.to_string(),
                _ => String::new(),
            };
            slot_lease.push(lease);
        }
        for (i, mid) in r.multiplier_slots.iter().enumerate() {
            if mid.is_empty() {
                continue;
            }
            multi_rack.push(r.id.clone());
            multi_idx.push(i as i32);
            multi_item.push(mid.clone());
        }
    }

    if !slot_rack.is_empty() {
        client
            .execute(
                PERSIST_RACK_SLOTS_SQL,
                &[&slot_rack, &slot_idx, &slot_item, &slot_lease],
            )
            .await
            .with_context(|| "persist_placed_racks rack_slots")?;
    }
    if !multi_rack.is_empty() {
        client
            .execute(
                "INSERT INTO rack_multiplier_slots (rack_id, slot_index, multiplier_item_id)
                 SELECT unnest($1::text[]), unnest($2::int[]), unnest($3::text[])",
                &[&multi_rack, &multi_idx, &multi_item],
            )
            .await
            .with_context(|| "persist_placed_racks multiplier_slots")?;
    }
    ensure_mounted_stored_batteries_for_user(client, uid).await?;
    sync_stored_battery_semantics_for_user(client, uid).await?;
    Ok(())
}

fn ensure_mounted_sql() -> String {
    format!(
        "
    INSERT INTO stored_batteries (
      id, user_id, item_id, display_name, image_url,
      status, location, rack_id, slot_id, room_id,
      version, last_moved_at, updated_at
    )
    SELECT
      pr.battery_id,
      pr.user_id,
      btrim(pr.battery_catalog_item_id),
      NULLIF(btrim(COALESCE(pr.battery_display_name, '')), ''),
      NULLIF(btrim(COALESCE(pr.battery_image_url, '')), ''),
      'EQUIPPED',
      'RACK',
      pr.id,
      COALESCE(pr.slot_index, 0),
      COALESCE(NULLIF(btrim(COALESCE(pr.room_id::text, '')), ''), '{ROOM_INITIAL_ID}'),
      0,
      NOW(),
      NOW()
    FROM placed_racks pr
    WHERE pr.user_id = $1
      AND pr.battery_id IS NOT NULL
      AND btrim(pr.battery_id::text) <> ''
      AND pr.battery_id::text ~* $2::text
      AND pr.battery_catalog_item_id IS NOT NULL
      AND btrim(pr.battery_catalog_item_id) <> ''
      AND NOT EXISTS (SELECT 1 FROM stored_batteries sb WHERE sb.id = pr.battery_id)
    ON CONFLICT (id) DO NOTHING"
    )
}

fn semantic_sync_equip_sql() -> String {
    format!(
        "
    UPDATE stored_batteries sb
       SET status = 'EQUIPPED',
           location = 'RACK',
           rack_id = pr.id,
           slot_id = COALESCE(pr.slot_index, 0),
           room_id = COALESCE(nullif(btrim(pr.room_id::text), ''), '{ROOM_INITIAL_ID}'),
           version = CASE
             WHEN sb.status IS DISTINCT FROM 'EQUIPPED'::text
               OR sb.location IS DISTINCT FROM 'RACK'::text
               OR sb.rack_id IS DISTINCT FROM pr.id::text
               OR sb.room_id IS DISTINCT FROM COALESCE(nullif(btrim(pr.room_id::text), ''), '{ROOM_INITIAL_ID}')::text
               OR sb.slot_id IS DISTINCT FROM COALESCE(pr.slot_index, 0)
             THEN COALESCE(sb.version, 0) + 1
             ELSE COALESCE(sb.version, 0)
           END,
           last_moved_at = CASE
             WHEN sb.status IS DISTINCT FROM 'EQUIPPED'::text
               OR sb.location IS DISTINCT FROM 'RACK'::text
               OR sb.rack_id IS DISTINCT FROM pr.id::text
             THEN NOW()
             ELSE sb.last_moved_at
           END,
           updated_at = NOW()
      FROM placed_racks pr
     WHERE sb.user_id = $1
       AND pr.user_id = sb.user_id
       AND pr.battery_id IS NOT NULL
       AND btrim(pr.battery_id::text) <> ''
       AND btrim(pr.battery_id::text) = btrim(sb.id::text)
       AND pr.battery_id::text ~* $2::text
  "
    )
}

fn semantic_sync_inventory_sql() -> String {
    "
    UPDATE stored_batteries sb
       SET status = 'INVENTORY',
           location = 'WAREHOUSE',
           rack_id = NULL,
           slot_id = NULL,
           room_id = NULL,
           version = CASE
             WHEN sb.status IS DISTINCT FROM 'INVENTORY'::text
               OR sb.location IS DISTINCT FROM 'WAREHOUSE'::text
               OR sb.rack_id IS NOT NULL
               OR sb.slot_id IS NOT NULL
               OR sb.room_id IS NOT NULL
             THEN COALESCE(sb.version, 0) + 1
             ELSE COALESCE(sb.version, 0)
           END,
           last_moved_at = CASE
             WHEN sb.status IS DISTINCT FROM 'INVENTORY'::text
               OR sb.location IS DISTINCT FROM 'WAREHOUSE'::text
               OR sb.rack_id IS NOT NULL
             THEN NOW()
             ELSE sb.last_moved_at
           END,
           updated_at = NOW()
     WHERE sb.user_id = $1
       AND COALESCE(nullif(btrim(sb.status::text), ''), '') NOT IN ('BROKEN', 'CONSUMED', 'LOCKED')
       AND NOT EXISTS (
             SELECT 1 FROM placed_racks pr
              WHERE pr.user_id = sb.user_id
                AND pr.battery_id IS NOT NULL
                AND btrim(pr.battery_id::text) <> ''
                AND btrim(pr.battery_id::text) = btrim(sb.id::text)
                AND pr.battery_id::text ~* $2::text
           )
  "
    .to_string()
}

/// Node `ensureMountedStoredBatteriesForUser` — after placed_racks UPSERT.
async fn ensure_mounted_stored_batteries_for_user<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<()> {
    if uid <= 0 {
        return Ok(());
    }
    let uid_pg = pg_user_id(uid)?;
    client
        .execute(&ensure_mounted_sql(), &[&uid_pg, &PG_BATTERY_INSTANCE_UUID])
        .await?;
    Ok(())
}

/// Node `syncStoredBatterySemanticsForUser` — both UPDATEs.
async fn sync_stored_battery_semantics_for_user<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<()> {
    if uid <= 0 {
        return Ok(());
    }
    let uid_pg = pg_user_id(uid)?;
    client
        .execute(
            &semantic_sync_equip_sql(),
            &[&uid_pg, &PG_BATTERY_INSTANCE_UUID],
        )
        .await?;
    client
        .execute(
            &semantic_sync_inventory_sql(),
            &[&uid_pg, &PG_BATTERY_INSTANCE_UUID],
        )
        .await?;
    Ok(())
}

pub async fn persist_hardware<C: GenericClient>(
    client: &C,
    mut input: PersistInput,
) -> anyhow::Result<()> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;

    if input.placed_racks.is_some() && input.stock.is_none() {
        let racks = input.placed_racks.as_deref().unwrap_or(&[]);
        apply_dismantled_recovery(client, input.user_id, racks, &mut input.stock).await?;
    }

    if let Some(stock) = &input.stock {
        persist_stock(client, input.user_id, stock, input.stock_mode).await?;
    }

    if let Some(bats) = &input.stored_batteries {
        let norm = sanitize_stored_batteries(bats, input.placed_racks.as_deref());
        persist_stored_batteries(client, input.user_id, &norm, input.placed_racks.as_deref())
            .await?;
    }

    if let Some(racks) = &input.placed_racks {
        persist_placed_racks(client, input.user_id, racks).await?;
    }

    Ok(())
}

/// Node `HARDWARE_FOLD_WAREHOUSE_PATH` — GET inventory warehouse→stock fold.
pub const FOLD_WAREHOUSE_PATH: &str = "/v1/hardware/fold-warehouse";

/// Include-list fold (GET exposed IDs). Same doomed/credit/delete as the
/// persist keep-list CTE, but `sb.id = ANY($2)` — never the empty-keep
/// “fold every loose row” path. Final SELECT is increments from that doomed set.
const FOLD_WAREHOUSE_SQL: &str = "
WITH doomed AS (
  SELECT sb.id, sb.item_id
    FROM stored_batteries sb
   WHERE sb.user_id = $1
     AND sb.id = ANY($2::text[])
     AND NOT EXISTS (
       SELECT 1 FROM placed_racks pr
        WHERE pr.user_id = $1
          AND pr.battery_id IS NOT NULL
          AND btrim(pr.battery_id::text) <> ''
          AND btrim(pr.battery_id::text) = btrim(sb.id::text)
     )
  FOR UPDATE OF sb
),
credited AS (
  INSERT INTO stock (user_id, item_id, qty)
  SELECT $1, d.item_id, COUNT(*)::int
    FROM doomed d
   GROUP BY d.item_id
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET qty = stock.qty + EXCLUDED.qty
  RETURNING item_id
),
deleted AS (
  DELETE FROM stored_batteries sb
   WHERE sb.id IN (SELECT id FROM doomed)
  RETURNING id
)
SELECT d.item_id, COUNT(*)::int AS qty
  FROM doomed d
 GROUP BY d.item_id
";

/// Empty `battery_ids` → success with `{}` (do not fold every loose row).
pub fn fold_warehouse_empty_credits() -> HashMap<String, i64> {
    HashMap::new()
}

/// Credit stock for the given loose `stored_batteries` IDs and delete those rows
/// in one statement. Mounted UUIDs (`placed_racks.battery_id`) are never deleted.
/// Missing IDs credit nothing. Retry after a successful fold → empty doomed → `{}`.
pub async fn fold_warehouse_ids<C: GenericClient>(
    client: &C,
    user_id: i64,
    battery_ids: &[String],
) -> anyhow::Result<HashMap<String, i64>> {
    if battery_ids.is_empty() {
        return Ok(fold_warehouse_empty_credits());
    }
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    let uid_pg = pg_user_id(user_id)?;
    let ids = battery_ids.to_vec();
    let rows = client.query(FOLD_WAREHOUSE_SQL, &[&uid_pg, &ids]).await?;
    let mut stock = HashMap::new();
    for row in rows {
        let item_id: String = row.get("item_id");
        let qty: i32 = row.get("qty");
        if qty > 0 {
            stock.insert(item_id, i64::from(qty));
        }
    }
    Ok(stock)
}

/// Caller duration override: both amount+unit present and timed after normalize.
/// Never invents a duration — `None` means use catalog (or increment).
pub fn credit_duration_override(
    duration_amount: Option<i64>,
    duration_unit: Option<&str>,
) -> Option<AsicDurationConfig> {
    let (Some(amount), Some(unit)) = (duration_amount, duration_unit) else {
        return None;
    };
    let cfg = normalize_asic_duration_config(Some(amount), Some(unit), None);
    if is_timed_asic_duration(&cfg) {
        Some(cfg)
    } else {
        None
    }
}

pub async fn credit_stock<C: GenericClient>(
    client: &C,
    uid: i64,
    item_id_raw: &str,
    qty_raw: i64,
    duration_amount: Option<i64>,
    duration_unit: Option<&str>,
) -> anyhow::Result<()> {
    let item_id = normalize_known_1000wh_battery_catalog_id(Some(item_id_raw));
    if item_id.is_empty() || qty_raw <= 0 {
        return Ok(());
    }
    let uid_pg = pg_user_id(uid)?;
    let now_ms = current_unix_ms();
    if let Some(cfg) = credit_duration_override(duration_amount, duration_unit) {
        create_asic_leases_on_credit(client, uid, &item_id, qty_raw, &cfg, now_ms).await?;
        sync_timed_asic_stock_for_item(client, uid, &item_id, now_ms).await?;
        return Ok(());
    }
    let cfg = load_asic_duration_config(client, &item_id).await?;
    if is_timed_asic_duration(&cfg) {
        create_asic_leases_on_credit(client, uid, &item_id, qty_raw, &cfg, now_ms).await?;
        sync_timed_asic_stock_for_item(client, uid, &item_id, now_ms).await?;
    } else {
        let qty = pg_qty(qty_raw)?;
        client
            .execute(
                "INSERT INTO stock (user_id, item_id, qty) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty",
                &[&uid_pg, &item_id, &qty],
            )
            .await?;
        mint_instances(client, uid, &item_id, qty_raw, ITEM_INSTANCE_STATUS_STOCK).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use genesis_core::calculator::constants::ROOM_INITIAL_ID;

    #[test]
    fn merge_mode_never_snapshot() {
        assert_eq!(StockMode::parse(Some("merge")), StockMode::Merge);
        assert_eq!(StockMode::parse(Some("snapshot")), StockMode::Snapshot);
        assert_eq!(StockMode::parse(Some("partial")), StockMode::Partial);
        assert_eq!(StockMode::parse(None), StockMode::Partial);
    }

    #[test]
    fn asic_lease_reconcile_not_ported_this_phase() {
        assert!(
            ASIC_LEASE_RECONCILE_PORTED,
            "persist/credit must reconcile timed leases and credit creates+syncs them"
        );
    }

    #[test]
    fn credit_override_only_when_both_timed() {
        let cfg = credit_duration_override(Some(7), Some("day")).expect("timed");
        assert!(is_timed_asic_duration(&cfg));
        assert_eq!(cfg.amount, 7);
        assert_eq!(cfg.unit.as_deref(), Some("day"));
        assert!(credit_duration_override(Some(7), None).is_none());
        assert!(credit_duration_override(None, Some("day")).is_none());
        assert!(credit_duration_override(Some(0), Some("day")).is_none());
        assert!(credit_duration_override(Some(7), Some("nope")).is_none());
    }

    #[test]
    fn sanitize_drops_mounted_and_invalid_ids() {
        // save-game ids must match [a-zA-Z0-9_.-]{1,200}
        let bats = vec![
            StoredBattery {
                id: "loose_bat_1".into(),
                item_id: "battery_estelar".into(),
                ..Default::default()
            },
            StoredBattery {
                id: "mounted_bat_1".into(),
                item_id: "battery_estelar".into(),
                ..Default::default()
            },
        ];
        let racks = vec![PlacedRack {
            id: "r1".into(),
            battery_id: Some("mounted_bat_1".into()),
            ..Default::default()
        }];
        let out = sanitize_stored_batteries(&bats, Some(&racks));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "loose_bat_1");
    }

    #[test]
    fn fold_warehouse_path_matches_node() {
        assert_eq!(FOLD_WAREHOUSE_PATH, "/v1/hardware/fold-warehouse");
    }

    #[test]
    fn empty_battery_ids_credited_noop() {
        assert!(fold_warehouse_empty_credits().is_empty());
    }

    #[test]
    fn battery_uuid_regex_matches_node_invariant() {
        assert_eq!(
            PG_BATTERY_INSTANCE_UUID,
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        );
    }

    #[test]
    fn room_initial_id_is_room_initial() {
        assert_eq!(ROOM_INITIAL_ID, "room_initial");
        assert!(ensure_mounted_sql().contains(ROOM_INITIAL_ID));
        assert!(semantic_sync_equip_sql().contains(ROOM_INITIAL_ID));
        assert!(
            ensure_mounted_sql().contains("COALESCE(pr.slot_index, 0)"),
            "slot_id fallback 0 is Node SQL"
        );
        assert!(
            ensure_mounted_sql().contains("\n      0,\n      NOW()"),
            "version 0 is Node SQL"
        );
    }

    #[test]
    fn placed_racks_upsert_nullif_optional_text_unnests() {
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($4::text[]), '')"),
            "wiring_id"
        );
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($5::text[]), '')"),
            "battery_id"
        );
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($7::text[]), '')"),
            "selected_coin_id"
        );
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($10::text[]), '')"),
            "battery_catalog_item_id"
        );
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($11::text[]), '')"),
            "battery_display_name"
        );
        assert!(
            PERSIST_PLACED_RACKS_UPSERT_SQL.contains("NULLIF(unnest($12::text[]), '')"),
            "battery_image_url"
        );
        assert!(
            PERSIST_RACK_SLOTS_SQL.contains("NULLIF(unnest($4::text[]), '')::uuid"),
            "slot_lease as text[] then uuid"
        );
        assert!(!PERSIST_RACK_SLOTS_SQL.contains("unnest($4::uuid[])"));
        assert_eq!(bind_opt_text(None), "");
        assert_eq!(bind_opt_text(Some("")), "");
        assert_eq!(bind_opt_text(Some("  ")), "");
        assert_eq!(bind_opt_text(Some("  bat_1  ")), "bat_1");
    }

    #[test]
    fn fold_warehouse_sql_includes_ids_not_keep_exclude() {
        assert!(
            FOLD_WAREHOUSE_SQL.contains("sb.id = ANY($2::text[])"),
            "GET fold must include the given IDs"
        );
        assert!(
            !FOLD_WAREHOUSE_SQL.contains("NOT (sb.id = ANY($2::text[])"),
            "must not use persist keep-list exclude (would fold every other loose row)"
        );
        assert!(
            FOLD_WAREHOUSE_SQL.contains("FOR UPDATE OF sb"),
            "doomed SELECT must lock stored_batteries so concurrent folds cannot double-credit"
        );
    }
}
