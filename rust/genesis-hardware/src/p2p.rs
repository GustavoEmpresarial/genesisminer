//! Move the **same** `item_instances` row on P2P list / unlist / transfer.
//!
//! `POST /v1/hardware/p2p-instances`. Debits `stock.qty` on list; credits qty
//! on unlist / buyer transfer **without** minting. Never `consume_stock_instances`,
//! never `reconcile_timed_asic_stock_leases`, never locks `game_states`.
//! Timeouts: `HARDWARE_TX_TIMEOUT_MS` only.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::GenericClient;
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;

use crate::adjust::INSUFFICIENT_STOCK;
use crate::config::HARDWARE_TX_TIMEOUT_MS;
use crate::instances::{
    instance_code, ITEM_INSTANCE_CATALOG_ID_MAX_LEN, ITEM_INSTANCE_STATUS_EXPIRED,
    ITEM_INSTANCE_STATUS_LISTED, ITEM_INSTANCE_STATUS_STOCK,
};
use crate::leases::{
    bind_uuid, ASIC_LEASE_STATUS_EXPIRED, ASIC_LEASE_STATUS_LISTED, ASIC_LEASE_STATUS_STOCK,
};
use crate::pg_types::{pg_limit, pg_qty, pg_user_id};

/// Node `HARDWARE_P2P_INSTANCES_PATH`.
pub const P2P_INSTANCES_PATH: &str = "/v1/hardware/p2p-instances";

pub const P2P_OP_LIST: &str = "list";
pub const P2P_OP_UNLIST: &str = "unlist";
pub const P2P_OP_TRANSFER: &str = "transfer";

const LIST_DEBIT_SELECT_SQL: &str =
    "SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2 FOR UPDATE";
const LIST_DEBIT_UPDATE_SQL: &str =
    "UPDATE stock SET qty = qty - $3 WHERE user_id = $1 AND item_id = $2 AND qty >= $3 RETURNING qty";
const LIST_DEBIT_DELETE_SQL: &str = "DELETE FROM stock WHERE user_id = $1 AND item_id = $2";

const LIST_INSTANCES_SQL: &str = "UPDATE item_instances
                 SET status = $4, rack_id = NULL, slot_index = NULL
                 WHERE id IN (
                   SELECT id FROM item_instances
                    WHERE user_id = $1 AND catalog_item_id = $2 AND status = $5
                    ORDER BY created_at, id
                    FOR UPDATE
                    LIMIT $3
                 )
                 RETURNING id";

const MARK_LEASE_LISTED_SQL: &str = "UPDATE player_asic_leases SET status = $2 WHERE id = $1";

const SELECT_INSTANCE_FOR_P2P_SQL: &str =
    "SELECT id, user_id, catalog_item_id, status FROM item_instances WHERE id = $1 FOR UPDATE";

const UNLIST_INSTANCE_SQL: &str = "UPDATE item_instances
                 SET status = $2, rack_id = NULL, slot_index = NULL
                 WHERE id = $1 AND user_id = $3 AND catalog_item_id = $4 AND status = $5";

const UNLIST_LEASE_SQL: &str =
    "UPDATE player_asic_leases SET status = $2 WHERE id = $1 AND status = $3";

const TRANSFER_INSTANCE_SQL: &str = "UPDATE item_instances
                 SET user_id = $2, status = $3, rack_id = NULL, slot_index = NULL
                 WHERE id = $1 AND user_id = $4 AND catalog_item_id = $5 AND status = $6";

const TRANSFER_LEASE_LISTED_SQL: &str =
    "UPDATE player_asic_leases SET user_id = $2, status = $3 WHERE id = $1 AND status = $4";

const TRANSFER_LEASE_EXPIRED_SQL: &str =
    "UPDATE player_asic_leases SET user_id = $2 WHERE id = $1 AND status = $3";

const SELECT_LEASE_OWNER_SQL: &str = "SELECT user_id, status FROM player_asic_leases WHERE id = $1";

const CREDIT_STOCK_QTY_ONLY_SQL: &str =
    "INSERT INTO stock (user_id, item_id, qty) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty";

const SELECT_STOCK_QTY_SQL: &str = "SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2";

pub struct P2pInstancesInput<'a> {
    pub user_id: i64,
    pub item_id: &'a str,
    pub op: &'a str,
    pub qty: Option<i64>,
    pub to_user_id: Option<i64>,
    pub instance_ids: Option<&'a [String]>,
}

pub struct P2pInstancesOutcome {
    pub stock: HashMap<String, i64>,
    pub instance_ids: Vec<String>,
    pub codes: Vec<String>,
}

fn insufficient_stock_err(detail: &str) -> anyhow::Error {
    anyhow::anyhow!("{INSUFFICIENT_STOCK}: {detail}")
}

async fn set_hardware_tx_timeouts<C: GenericClient>(client: &C) -> anyhow::Result<()> {
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
    Ok(())
}

fn catalog_item_id(raw: &str) -> anyhow::Result<String> {
    let item_id = normalize_known_1000wh_battery_catalog_id(Some(raw));
    if item_id.is_empty() {
        anyhow::bail!("itemId empty");
    }
    if item_id.len() > ITEM_INSTANCE_CATALOG_ID_MAX_LEN {
        anyhow::bail!(
            "catalog_item_id exceeds ITEM_INSTANCE_CATALOG_ID_MAX_LEN ({ITEM_INSTANCE_CATALOG_ID_MAX_LEN})"
        );
    }
    Ok(item_id)
}

fn parse_instance_ids(raw: Option<&[String]>) -> anyhow::Result<Vec<uuid::Uuid>> {
    let Some(ids) = raw else {
        anyhow::bail!("instanceIds required");
    };
    if ids.is_empty() {
        anyhow::bail!("instanceIds required");
    }
    let mut seen: HashSet<uuid::Uuid> = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    for raw_id in ids {
        let id = bind_uuid(raw_id)?;
        if !seen.insert(id) {
            anyhow::bail!("duplicate instanceId {raw_id}");
        }
        out.push(id);
    }
    Ok(out)
}

async fn stock_qty_after<C: GenericClient>(
    client: &C,
    uid_pg: i32,
    item_id: &str,
) -> anyhow::Result<i64> {
    let rows = client
        .query(SELECT_STOCK_QTY_SQL, &[&uid_pg, &item_id])
        .await?;
    Ok(rows
        .first()
        .map(|row| i64::from(row.get::<_, i32>("qty")))
        .unwrap_or(0))
}

async fn credit_stock_qty_only<C: GenericClient>(
    client: &C,
    uid_pg: i32,
    item_id: &str,
    qty: i32,
) -> anyhow::Result<()> {
    if qty <= 0 {
        return Ok(());
    }
    client
        .execute(CREDIT_STOCK_QTY_ONLY_SQL, &[&uid_pg, &item_id, &qty])
        .await?;
    Ok(())
}

/// Debit `stock.qty` only — no instance consume, no lease trim.
async fn debit_stock_qty_only<C: GenericClient>(
    client: &C,
    uid: i64,
    item_id: &str,
    need: i32,
) -> anyhow::Result<i32> {
    let uid_pg = pg_user_id(uid)?;
    let rows = client
        .query(LIST_DEBIT_SELECT_SQL, &[&uid_pg, &item_id])
        .await?;
    let have: i32 = match rows.first() {
        Some(row) => row.get("qty"),
        None => {
            return Err(insufficient_stock_err(&format!(
                "no row user={uid} item={item_id} need={need}"
            )));
        }
    };
    if have < need {
        return Err(insufficient_stock_err(&format!(
            "user={uid} item={item_id} have={have} need={need}"
        )));
    }
    let updated = client
        .query(LIST_DEBIT_UPDATE_SQL, &[&uid_pg, &item_id, &need])
        .await?;
    let after: i32 = match updated.first() {
        Some(row) => row.get("qty"),
        None => {
            return Err(insufficient_stock_err(&format!(
                "update missed user={uid} item={item_id} need={need}"
            )));
        }
    };
    if after == 0 {
        client
            .execute(LIST_DEBIT_DELETE_SQL, &[&uid_pg, &item_id])
            .await?;
    }
    Ok(after)
}

async fn op_list<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    qty: i64,
) -> anyhow::Result<P2pInstancesOutcome> {
    if qty < 1 {
        anyhow::bail!("qty required (>= 1)");
    }
    let need = pg_qty(qty)?;
    debit_stock_qty_only(client, user_id, item_id, need).await?;
    let uid_pg = pg_user_id(user_id)?;
    let rows = client
        .query(
            LIST_INSTANCES_SQL,
            &[
                &uid_pg,
                &item_id,
                &pg_limit(need),
                &ITEM_INSTANCE_STATUS_LISTED,
                &ITEM_INSTANCE_STATUS_STOCK,
            ],
        )
        .await?;
    let affected = rows.len();
    let need_usize =
        usize::try_from(need).map_err(|_| anyhow::anyhow!("qty out of usize range"))?;
    if affected != need_usize {
        return Err(insufficient_stock_err(&format!(
            "instances user={user_id} item={item_id} have={affected} need={need}"
        )));
    }
    let mut instance_ids = Vec::with_capacity(affected);
    let mut codes = Vec::with_capacity(affected);
    for row in &rows {
        let id: uuid::Uuid = row.get("id");
        client
            .execute(MARK_LEASE_LISTED_SQL, &[&id, &ASIC_LEASE_STATUS_LISTED])
            .await?;
        instance_ids.push(id.to_string());
        codes.push(instance_code(item_id, id));
    }
    let mut stock = HashMap::new();
    stock.insert(
        item_id.to_string(),
        stock_qty_after(client, uid_pg, item_id).await?,
    );
    Ok(P2pInstancesOutcome {
        stock,
        instance_ids,
        codes,
    })
}

async fn load_p2p_owned<C: GenericClient>(
    client: &C,
    id: uuid::Uuid,
    user_id: i64,
    item_id: &str,
) -> anyhow::Result<String> {
    let uid_pg = pg_user_id(user_id)?;
    let rows = client.query(SELECT_INSTANCE_FOR_P2P_SQL, &[&id]).await?;
    let Some(row) = rows.first() else {
        anyhow::bail!("instance {id} not found");
    };
    let owner: i32 = row.get("user_id");
    let catalog: String = row.get("catalog_item_id");
    let status: String = row.get("status");
    if owner != uid_pg || catalog != item_id {
        anyhow::bail!(
            "instance {id} not owned for user={user_id} item={item_id} (owner={owner} catalog={catalog} status={status})"
        );
    }
    if status != ITEM_INSTANCE_STATUS_LISTED && status != ITEM_INSTANCE_STATUS_EXPIRED {
        anyhow::bail!(
            "instance {id} not listed/expired for user={user_id} item={item_id} (status={status})"
        );
    }
    Ok(status)
}

async fn confirm_expired_lease_owner<C: GenericClient>(
    client: &C,
    id: uuid::Uuid,
    uid_pg: i32,
) -> anyhow::Result<()> {
    let rows = client.query(SELECT_LEASE_OWNER_SQL, &[&id]).await?;
    let Some(row) = rows.first() else {
        return Ok(());
    };
    let owner: i32 = row.get("user_id");
    if owner != uid_pg {
        anyhow::bail!("lease {id} owner mismatch (have={owner} need={uid_pg})");
    }
    Ok(())
}

async fn op_unlist<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    instance_ids: &[uuid::Uuid],
) -> anyhow::Result<P2pInstancesOutcome> {
    let uid_pg = pg_user_id(user_id)?;
    let mut out_ids = Vec::with_capacity(instance_ids.len());
    let mut codes = Vec::with_capacity(instance_ids.len());
    let mut listed_n: i32 = 0;
    for id in instance_ids {
        let status = load_p2p_owned(client, *id, user_id, item_id).await?;
        if status == ITEM_INSTANCE_STATUS_LISTED {
            let n = client
                .execute(
                    UNLIST_INSTANCE_SQL,
                    &[
                        id,
                        &ITEM_INSTANCE_STATUS_STOCK,
                        &uid_pg,
                        &item_id,
                        &ITEM_INSTANCE_STATUS_LISTED,
                    ],
                )
                .await?;
            if n != 1 {
                anyhow::bail!("instance {id} unlist missed");
            }
            client
                .execute(
                    UNLIST_LEASE_SQL,
                    &[id, &ASIC_LEASE_STATUS_STOCK, &ASIC_LEASE_STATUS_LISTED],
                )
                .await?;
            listed_n = listed_n
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("listed count overflow"))?;
        } else {
            confirm_expired_lease_owner(client, *id, uid_pg).await?;
        }
        out_ids.push(id.to_string());
        codes.push(instance_code(item_id, *id));
    }
    credit_stock_qty_only(client, uid_pg, item_id, listed_n).await?;
    let mut stock = HashMap::new();
    stock.insert(
        item_id.to_string(),
        stock_qty_after(client, uid_pg, item_id).await?,
    );
    Ok(P2pInstancesOutcome {
        stock,
        instance_ids: out_ids,
        codes,
    })
}

async fn op_transfer<C: GenericClient>(
    client: &C,
    seller_id: i64,
    to_user_id: i64,
    item_id: &str,
    instance_ids: &[uuid::Uuid],
) -> anyhow::Result<P2pInstancesOutcome> {
    let seller_pg = pg_user_id(seller_id)?;
    let buyer_pg = pg_user_id(to_user_id)?;
    let mut out_ids = Vec::with_capacity(instance_ids.len());
    let mut codes = Vec::with_capacity(instance_ids.len());
    let mut listed_n: i32 = 0;
    for id in instance_ids {
        let status = load_p2p_owned(client, *id, seller_id, item_id).await?;
        if status == ITEM_INSTANCE_STATUS_LISTED {
            let n = client
                .execute(
                    TRANSFER_INSTANCE_SQL,
                    &[
                        id,
                        &buyer_pg,
                        &ITEM_INSTANCE_STATUS_STOCK,
                        &seller_pg,
                        &item_id,
                        &ITEM_INSTANCE_STATUS_LISTED,
                    ],
                )
                .await?;
            if n != 1 {
                anyhow::bail!("instance {id} transfer missed");
            }
            client
                .execute(
                    TRANSFER_LEASE_LISTED_SQL,
                    &[
                        id,
                        &buyer_pg,
                        &ASIC_LEASE_STATUS_STOCK,
                        &ASIC_LEASE_STATUS_LISTED,
                    ],
                )
                .await?;
            listed_n = listed_n
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("listed count overflow"))?;
        } else {
            let n = client
                .execute(
                    TRANSFER_INSTANCE_SQL,
                    &[
                        id,
                        &buyer_pg,
                        &ITEM_INSTANCE_STATUS_EXPIRED,
                        &seller_pg,
                        &item_id,
                        &ITEM_INSTANCE_STATUS_EXPIRED,
                    ],
                )
                .await?;
            if n != 1 {
                anyhow::bail!("instance {id} transfer expired missed");
            }
            client
                .execute(
                    TRANSFER_LEASE_EXPIRED_SQL,
                    &[id, &buyer_pg, &ASIC_LEASE_STATUS_EXPIRED],
                )
                .await?;
        }
        out_ids.push(id.to_string());
        codes.push(instance_code(item_id, *id));
    }
    credit_stock_qty_only(client, buyer_pg, item_id, listed_n).await?;
    let mut stock = HashMap::new();
    stock.insert(
        item_id.to_string(),
        stock_qty_after(client, buyer_pg, item_id).await?,
    );
    Ok(P2pInstancesOutcome {
        stock,
        instance_ids: out_ids,
        codes,
    })
}

/// Same ops as [`p2p_instances`], without `SET LOCAL` timeouts.
/// Market TX sets `BUY_LOCK_TIMEOUT_MS` (or max vs `HARDWARE_TX_TIMEOUT_MS`) first.
pub async fn p2p_instances_apply<C: GenericClient>(
    client: &C,
    input: P2pInstancesInput<'_>,
) -> anyhow::Result<P2pInstancesOutcome> {
    let item_id = catalog_item_id(input.item_id)?;
    let op = input.op.trim().to_ascii_lowercase();
    match op.as_str() {
        P2P_OP_LIST => {
            let qty = input
                .qty
                .ok_or_else(|| anyhow::anyhow!("qty required (>= 1)"))?;
            op_list(client, input.user_id, &item_id, qty).await
        }
        P2P_OP_UNLIST => {
            let ids = parse_instance_ids(input.instance_ids)?;
            op_unlist(client, input.user_id, &item_id, &ids).await
        }
        P2P_OP_TRANSFER => {
            let to_user_id = input
                .to_user_id
                .ok_or_else(|| anyhow::anyhow!("toUserId required"))?;
            let ids = parse_instance_ids(input.instance_ids)?;
            op_transfer(client, input.user_id, to_user_id, &item_id, &ids).await
        }
        _ => anyhow::bail!("unknown p2p op"),
    }
}

/// Caller owns BEGIN/COMMIT. Sets `HARDWARE_TX_TIMEOUT_MS` only.
pub async fn p2p_instances<C: GenericClient>(
    client: &C,
    input: P2pInstancesInput<'_>,
) -> anyhow::Result<P2pInstancesOutcome> {
    set_hardware_tx_timeouts(client).await?;
    p2p_instances_apply(client, input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_sql() -> String {
        [
            LIST_DEBIT_SELECT_SQL,
            LIST_DEBIT_UPDATE_SQL,
            LIST_DEBIT_DELETE_SQL,
            LIST_INSTANCES_SQL,
            MARK_LEASE_LISTED_SQL,
            SELECT_INSTANCE_FOR_P2P_SQL,
            UNLIST_INSTANCE_SQL,
            UNLIST_LEASE_SQL,
            TRANSFER_INSTANCE_SQL,
            TRANSFER_LEASE_LISTED_SQL,
            TRANSFER_LEASE_EXPIRED_SQL,
            SELECT_LEASE_OWNER_SQL,
            CREDIT_STOCK_QTY_ONLY_SQL,
            SELECT_STOCK_QTY_SQL,
        ]
        .join("\n")
    }

    #[test]
    fn path_matches_node() {
        assert_eq!(P2P_INSTANCES_PATH, "/v1/hardware/p2p-instances");
        assert_eq!(P2P_OP_LIST, "list");
        assert_eq!(P2P_OP_UNLIST, "unlist");
        assert_eq!(P2P_OP_TRANSFER, "transfer");
    }

    #[test]
    fn sql_does_not_consume_or_delete_instances() {
        let sql = all_sql();
        let lower = sql.to_ascii_lowercase();
        assert!(!lower.contains("consume"));
        assert!(!lower.contains("game_states"));
        assert!(!LIST_INSTANCES_SQL.to_ascii_lowercase().contains("delete"));
        assert!(!UNLIST_INSTANCE_SQL.to_ascii_lowercase().contains("delete"));
        assert!(!TRANSFER_INSTANCE_SQL
            .to_ascii_lowercase()
            .contains("delete"));
        assert!(!CREDIT_STOCK_QTY_ONLY_SQL.contains("item_instances"));
        assert!(!lower.contains("gen_random_uuid"));
        assert!(!lower.contains("mint"));
        assert!(!sql.contains("reconcile"));
    }

    #[test]
    fn unlist_and_transfer_do_not_mint() {
        assert!(!UNLIST_INSTANCE_SQL.contains("INSERT INTO item_instances"));
        assert!(!TRANSFER_INSTANCE_SQL.contains("INSERT INTO item_instances"));
        assert!(!UNLIST_LEASE_SQL.contains("INSERT INTO player_asic_leases"));
        assert!(!TRANSFER_LEASE_LISTED_SQL.contains("INSERT INTO player_asic_leases"));
        assert!(!TRANSFER_LEASE_EXPIRED_SQL.contains("INSERT INTO player_asic_leases"));
        assert!(CREDIT_STOCK_QTY_ONLY_SQL.contains("ON CONFLICT"));
        assert!(!CREDIT_STOCK_QTY_ONLY_SQL.contains("item_instances"));
    }

    #[test]
    fn unlist_and_transfer_accept_expired_without_mint_or_revive() {
        assert_eq!(ITEM_INSTANCE_STATUS_EXPIRED, "expired");
        assert_eq!(ASIC_LEASE_STATUS_EXPIRED, "expired");
        assert!(!SELECT_LEASE_OWNER_SQL.contains("INSERT"));
        assert!(!SELECT_LEASE_OWNER_SQL.contains("SET status"));
        assert!(TRANSFER_LEASE_EXPIRED_SQL.contains("SET user_id"));
        assert!(!TRANSFER_LEASE_EXPIRED_SQL.contains("SET status"));
        assert!(!TRANSFER_LEASE_EXPIRED_SQL.contains("SET user_id = $2, status"));
        assert!(TRANSFER_LEASE_LISTED_SQL.contains("SET user_id = $2, status = $3"));
    }

    #[test]
    fn list_marks_stock_to_listed_without_consume() {
        assert!(LIST_INSTANCES_SQL.contains("FOR UPDATE"));
        assert!(LIST_INSTANCES_SQL.contains("ORDER BY created_at, id"));
        assert!(LIST_INSTANCES_SQL.contains("RETURNING id"));
        assert!(!LIST_INSTANCES_SQL.contains("SKIP LOCKED"));
        assert_eq!(ITEM_INSTANCE_STATUS_LISTED, "listed");
        assert_eq!(ASIC_LEASE_STATUS_LISTED, "listed");
        assert_eq!(ASIC_LEASE_STATUS_STOCK, "stock");
        assert_eq!(ASIC_LEASE_STATUS_EXPIRED, "expired");
        assert!(MARK_LEASE_LISTED_SQL.contains("player_asic_leases"));
        assert!(MARK_LEASE_LISTED_SQL.contains("SET status"));
    }

    #[test]
    fn catalog_max_len_is_prisma() {
        assert_eq!(ITEM_INSTANCE_CATALOG_ID_MAX_LEN, 200);
    }
}
