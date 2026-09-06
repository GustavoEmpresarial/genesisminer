//! `player_asic_leases` create / reconcile / sync / expire / equip / release —
//! port of `server/modules/mining-engine/services/asic-lease.ts`.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::GenericClient;
use genesis_core::hardware::duration::{
    compute_asic_lease_expires_at, is_timed_asic_duration, normalize_asic_duration_config,
    AsicDurationConfig,
};
use genesis_core::hardware::room::{is_nft_room_catalog_machine_row, MachineUpgradeRef};
use genesis_core::hardware::types::PlacedRack;
use tokio_postgres::Row;

use crate::eligibility::{
    record_mining_eligibility_event, EligibilityEvent, EVENT_ASIC_EXPIRED, EVENT_MINER_EQUIPPED,
    EVENT_MINER_UNEQUIPPED, IDENTITY_LEASE, IDENTITY_PLACEMENT,
};
use crate::instances::{mint_instance_with_id, set_instance_lease_state};
use crate::pg_types::pg_user_id;

/// Initial lease status after credit / purchase (not yet equipped).
pub const ASIC_LEASE_STATUS_STOCK: &str = "stock";
pub const ASIC_LEASE_STATUS_EQUIPPED: &str = "equipped";
pub const ASIC_LEASE_STATUS_EXPIRED: &str = "expired";
/// P2P book — same UUID, clock (`expires_at`) still runs.
pub const ASIC_LEASE_STATUS_LISTED: &str = "listed";

/// Lock instances of candidate leases first (same order as `p2p`: instance then lease).
pub(crate) const EXPIRE_LOCK_INSTANCES_SQL: &str = "SELECT id FROM item_instances
             WHERE id IN (
               SELECT id FROM player_asic_leases
               WHERE user_id = $1 AND expires_at <= $2 AND status IN ($3, $4, $5)
             )
             ORDER BY id
             FOR UPDATE";

pub(crate) const EXPIRE_SELECT_SQL: &str =
    "SELECT id, item_id, status, rack_id, slot_index, acquired_at, expires_at
             FROM player_asic_leases
             WHERE user_id = $1 AND expires_at <= $2 AND status IN ($3, $4, $5)
             ORDER BY id
             FOR UPDATE";

pub(crate) const EXPIRE_UPDATE_SQL: &str = "UPDATE player_asic_leases
                 SET status = $2, rack_id = NULL, slot_index = NULL
                 WHERE id = $1 AND status IN ($3, $4, $5)";

pub(crate) const SOFT_EXPIRE_UPDATE_SQL: &str = "UPDATE player_asic_leases
             SET status = $3, rack_id = NULL, slot_index = NULL
             WHERE id = $1 AND user_id = $2 AND status IN ($4, $5, $6)";

pub const ERR_NO_VALID_ASICS: &str = "No valid ASICs in stock (expired or sold out).";

pub fn row_uuid_string(row: &Row, col: &str) -> Option<String> {
    if let Ok(u) = row.try_get::<_, uuid::Uuid>(col) {
        return Some(u.to_string());
    }
    if let Ok(Some(u)) = row.try_get::<_, Option<uuid::Uuid>>(col) {
        return Some(u.to_string());
    }
    if let Ok(s) = row.try_get::<_, String>(col) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(Some(s)) = row.try_get::<_, Option<String>>(col) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

pub fn bind_uuid(raw: &str) -> anyhow::Result<uuid::Uuid> {
    uuid::Uuid::parse_str(raw.trim()).map_err(|e| anyhow::anyhow!("invalid lease uuid: {e}"))
}

fn empty_duration_cfg() -> AsicDurationConfig {
    AsicDurationConfig {
        amount: 0,
        unit: None,
    }
}

pub async fn load_asic_duration_config<C: GenericClient>(
    client: &C,
    item_id: &str,
) -> anyhow::Result<AsicDurationConfig> {
    let rows = client
        .query(
            "SELECT type, category, id, nft_mining_coin_id,
                    COALESCE(asic_duration_amount, 0) AS asic_duration_amount,
                    asic_duration_unit,
                    COALESCE(asic_duration_kind, 'none') AS asic_duration_kind
             FROM upgrades WHERE id = $1 LIMIT 1",
            &[&item_id],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Ok(empty_duration_cfg());
    };
    let machine_ref = MachineUpgradeRef {
        id: row.try_get("id").unwrap_or_default(),
        type_name: row.try_get("type").unwrap_or_default(),
        category: row.try_get("category").unwrap_or_default(),
        nft_mining_coin_id: row.try_get("nft_mining_coin_id").ok().flatten(),
    };
    if !is_nft_room_catalog_machine_row(&machine_ref) {
        return Ok(empty_duration_cfg());
    }
    let amount: i32 = row.try_get("asic_duration_amount").unwrap_or(0);
    let unit: Option<String> = row.try_get("asic_duration_unit").ok().flatten();
    let kind: String = row
        .try_get("asic_duration_kind")
        .unwrap_or_else(|_| "none".into());
    Ok(normalize_asic_duration_config(
        Some(i64::from(amount)),
        unit.as_deref(),
        Some(&kind),
    ))
}

pub async fn create_asic_leases_on_credit<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    qty: i64,
    cfg: &AsicDurationConfig,
    now_ms: i64,
) -> anyhow::Result<()> {
    if qty <= 0 || !is_timed_asic_duration(cfg) {
        return Ok(());
    }
    let expires_at = compute_asic_lease_expires_at(cfg, now_ms);
    if expires_at <= now_ms {
        return Ok(());
    }
    let uid_i64 = user_id;
    let user_id = pg_user_id(user_id)?;
    for _ in 0..qty {
        let id = uuid::Uuid::new_v4();
        client
            .execute(
                "INSERT INTO player_asic_leases (id, user_id, item_id, acquired_at, expires_at, status, rack_id, slot_index)
                 VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)",
                &[
                    &id,
                    &user_id,
                    &item_id,
                    &now_ms,
                    &expires_at,
                    &ASIC_LEASE_STATUS_STOCK,
                ],
            )
            .await?;
        mint_instance_with_id(
            client,
            id,
            uid_i64,
            item_id,
            ASIC_LEASE_STATUS_STOCK,
            None,
            None,
        )
        .await?;
    }
    Ok(())
}

async fn count_stock_leases<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    now_ms: i64,
) -> anyhow::Result<i32> {
    let user_id = pg_user_id(user_id)?;
    let rows = client
        .query(
            "SELECT COUNT(*)::int AS n FROM player_asic_leases
              WHERE user_id = $1 AND item_id = $2 AND status = $3 AND expires_at > $4",
            &[&user_id, &item_id, &ASIC_LEASE_STATUS_STOCK, &now_ms],
        )
        .await?;
    Ok(rows.first().map(|r| r.get("n")).unwrap_or(0))
}

pub async fn sync_timed_asic_stock_for_item<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    let qty = count_stock_leases(client, user_id, item_id, now_ms).await?;
    let user_id = pg_user_id(user_id)?;
    if qty > 0 {
        client
            .execute(
                "INSERT INTO stock (user_id, item_id, qty) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty",
                &[&user_id, &item_id, &qty],
            )
            .await?;
    } else {
        client
            .execute(
                "DELETE FROM stock WHERE user_id = $1 AND item_id = $2",
                &[&user_id, &item_id],
            )
            .await?;
    }
    Ok(())
}

/// Trim excess stock-status leases when `target_qty` < current; never mint.
/// Then sync `stock.qty` from remaining unexpired stock leases.
pub async fn reconcile_timed_asic_stock_leases<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    target_qty: i64,
    now_ms: i64,
) -> anyhow::Result<bool> {
    let cfg = load_asic_duration_config(client, item_id).await?;
    if !is_timed_asic_duration(&cfg) {
        return Ok(false);
    }
    let target = target_qty.max(0);
    let current = i64::from(count_stock_leases(client, user_id, item_id, now_ms).await?);
    if target < current {
        let to_remove = current - target;
        let user_id = pg_user_id(user_id)?;
        client
            .execute(
                "DELETE FROM player_asic_leases
                 WHERE id IN (
                   SELECT id FROM player_asic_leases
                   WHERE user_id = $1 AND item_id = $2 AND status = $3 AND expires_at > $4
                   ORDER BY expires_at DESC
                   LIMIT $5
                 )",
                &[
                    &user_id,
                    &item_id,
                    &ASIC_LEASE_STATUS_STOCK,
                    &now_ms,
                    &to_remove,
                ],
            )
            .await?;
    }
    sync_timed_asic_stock_for_item(client, user_id, item_id, now_ms).await?;
    Ok(true)
}

async fn sync_all_timed_asic_stock<C: GenericClient>(
    client: &C,
    user_id: i64,
    now_ms: i64,
) -> anyhow::Result<()> {
    let uid = pg_user_id(user_id)?;
    let rows = client
        .query(
            "SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    for row in rows {
        let id: String = row.try_get("item_id").unwrap_or_default();
        let id = id.trim();
        if !id.is_empty() {
            sync_timed_asic_stock_for_item(client, user_id, id, now_ms).await?;
        }
    }
    Ok(())
}

/// Soft-expire stock/equipped leases, clear slots, emit ASIC_EXPIRED / MINER_UNEQUIPPED.
pub async fn expire_user_asic_leases<C: GenericClient>(
    client: &C,
    user_id: i64,
    now_ms: i64,
) -> anyhow::Result<i64> {
    let uid = pg_user_id(user_id)?;
    client
        .query(
            EXPIRE_LOCK_INSTANCES_SQL,
            &[
                &uid,
                &now_ms,
                &ASIC_LEASE_STATUS_STOCK,
                &ASIC_LEASE_STATUS_EQUIPPED,
                &ASIC_LEASE_STATUS_LISTED,
            ],
        )
        .await?;
    let expired = client
        .query(
            EXPIRE_SELECT_SQL,
            &[
                &uid,
                &now_ms,
                &ASIC_LEASE_STATUS_STOCK,
                &ASIC_LEASE_STATUS_EQUIPPED,
                &ASIC_LEASE_STATUS_LISTED,
            ],
        )
        .await?;
    let mut n: i64 = 0;
    for row in &expired {
        n += 1;
        let lease_id = row_uuid_string(row, "id").unwrap_or_default();
        let item_id: String = row.try_get("item_id").unwrap_or_default();
        let item_id = item_id.trim().to_string();
        let status: String = row.try_get("status").unwrap_or_default();
        let rack_id: String = row
            .try_get::<_, Option<String>>("rack_id")
            .ok()
            .flatten()
            .unwrap_or_default()
            .trim()
            .to_string();
        let slot_index: Option<i32> = row.try_get("slot_index").ok().flatten();
        let acquired_at: i64 = row.try_get("acquired_at").unwrap_or(0);
        let expires_at: i64 = row.try_get("expires_at").unwrap_or(0);

        if status == ASIC_LEASE_STATUS_EQUIPPED && !rack_id.is_empty() && slot_index.is_some() {
            let si = i64::from(slot_index.unwrap_or(0));
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id,
                    event_type: EVENT_MINER_UNEQUIPPED,
                    at_ms: now_ms,
                    identity_kind: IDENTITY_LEASE,
                    lease_id: Some(&lease_id),
                    rack_id: Some(&rack_id),
                    slot_index: Some(si),
                    catalog_item_id: if item_id.is_empty() {
                        None
                    } else {
                        Some(&item_id)
                    },
                    coin_id: None,
                    payload: Some(serde_json::json!({ "reason": "asic_expired" })),
                },
            )
            .await?;
            let lease_uuid = bind_uuid(&lease_id)?;
            client
                .execute(
                    "UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL
                     WHERE rack_id = $1 AND slot_index = $2 AND machine_lease_id = $3",
                    &[&rack_id, &slot_index.unwrap_or(0), &lease_uuid],
                )
                .await?;
        }

        let lease_uuid = bind_uuid(&lease_id)?;
        client
            .execute(
                EXPIRE_UPDATE_SQL,
                &[
                    &lease_uuid,
                    &ASIC_LEASE_STATUS_EXPIRED,
                    &ASIC_LEASE_STATUS_STOCK,
                    &ASIC_LEASE_STATUS_EQUIPPED,
                    &ASIC_LEASE_STATUS_LISTED,
                ],
            )
            .await?;
        set_instance_lease_state(client, lease_uuid, ASIC_LEASE_STATUS_EXPIRED, None, None).await?;

        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_ASIC_EXPIRED,
                at_ms: now_ms,
                identity_kind: IDENTITY_LEASE,
                lease_id: Some(&lease_id),
                rack_id: if rack_id.is_empty() {
                    None
                } else {
                    Some(&rack_id)
                },
                slot_index: slot_index.map(i64::from),
                catalog_item_id: if item_id.is_empty() {
                    None
                } else {
                    Some(&item_id)
                },
                coin_id: None,
                payload: Some(serde_json::json!({
                    "acquired_at": acquired_at,
                    "expires_at": expires_at,
                    "previous_status": status
                })),
            },
        )
        .await?;
    }
    if n > 0 {
        sync_all_timed_asic_stock(client, user_id, now_ms).await?;
    }
    Ok(n)
}

pub async fn reserve_asic_lease_for_equip<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    now_ms: i64,
) -> anyhow::Result<Result<String, String>> {
    let uid = pg_user_id(user_id)?;
    let rows = client
        .query(
            "SELECT id FROM player_asic_leases
             WHERE user_id = $1 AND item_id = $2 AND status = $3 AND expires_at > $4
             ORDER BY expires_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED",
            &[&uid, &item_id, &ASIC_LEASE_STATUS_STOCK, &now_ms],
        )
        .await?;
    match rows.first().and_then(|r| row_uuid_string(r, "id")) {
        Some(id) => Ok(Ok(id)),
        None => Ok(Err(ERR_NO_VALID_ASICS.to_string())),
    }
}

pub async fn mark_lease_equipped<C: GenericClient>(
    client: &C,
    lease_id: &str,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
) -> anyhow::Result<()> {
    let uid = pg_user_id(user_id)?;
    let id = bind_uuid(lease_id)?;
    let si = i32::try_from(slot_index).unwrap_or(0);
    client
        .execute(
            "UPDATE player_asic_leases SET status = $5, rack_id = $3, slot_index = $4
             WHERE id = $1 AND user_id = $2 AND status = $6",
            &[
                &id,
                &uid,
                &rack_id,
                &si,
                &ASIC_LEASE_STATUS_EQUIPPED,
                &ASIC_LEASE_STATUS_STOCK,
            ],
        )
        .await?;
    set_instance_lease_state(
        client,
        id,
        ASIC_LEASE_STATUS_EQUIPPED,
        Some(rack_id),
        Some(si),
    )
    .await?;
    Ok(())
}

async fn soft_expire_lease_row<C: GenericClient>(
    client: &C,
    user_id: i64,
    lease_id: &str,
    item_id: &str,
    now_ms: i64,
    acquired_at: i64,
    expires_at: i64,
    previous_status: &str,
    rack_id: Option<&str>,
    slot_index: Option<i64>,
) -> anyhow::Result<()> {
    let uid = pg_user_id(user_id)?;
    let id = bind_uuid(lease_id)?;
    let n = client
        .execute(
            SOFT_EXPIRE_UPDATE_SQL,
            &[
                &id,
                &uid,
                &ASIC_LEASE_STATUS_EXPIRED,
                &ASIC_LEASE_STATUS_STOCK,
                &ASIC_LEASE_STATUS_EQUIPPED,
                &ASIC_LEASE_STATUS_LISTED,
            ],
        )
        .await?;
    if n == 0 {
        return Ok(());
    }
    set_instance_lease_state(client, id, ASIC_LEASE_STATUS_EXPIRED, None, None).await?;
    record_mining_eligibility_event(
        client,
        EligibilityEvent {
            user_id,
            event_type: EVENT_ASIC_EXPIRED,
            at_ms: now_ms,
            identity_kind: IDENTITY_LEASE,
            lease_id: Some(lease_id),
            rack_id,
            slot_index,
            catalog_item_id: if item_id.is_empty() {
                None
            } else {
                Some(item_id)
            },
            coin_id: None,
            payload: Some(serde_json::json!({
                "acquired_at": acquired_at,
                "expires_at": expires_at,
                "previous_status": previous_status
            })),
        },
    )
    .await?;
    Ok(())
}

pub async fn apply_timed_stock_qty_to_snapshot<C: GenericClient>(
    client: &C,
    user_id: i64,
    stock: &mut HashMap<String, i64>,
    item_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    let qty = i64::from(count_stock_leases(client, user_id, item_id, now_ms).await?);
    if qty > 0 {
        stock.insert(item_id.to_string(), qty);
    } else {
        stock.remove(item_id);
    }
    Ok(())
}

pub async fn record_placement_miner_equipped<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
    catalog_item_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    record_mining_eligibility_event(
        client,
        EligibilityEvent {
            user_id,
            event_type: EVENT_MINER_EQUIPPED,
            at_ms: now_ms,
            identity_kind: IDENTITY_PLACEMENT,
            lease_id: None,
            rack_id: Some(rack_id),
            slot_index: Some(slot_index),
            catalog_item_id: Some(catalog_item_id),
            coin_id: None,
            payload: None,
        },
    )
    .await?;
    Ok(())
}

pub async fn record_placement_miner_unequipped<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
    catalog_item_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    let item_id = catalog_item_id.trim();
    if item_id.is_empty() {
        return Ok(());
    }
    record_mining_eligibility_event(
        client,
        EligibilityEvent {
            user_id,
            event_type: EVENT_MINER_UNEQUIPPED,
            at_ms: now_ms,
            identity_kind: IDENTITY_PLACEMENT,
            lease_id: None,
            rack_id: Some(rack_id),
            slot_index: Some(slot_index),
            catalog_item_id: Some(item_id),
            coin_id: None,
            payload: Some(serde_json::json!({ "reason": "unequip" })),
        },
    )
    .await?;
    Ok(())
}

pub async fn finalize_timed_miner_equip<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
    catalog_item_id: &str,
    placed_racks: &mut [PlacedRack],
    stock: &mut HashMap<String, i64>,
    now_ms: i64,
) -> anyhow::Result<Result<(), String>> {
    let reserved = reserve_asic_lease_for_equip(client, user_id, catalog_item_id, now_ms).await?;
    let lease_id = match reserved {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    mark_lease_equipped(client, &lease_id, user_id, rack_id, slot_index).await?;
    record_mining_eligibility_event(
        client,
        EligibilityEvent {
            user_id,
            event_type: EVENT_MINER_EQUIPPED,
            at_ms: now_ms,
            identity_kind: IDENTITY_LEASE,
            lease_id: Some(&lease_id),
            rack_id: Some(rack_id),
            slot_index: Some(slot_index),
            catalog_item_id: Some(catalog_item_id),
            coin_id: None,
            payload: None,
        },
    )
    .await?;
    if let Some(rack) = placed_racks.iter_mut().find(|r| r.id == rack_id) {
        let si = slot_index.max(0) as usize;
        while rack.slot_lease_ids.len() <= si {
            rack.slot_lease_ids.push(String::new());
        }
        rack.slot_lease_ids[si] = lease_id;
    }
    apply_timed_stock_qty_to_snapshot(client, user_id, stock, catalog_item_id, now_ms).await?;
    Ok(Ok(()))
}

pub async fn repair_equipped_asic_leases_for_rack<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    now_ms: i64,
) -> anyhow::Result<i64> {
    let uid = pg_user_id(user_id)?;
    let slots = client
        .query(
            "SELECT s.rack_id, s.slot_index, s.machine_item_id
             FROM rack_slots s
             INNER JOIN placed_racks pr ON pr.id = s.rack_id AND pr.user_id = $1
             WHERE s.rack_id = $2
               AND s.machine_item_id IS NOT NULL
               AND (s.machine_lease_id IS NULL OR BTRIM(s.machine_lease_id::text) = '')",
            &[&uid, &rack_id],
        )
        .await?;
    let mut repaired: i64 = 0;
    for row in slots {
        let item_id: String = row.try_get("machine_item_id").unwrap_or_default();
        let item_id = item_id.trim().to_string();
        if item_id.is_empty() {
            continue;
        }
        let cfg = load_asic_duration_config(client, &item_id).await?;
        if !is_timed_asic_duration(&cfg) {
            continue;
        }
        let rid: String = row.get("rack_id");
        let si: i32 = row.get("slot_index");
        let existing = client
            .query(
                "SELECT id FROM player_asic_leases
                 WHERE user_id = $1 AND status = $2 AND rack_id = $3 AND slot_index = $4 AND expires_at > $5
                 LIMIT 1",
                &[&uid, &ASIC_LEASE_STATUS_EQUIPPED, &rid, &si, &now_ms],
            )
            .await?;
        if let Some(lease_id) = existing.first().and_then(|r| row_uuid_string(r, "id")) {
            let lease_uuid = bind_uuid(&lease_id)?;
            client
                .execute(
                    "UPDATE rack_slots SET machine_lease_id = $3 WHERE rack_id = $1 AND slot_index = $2",
                    &[&rid, &si, &lease_uuid],
                )
                .await?;
            repaired += 1;
        }
    }
    Ok(repaired)
}

pub async fn release_equipped_asic_lease_by_id<C: GenericClient>(
    client: &C,
    user_id: i64,
    lease_id: &str,
    item_id: &str,
    now_ms: i64,
) -> anyhow::Result<bool> {
    let id = lease_id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    let uid = pg_user_id(user_id)?;
    let lease_uuid = match bind_uuid(id) {
        Ok(u) => u,
        Err(_) => return Ok(false),
    };
    let rows = client
        .query(
            "SELECT id, item_id, expires_at, acquired_at, status, rack_id, slot_index
             FROM player_asic_leases WHERE id = $1 AND user_id = $2",
            &[&lease_uuid, &uid],
        )
        .await?;
    let Some(lease) = rows.first() else {
        return Ok(false);
    };
    let lease_item: String = lease.try_get("item_id").unwrap_or_default();
    let sync_item = if item_id.trim().is_empty() {
        lease_item.trim().to_string()
    } else {
        item_id.trim().to_string()
    };
    let rack_id: String = lease
        .try_get::<_, Option<String>>("rack_id")
        .ok()
        .flatten()
        .unwrap_or_default()
        .trim()
        .to_string();
    let slot_index: Option<i32> = lease.try_get("slot_index").ok().flatten();
    let status: String = lease.try_get("status").unwrap_or_default();
    let expires_at: i64 = lease.try_get("expires_at").unwrap_or(0);
    let acquired_at: i64 = lease.try_get("acquired_at").unwrap_or(0);

    if status == ASIC_LEASE_STATUS_EQUIPPED {
        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_MINER_UNEQUIPPED,
                at_ms: now_ms,
                identity_kind: IDENTITY_LEASE,
                lease_id: Some(id),
                rack_id: if rack_id.is_empty() {
                    None
                } else {
                    Some(&rack_id)
                },
                slot_index: slot_index.map(i64::from),
                catalog_item_id: if sync_item.is_empty() {
                    None
                } else {
                    Some(&sync_item)
                },
                coin_id: None,
                payload: Some(serde_json::json!({ "reason": "unequip" })),
            },
        )
        .await?;
    }

    if !rack_id.is_empty() && slot_index.is_some() {
        client
            .execute(
                "UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL
                 WHERE rack_id = $1 AND slot_index = $2 AND machine_lease_id = $3",
                &[&rack_id, &slot_index.unwrap_or(0), &lease_uuid],
            )
            .await?;
    }

    if expires_at <= now_ms {
        soft_expire_lease_row(
            client,
            user_id,
            id,
            &sync_item,
            now_ms,
            acquired_at,
            expires_at,
            &status,
            if rack_id.is_empty() {
                None
            } else {
                Some(rack_id.as_str())
            },
            slot_index.map(i64::from),
        )
        .await?;
    } else {
        client
            .execute(
                "UPDATE player_asic_leases SET status = $2, rack_id = NULL, slot_index = NULL WHERE id = $1",
                &[&lease_uuid, &ASIC_LEASE_STATUS_STOCK],
            )
            .await?;
        set_instance_lease_state(client, lease_uuid, ASIC_LEASE_STATUS_STOCK, None, None).await?;
    }
    if !sync_item.is_empty() {
        sync_timed_asic_stock_for_item(client, user_id, &sync_item, now_ms).await?;
    }
    Ok(true)
}

pub async fn release_equipped_asic_lease<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
    now_ms: i64,
) -> anyhow::Result<()> {
    let uid = pg_user_id(user_id)?;
    let si = i32::try_from(slot_index).unwrap_or(0);
    let slot_rows = client
        .query(
            "SELECT machine_item_id, machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2",
            &[&rack_id, &si],
        )
        .await?;
    let slot = slot_rows.first();
    let mut lease_id = slot.and_then(|r| row_uuid_string(r, "machine_lease_id"));
    let item_id = slot
        .and_then(|r| {
            r.try_get::<_, Option<String>>("machine_item_id")
                .ok()
                .flatten()
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    if lease_id.is_none() {
        let existing = client
            .query(
                "SELECT id FROM player_asic_leases
                 WHERE user_id = $1 AND status = $2 AND rack_id = $3 AND slot_index = $4 AND expires_at > $5
                 LIMIT 1",
                &[&uid, &ASIC_LEASE_STATUS_EQUIPPED, &rack_id, &si, &now_ms],
            )
            .await?;
        lease_id = existing.first().and_then(|r| row_uuid_string(r, "id"));
    }

    if !item_id.is_empty() || lease_id.is_some() {
        let lid = lease_id.clone();
        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_MINER_UNEQUIPPED,
                at_ms: now_ms,
                identity_kind: if lid.is_some() {
                    IDENTITY_LEASE
                } else {
                    IDENTITY_PLACEMENT
                },
                lease_id: lid.as_deref(),
                rack_id: Some(rack_id),
                slot_index: Some(slot_index),
                catalog_item_id: if item_id.is_empty() {
                    None
                } else {
                    Some(&item_id)
                },
                coin_id: None,
                payload: Some(serde_json::json!({ "reason": "unequip" })),
            },
        )
        .await?;
    }

    client
        .execute(
            "UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL WHERE rack_id = $1 AND slot_index = $2",
            &[&rack_id, &si],
        )
        .await?;

    let Some(lease_id) = lease_id else {
        return Ok(());
    };
    let lease_uuid = bind_uuid(&lease_id)?;
    let lease_rows = client
        .query(
            "SELECT id, item_id, expires_at, acquired_at, status FROM player_asic_leases WHERE id = $1 AND user_id = $2",
            &[&lease_uuid, &uid],
        )
        .await?;
    let Some(lease) = lease_rows.first() else {
        return Ok(());
    };
    let expires_at: i64 = lease.try_get("expires_at").unwrap_or(0);
    let acquired_at: i64 = lease.try_get("acquired_at").unwrap_or(0);
    let status: String = lease.try_get("status").unwrap_or_default();
    let lease_item: String = lease.try_get("item_id").unwrap_or_default();
    if expires_at <= now_ms {
        let sync = if item_id.is_empty() {
            lease_item.trim().to_string()
        } else {
            item_id.clone()
        };
        soft_expire_lease_row(
            client,
            user_id,
            &lease_id,
            &sync,
            now_ms,
            acquired_at,
            expires_at,
            &status,
            Some(rack_id),
            Some(slot_index),
        )
        .await?;
    } else {
        client
            .execute(
                "UPDATE player_asic_leases SET status = $2, rack_id = NULL, slot_index = NULL WHERE id = $1",
                &[&lease_uuid, &ASIC_LEASE_STATUS_STOCK],
            )
            .await?;
        set_instance_lease_state(client, lease_uuid, ASIC_LEASE_STATUS_STOCK, None, None).await?;
    }
    if !item_id.is_empty() {
        sync_timed_asic_stock_for_item(client, user_id, &item_id, now_ms).await?;
    }
    Ok(())
}

pub async fn release_all_equipped_leases_on_rack<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    repair_equipped_asic_leases_for_rack(client, user_id, rack_id, now_ms).await?;
    let uid = pg_user_id(user_id)?;
    let slots = client
        .query(
            "SELECT slot_index, machine_item_id, machine_lease_id FROM rack_slots
             WHERE rack_id = $1 AND machine_item_id IS NOT NULL ORDER BY slot_index",
            &[&rack_id],
        )
        .await?;
    let mut affected: HashSet<String> = HashSet::new();
    for row in slots {
        let si: i32 = row.try_get("slot_index").unwrap_or(0);
        let item_id: String = row
            .try_get::<_, Option<String>>("machine_item_id")
            .ok()
            .flatten()
            .unwrap_or_default()
            .trim()
            .to_string();
        let mut lease_id = row_uuid_string(&row, "machine_lease_id");
        if lease_id.is_none() {
            let existing = client
                .query(
                    "SELECT id FROM player_asic_leases
                     WHERE user_id = $1 AND status = $2 AND rack_id = $3 AND slot_index = $4 AND expires_at > $5
                     LIMIT 1",
                    &[&uid, &ASIC_LEASE_STATUS_EQUIPPED, &rack_id, &si, &now_ms],
                )
                .await?;
            lease_id = existing.first().and_then(|r| row_uuid_string(r, "id"));
        }
        if let Some(lid) = lease_id {
            release_equipped_asic_lease_by_id(client, user_id, &lid, &item_id, now_ms).await?;
        } else {
            release_equipped_asic_lease(client, user_id, rack_id, i64::from(si), now_ms).await?;
        }
        if !item_id.is_empty() {
            affected.insert(item_id);
        }
    }

    let orphans = client
        .query(
            "SELECT id, item_id FROM player_asic_leases
             WHERE user_id = $1 AND rack_id = $2 AND status = $3 AND expires_at > $4",
            &[&uid, &rack_id, &ASIC_LEASE_STATUS_EQUIPPED, &now_ms],
        )
        .await?;
    for row in orphans {
        let id = row_uuid_string(&row, "id").unwrap_or_default();
        let item_id: String = row.try_get("item_id").unwrap_or_default();
        release_equipped_asic_lease_by_id(client, user_id, &id, &item_id, now_ms).await?;
        let sync = item_id.trim();
        if !sync.is_empty() {
            affected.insert(sync.to_string());
        }
    }
    for item_id in affected {
        sync_timed_asic_stock_for_item(client, user_id, &item_id, now_ms).await?;
    }
    Ok(())
}

pub async fn resolve_equipped_lease_id_for_slot<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    slot_index: i64,
    slot_lease_id_hint: &str,
    now_ms: i64,
) -> anyhow::Result<String> {
    let uid = pg_user_id(user_id)?;
    let si = i32::try_from(slot_index).unwrap_or(0);
    let hint = slot_lease_id_hint.trim();
    if !hint.is_empty() {
        if let Ok(hint_uuid) = bind_uuid(hint) {
            let hint_rows = client
                .query(
                    "SELECT id FROM player_asic_leases
                     WHERE id = $1 AND user_id = $2 AND status = $3 AND expires_at > $4",
                    &[&hint_uuid, &uid, &ASIC_LEASE_STATUS_EQUIPPED, &now_ms],
                )
                .await?;
            if let Some(id) = hint_rows.first().and_then(|r| row_uuid_string(r, "id")) {
                return Ok(id);
            }
        }
    }

    let slot_rows = client
        .query(
            "SELECT machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2",
            &[&rack_id, &si],
        )
        .await?;
    if let Some(id) = slot_rows
        .first()
        .and_then(|r| row_uuid_string(r, "machine_lease_id"))
    {
        return Ok(id);
    }

    repair_equipped_asic_leases_for_rack(client, user_id, rack_id, now_ms).await?;
    let after = client
        .query(
            "SELECT machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2",
            &[&rack_id, &si],
        )
        .await?;
    if let Some(id) = after
        .first()
        .and_then(|r| row_uuid_string(r, "machine_lease_id"))
    {
        return Ok(id);
    }

    let existing = client
        .query(
            "SELECT id FROM player_asic_leases
             WHERE user_id = $1 AND status = $2 AND rack_id = $3 AND slot_index = $4 AND expires_at > $5
             LIMIT 1",
            &[&uid, &ASIC_LEASE_STATUS_EQUIPPED, &rack_id, &si, &now_ms],
        )
        .await?;
    Ok(existing
        .first()
        .and_then(|r| row_uuid_string(r, "id"))
        .unwrap_or_default())
}

pub async fn clear_rack_slot_machine<C: GenericClient>(
    client: &C,
    rack_id: &str,
    slot_index: i64,
) -> anyhow::Result<()> {
    let si = i32::try_from(slot_index).unwrap_or(0);
    client
        .execute(
            "UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL WHERE rack_id = $1 AND slot_index = $2",
            &[&rack_id, &si],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_valid_asics_error_matches_node() {
        assert_eq!(
            ERR_NO_VALID_ASICS,
            "No valid ASICs in stock (expired or sold out)."
        );
    }

    #[test]
    fn listed_status_and_expire_sql_include_listed() {
        assert_eq!(ASIC_LEASE_STATUS_LISTED, "listed");
        assert!(EXPIRE_SELECT_SQL.contains("status IN ($3, $4, $5)"));
        assert!(EXPIRE_SELECT_SQL.contains("FOR UPDATE"));
        assert!(EXPIRE_SELECT_SQL.contains("ORDER BY id"));
        assert!(EXPIRE_LOCK_INSTANCES_SQL.contains("item_instances"));
        assert!(EXPIRE_LOCK_INSTANCES_SQL.contains("ORDER BY id"));
        assert!(EXPIRE_LOCK_INSTANCES_SQL.contains("FOR UPDATE"));
        assert!(!EXPIRE_LOCK_INSTANCES_SQL.contains("player_listings"));
        assert!(EXPIRE_UPDATE_SQL.contains("status IN ($3, $4, $5)"));
        assert!(SOFT_EXPIRE_UPDATE_SQL.contains("status IN ($4, $5, $6)"));
        assert!(!EXPIRE_SELECT_SQL.contains("DELETE"));
        assert!(!EXPIRE_UPDATE_SQL.contains("player_listings"));
        assert!(!SOFT_EXPIRE_UPDATE_SQL.contains("player_listings"));
    }
}
