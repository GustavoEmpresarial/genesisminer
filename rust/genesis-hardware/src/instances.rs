//! Per-unit item identity (`item_instances`).
//!
//! `stock.qty` is the denormalized count (UI / hot path). Each physical unit
//! has a UUID row. Timed ASICs reuse `player_asic_leases.id`.

use deadpool_postgres::GenericClient;
use tokio_postgres::Row;

use crate::adjust::INSUFFICIENT_STOCK;
use crate::leases::{
    row_uuid_string, ASIC_LEASE_STATUS_EQUIPPED, ASIC_LEASE_STATUS_EXPIRED, ASIC_LEASE_STATUS_STOCK,
};
use crate::pg_types::{pg_limit, pg_qty, pg_user_id};

/// Same strings as `ASIC_LEASE_STATUS_*` where they overlap.
pub const ITEM_INSTANCE_STATUS_STOCK: &str = ASIC_LEASE_STATUS_STOCK;
pub const ITEM_INSTANCE_STATUS_EQUIPPED: &str = ASIC_LEASE_STATUS_EQUIPPED;
pub const ITEM_INSTANCE_STATUS_EXPIRED: &str = ASIC_LEASE_STATUS_EXPIRED;
/// P2P listing (`player_listing_instances` + `POST /v1/hardware/p2p-instances`).
pub const ITEM_INSTANCE_STATUS_LISTED: &str = "listed";
/// Merge / debit — row is kept for audit (never DELETE).
pub const ITEM_INSTANCE_STATUS_CONSUMED: &str = "consumed";

/// Prisma `item_instances.catalog_item_id` `@db.VarChar(200)`.
pub const ITEM_INSTANCE_CATALOG_ID_MAX_LEN: usize = 200;
/// RFC 4122 hyphenated lowercase UUID text (`uuid` crate Display / `crypto.randomUUID()`).
pub const UUID_HYPHENATED_TEXT_LEN: usize = 36;
/// Separator between catalog SKU and unit UUID in `item_instances.code`.
pub const ITEM_INSTANCE_CODE_SEP: char = ':';
/// Prisma `item_instances.code` `@db.VarChar(237)` = catalog(200) + sep + uuid(36).
pub const ITEM_INSTANCE_CODE_MAX_LEN: usize =
    ITEM_INSTANCE_CATALOG_ID_MAX_LEN + 1 + UUID_HYPHENATED_TEXT_LEN;
/// Prisma `item_instances.status` `@db.VarChar(32)`.
pub const ITEM_INSTANCE_STATUS_MAX_LEN: usize = 32;
/// Prisma `item_instances.rack_id` `@db.VarChar(120)`.
pub const ITEM_INSTANCE_RACK_ID_MAX_LEN: usize = 120;

/// `{catalog}{SEP}{id}` — `id` Display is hyphenated lowercase (RFC 4122).
pub fn instance_code(catalog: &str, id: uuid::Uuid) -> String {
    format!("{catalog}{ITEM_INSTANCE_CODE_SEP}{id}")
}

pub(crate) const MINT_INSTANCE_SQL: &str =
    "INSERT INTO item_instances (id, code, catalog_item_id, user_id, status, rack_id, slot_index)
                 VALUES ($1, $2, $3, $4, $5, NULL, NULL)";

pub(crate) const MINT_INSTANCE_WITH_ID_SQL: &str =
    "INSERT INTO item_instances (id, code, catalog_item_id, user_id, status, rack_id, slot_index)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO NOTHING";

pub(crate) const CONSUME_STOCK_INSTANCES_SQL: &str = "UPDATE item_instances
                 SET status = $4
                 WHERE id IN (
                   SELECT id FROM item_instances
                    WHERE user_id = $1 AND catalog_item_id = $2 AND status = $5
                    ORDER BY created_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT $3
                 )";

pub(crate) const COUNT_STOCK_INSTANCES_SQL: &str = "SELECT COUNT(*)::int AS n FROM item_instances
              WHERE user_id = $1 AND catalog_item_id = $2 AND status = $3";

pub(crate) const SELECT_LEASES_FOR_INSTANCE_SYNC_SQL: &str =
    "SELECT id, status, rack_id, slot_index FROM player_asic_leases WHERE user_id = $1 AND item_id = $2";

pub(crate) const SET_INSTANCE_LEASE_STATE_SQL: &str =
    "UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1";

/// After lease DELETE (timed trim): keep the row, mark leftover stock units consumed.
pub(crate) const CONSUME_ORPHAN_STOCK_INSTANCES_SQL: &str = "UPDATE item_instances
                 SET status = $3
                 WHERE user_id = $1 AND catalog_item_id = $2 AND status = $4
                   AND NOT EXISTS (
                     SELECT 1 FROM player_asic_leases l WHERE l.id = item_instances.id
                   )";

fn catalog_item_id_ok(catalog_item_id: &str) -> anyhow::Result<Option<&str>> {
    let trimmed = catalog_item_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > ITEM_INSTANCE_CATALOG_ID_MAX_LEN {
        anyhow::bail!(
            "catalog_item_id exceeds ITEM_INSTANCE_CATALOG_ID_MAX_LEN ({ITEM_INSTANCE_CATALOG_ID_MAX_LEN})"
        );
    }
    Ok(Some(trimmed))
}

fn status_ok(status: &str) -> anyhow::Result<&str> {
    if status.len() > ITEM_INSTANCE_STATUS_MAX_LEN {
        anyhow::bail!(
            "status exceeds ITEM_INSTANCE_STATUS_MAX_LEN ({ITEM_INSTANCE_STATUS_MAX_LEN})"
        );
    }
    Ok(status)
}

fn rack_id_bind(rack_id: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(raw) = rack_id else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > ITEM_INSTANCE_RACK_ID_MAX_LEN {
        anyhow::bail!(
            "rack_id exceeds ITEM_INSTANCE_RACK_ID_MAX_LEN ({ITEM_INSTANCE_RACK_ID_MAX_LEN})"
        );
    }
    Ok(Some(trimmed.to_string()))
}

/// Mint `qty` new UUID rows. Skip `qty <= 0`.
pub async fn mint_instances<C: GenericClient>(
    client: &C,
    user_id: i64,
    catalog_item_id: &str,
    qty: i64,
    status: &str,
) -> anyhow::Result<()> {
    if qty <= 0 {
        return Ok(());
    }
    let Some(catalog) = catalog_item_id_ok(catalog_item_id)? else {
        return Ok(());
    };
    let status = status_ok(status)?;
    let uid = pg_user_id(user_id)?;
    let n = pg_qty(qty)?;
    for _ in 0..n {
        let id = uuid::Uuid::new_v4();
        let code = instance_code(catalog, id);
        client
            .execute(MINT_INSTANCE_SQL, &[&id, &code, &catalog, &uid, &status])
            .await?;
    }
    Ok(())
}

/// Idempotent lease sync: same UUID as the lease, `ON CONFLICT (id) DO NOTHING`.
pub async fn mint_instance_with_id<C: GenericClient>(
    client: &C,
    id: uuid::Uuid,
    user_id: i64,
    catalog_item_id: &str,
    status: &str,
    rack_id: Option<&str>,
    slot_index: Option<i32>,
) -> anyhow::Result<()> {
    let Some(catalog) = catalog_item_id_ok(catalog_item_id)? else {
        return Ok(());
    };
    let status = status_ok(status)?;
    let uid = pg_user_id(user_id)?;
    let rack = rack_id_bind(rack_id)?;
    let code = instance_code(catalog, id);
    client
        .execute(
            MINT_INSTANCE_WITH_ID_SQL,
            &[&id, &code, &catalog, &uid, &status, &rack, &slot_index],
        )
        .await?;
    Ok(())
}

/// Mirror lease expire / equip / unequip onto the instance with the same UUID.
pub async fn set_instance_lease_state<C: GenericClient>(
    client: &C,
    id: uuid::Uuid,
    status: &str,
    rack_id: Option<&str>,
    slot_index: Option<i32>,
) -> anyhow::Result<()> {
    let status = status_ok(status)?;
    let rack = rack_id_bind(rack_id)?;
    client
        .execute(
            SET_INSTANCE_LEASE_STATE_SQL,
            &[&id, &status, &rack, &slot_index],
        )
        .await?;
    Ok(())
}

/// Mark the oldest `qty` stock-status rows `consumed` (audit). Never DELETE.
pub async fn consume_stock_instances<C: GenericClient>(
    client: &C,
    user_id: i64,
    catalog_item_id: &str,
    qty: i64,
) -> anyhow::Result<()> {
    if qty <= 0 {
        return Ok(());
    }
    let Some(catalog) = catalog_item_id_ok(catalog_item_id)? else {
        return Ok(());
    };
    let uid = pg_user_id(user_id)?;
    let n = pg_qty(qty)?;
    let affected = client
        .execute(
            CONSUME_STOCK_INSTANCES_SQL,
            &[
                &uid,
                &catalog,
                &pg_limit(n),
                &ITEM_INSTANCE_STATUS_CONSUMED,
                &ITEM_INSTANCE_STATUS_STOCK,
            ],
        )
        .await?;
    let need = u64::try_from(n).map_err(|_| anyhow::anyhow!("qty out of u64 range"))?;
    if affected != need {
        return Err(anyhow::anyhow!(
            "{INSUFFICIENT_STOCK}: instances user={user_id} item={catalog} have={affected} need={need}"
        ));
    }
    Ok(())
}

async fn count_stock_instances<C: GenericClient>(
    client: &C,
    uid: i32,
    catalog: &str,
) -> anyhow::Result<i32> {
    let rows = client
        .query(
            COUNT_STOCK_INSTANCES_SQL,
            &[&uid, &catalog, &ITEM_INSTANCE_STATUS_STOCK],
        )
        .await?;
    Ok(rows.first().map(|r| r.get("n")).unwrap_or(0))
}

fn lease_slot_index(row: &Row) -> Option<i32> {
    row.try_get::<_, Option<i32>>("slot_index").ok().flatten()
}

/// Align instances to `target_qty`.
///
/// If any `player_asic_leases` exist for user+item: sync one instance per lease
/// (same UUID + lease status) and consume orphans. `allow_qty_mint` is ignored.
///
/// If no leases and `allow_qty_mint` is false (timed SKUs / leftover qty 0):
/// consume orphans and, when `target_qty` is 0, consume leftover stock rows
/// down to 0. Never `mint_instances` from qty.
///
/// If no leases and `allow_qty_mint` is true (permanent): mint/consume to target.
///
/// Callers pass the bool — do not import duration/lease loaders here (cycle).
pub async fn reconcile_stock_instances_to_qty<C: GenericClient>(
    client: &C,
    user_id: i64,
    catalog_item_id: &str,
    target_qty: i64,
    allow_qty_mint: bool,
) -> anyhow::Result<()> {
    let Some(catalog) = catalog_item_id_ok(catalog_item_id)? else {
        return Ok(());
    };
    let uid = pg_user_id(user_id)?;
    let lease_rows = client
        .query(SELECT_LEASES_FOR_INSTANCE_SYNC_SQL, &[&uid, &catalog])
        .await?;
    if !lease_rows.is_empty() {
        for row in &lease_rows {
            let Some(id_str) = row_uuid_string(row, "id") else {
                continue;
            };
            let id = crate::leases::bind_uuid(&id_str)?;
            let status: String = row.try_get("status").unwrap_or_default();
            let rack: Option<String> = row.try_get("rack_id").ok().flatten();
            let slot = lease_slot_index(row);
            mint_instance_with_id(client, id, user_id, catalog, &status, rack.as_deref(), slot)
                .await?;
            set_instance_lease_state(client, id, &status, rack.as_deref(), slot).await?;
        }
        consume_orphan_stock_instances(client, uid, catalog).await?;
        return Ok(());
    }

    if !allow_qty_mint {
        consume_orphan_stock_instances(client, uid, catalog).await?;
        let target = pg_qty(target_qty.max(0))?;
        if target == 0 {
            let current = count_stock_instances(client, uid, catalog).await?;
            if current > 0 {
                consume_stock_instances(client, user_id, catalog, i64::from(current)).await?;
            }
        }
        return Ok(());
    }

    let target = pg_qty(target_qty.max(0))?;
    let current = count_stock_instances(client, uid, catalog).await?;
    if current < target {
        mint_instances(
            client,
            user_id,
            catalog,
            i64::from(target - current),
            ITEM_INSTANCE_STATUS_STOCK,
        )
        .await?;
    } else if current > target {
        consume_stock_instances(client, user_id, catalog, i64::from(current - target)).await?;
    }
    Ok(())
}

async fn consume_orphan_stock_instances<C: GenericClient>(
    client: &C,
    uid: i32,
    catalog: &str,
) -> anyhow::Result<()> {
    client
        .execute(
            CONSUME_ORPHAN_STOCK_INSTANCES_SQL,
            &[
                &uid,
                &catalog,
                &ITEM_INSTANCE_STATUS_CONSUMED,
                &ITEM_INSTANCE_STATUS_STOCK,
            ],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_strings_match_leases_and_prisma_overlap() {
        assert_eq!(ITEM_INSTANCE_STATUS_STOCK, ASIC_LEASE_STATUS_STOCK);
        assert_eq!(ITEM_INSTANCE_STATUS_EQUIPPED, ASIC_LEASE_STATUS_EQUIPPED);
        assert_eq!(ITEM_INSTANCE_STATUS_EXPIRED, ASIC_LEASE_STATUS_EXPIRED);
        assert_eq!(ITEM_INSTANCE_STATUS_STOCK, "stock");
        assert_eq!(ITEM_INSTANCE_STATUS_EQUIPPED, "equipped");
        assert_eq!(ITEM_INSTANCE_STATUS_EXPIRED, "expired");
        assert_eq!(ITEM_INSTANCE_STATUS_LISTED, "listed");
        assert_eq!(ITEM_INSTANCE_STATUS_CONSUMED, "consumed");
        assert_eq!(ITEM_INSTANCE_STATUS_STOCK.len(), 5);
        assert!(ITEM_INSTANCE_STATUS_STOCK.len() <= ITEM_INSTANCE_STATUS_MAX_LEN);
        assert!(ITEM_INSTANCE_STATUS_EQUIPPED.len() <= ITEM_INSTANCE_STATUS_MAX_LEN);
        assert!(ITEM_INSTANCE_STATUS_EXPIRED.len() <= ITEM_INSTANCE_STATUS_MAX_LEN);
        assert!(ITEM_INSTANCE_STATUS_LISTED.len() <= ITEM_INSTANCE_STATUS_MAX_LEN);
        assert!(ITEM_INSTANCE_STATUS_CONSUMED.len() <= ITEM_INSTANCE_STATUS_MAX_LEN);
    }

    #[test]
    fn prisma_varchar_lens() {
        assert_eq!(ITEM_INSTANCE_CATALOG_ID_MAX_LEN, 200);
        assert_eq!(UUID_HYPHENATED_TEXT_LEN, 36);
        assert_eq!(ITEM_INSTANCE_CODE_SEP, ':');
        assert_eq!(ITEM_INSTANCE_STATUS_MAX_LEN, 32);
        assert_eq!(ITEM_INSTANCE_RACK_ID_MAX_LEN, 120);
        assert_eq!(
            ITEM_INSTANCE_CODE_MAX_LEN,
            ITEM_INSTANCE_CATALOG_ID_MAX_LEN + 1 + UUID_HYPHENATED_TEXT_LEN
        );
        assert_eq!(ITEM_INSTANCE_CODE_MAX_LEN, 237);
    }

    #[test]
    fn instance_code_format_is_catalog_sep_hyphenated_uuid() {
        let id = uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(
            instance_code("asic_dolar_f2p", id),
            "asic_dolar_f2p:550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(id.to_string().len(), UUID_HYPHENATED_TEXT_LEN);
        let max_catalog = "a".repeat(ITEM_INSTANCE_CATALOG_ID_MAX_LEN);
        assert_eq!(
            instance_code(&max_catalog, id).len(),
            ITEM_INSTANCE_CODE_MAX_LEN
        );
    }

    #[test]
    fn mint_sql_targets_item_instances() {
        assert!(MINT_INSTANCE_SQL.contains("item_instances"));
        assert!(MINT_INSTANCE_SQL.contains("code"));
        assert!(MINT_INSTANCE_WITH_ID_SQL.contains("item_instances"));
        assert!(MINT_INSTANCE_WITH_ID_SQL.contains("code"));
        assert!(MINT_INSTANCE_WITH_ID_SQL.contains("ON CONFLICT (id) DO NOTHING"));
        assert!(!MINT_INSTANCE_SQL.to_ascii_lowercase().contains("delete"));
        assert!(!MINT_INSTANCE_SQL.contains("serial"));
        assert!(!MINT_INSTANCE_WITH_ID_SQL.contains("serial"));
    }

    #[test]
    fn consume_sets_consumed_not_delete() {
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("item_instances"));
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("SET status"));
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("ORDER BY created_at, id"));
        assert!(!CONSUME_STOCK_INSTANCES_SQL.contains("serial"));
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("LIMIT $3"));
        assert!(
            !CONSUME_STOCK_INSTANCES_SQL.contains("LIMIT $3::int"),
            "LIMIT binds INT8 via pg_limit; no ::int cast"
        );
        assert!(!CONSUME_STOCK_INSTANCES_SQL
            .to_ascii_lowercase()
            .contains("delete"));
        assert_eq!(ITEM_INSTANCE_STATUS_CONSUMED, "consumed");
    }

    #[test]
    fn timed_reconcile_syncs_lease_ids_without_qty_mint() {
        assert!(SELECT_LEASES_FOR_INSTANCE_SYNC_SQL.contains("player_asic_leases"));
        assert!(!SELECT_LEASES_FOR_INSTANCE_SYNC_SQL.contains("generate_series"));
        assert!(!SELECT_LEASES_FOR_INSTANCE_SYNC_SQL.contains("gen_random_uuid"));
        assert!(MINT_INSTANCE_WITH_ID_SQL.contains("ON CONFLICT (id) DO NOTHING"));
        assert!(
            !SELECT_LEASES_FOR_INSTANCE_SYNC_SQL.contains("stock.qty"),
            "timed path must not mint/consume by qty"
        );
        assert!(CONSUME_ORPHAN_STOCK_INSTANCES_SQL.contains("player_asic_leases"));
        assert!(!CONSUME_ORPHAN_STOCK_INSTANCES_SQL
            .to_ascii_lowercase()
            .contains("delete"));
        assert!(!CONSUME_ORPHAN_STOCK_INSTANCES_SQL.contains("generate_series"));
        assert!(!CONSUME_ORPHAN_STOCK_INSTANCES_SQL.contains("gen_random_uuid"));
    }

    #[test]
    fn no_qty_mint_path_only_consumes_orphans_or_target_zero() {
        assert!(CONSUME_ORPHAN_STOCK_INSTANCES_SQL.contains("NOT EXISTS"));
        assert!(CONSUME_STOCK_INSTANCES_SQL.contains("SET status"));
        assert!(!CONSUME_STOCK_INSTANCES_SQL.contains("generate_series"));
        assert!(!CONSUME_STOCK_INSTANCES_SQL.contains("gen_random_uuid"));
    }
}
