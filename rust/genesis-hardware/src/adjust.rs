//! Debit + credit stock in one worker TX (`POST /v1/hardware/adjust`).
//!
//! Merge consume+craft: also reachable in-process from `merge::execute`
//! (USDC fee + adjust + `merge_history` in one TX). Standalone `/adjust`
//! remains for callers that only need stock. Any line failure rolls the TX.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::GenericClient;
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;
use genesis_core::hardware::duration::is_timed_asic_duration;

use crate::config::{current_unix_ms, HARDWARE_TX_TIMEOUT_MS};
use crate::instances::{consume_stock_instances, reconcile_stock_instances_to_qty};
use crate::leases::{load_asic_duration_config, reconcile_timed_asic_stock_leases};
use crate::persist::credit_stock;
use crate::pg_types::{pg_qty, pg_user_id};

/// Same token Node `MergeError` uses (`server/modules/merge/services/merge.ts`).
pub const INSUFFICIENT_STOCK: &str = "INSUFFICIENT_STOCK";

#[derive(Debug, Clone)]
pub struct AdjustLine {
    pub item_id: String,
    pub qty: i64,
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

async fn debit_stock_line<C: GenericClient>(
    client: &C,
    uid: i64,
    item_id: &str,
    need: i32,
) -> anyhow::Result<i32> {
    let uid_pg = pg_user_id(uid)?;
    let rows = client
        .query(
            "SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2 FOR UPDATE",
            &[&uid_pg, &item_id],
        )
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
        .query(
            "UPDATE stock SET qty = qty - $3 WHERE user_id = $1 AND item_id = $2 AND qty >= $3 RETURNING qty",
            &[&uid_pg, &item_id, &need],
        )
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
            .execute(
                "DELETE FROM stock WHERE user_id = $1 AND item_id = $2",
                &[&uid_pg, &item_id],
            )
            .await?;
    }
    let cfg = load_asic_duration_config(client, item_id).await?;
    if is_timed_asic_duration(&cfg) {
        reconcile_timed_asic_stock_leases(
            client,
            uid,
            item_id,
            i64::from(after),
            current_unix_ms(),
        )
        .await?;
        // Timed units are the leases — sync by lease id; never qty-mint.
        reconcile_stock_instances_to_qty(client, uid, item_id, i64::from(after), false).await?;
    } else {
        consume_stock_instances(client, uid, item_id, i64::from(need)).await?;
    }
    Ok(after)
}

async fn stock_qty_after<C: GenericClient>(
    client: &C,
    uid_pg: i32,
    item_id: &str,
) -> anyhow::Result<i64> {
    let rows = client
        .query(
            "SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2",
            &[&uid_pg, &item_id],
        )
        .await?;
    Ok(rows
        .first()
        .map(|row| i64::from(row.get::<_, i32>("qty")))
        .unwrap_or(0))
}

/// Debit every line, then credit. Returns qty-after for every touched SKU (missing=0).
pub async fn adjust_stock<C: GenericClient>(
    client: &C,
    user_id: i64,
    debit: &[AdjustLine],
    credit: &[AdjustLine],
) -> anyhow::Result<HashMap<String, i64>> {
    set_hardware_tx_timeouts(client).await?;
    let uid_pg = pg_user_id(user_id)?;
    let mut touched: HashSet<String> = HashSet::new();

    for line in debit {
        if line.qty <= 0 {
            continue;
        }
        let item_id = normalize_known_1000wh_battery_catalog_id(Some(&line.item_id));
        if item_id.is_empty() {
            continue;
        }
        let need = pg_qty(line.qty)?;
        debit_stock_line(client, user_id, &item_id, need).await?;
        touched.insert(item_id);
    }

    for line in credit {
        credit_stock(client, user_id, &line.item_id, line.qty, None, None).await?;
        if line.qty <= 0 {
            continue;
        }
        let item_id = normalize_known_1000wh_battery_catalog_id(Some(&line.item_id));
        if item_id.is_empty() {
            continue;
        }
        touched.insert(item_id);
    }

    let mut stock = HashMap::new();
    for item_id in &touched {
        stock.insert(
            item_id.clone(),
            stock_qty_after(client, uid_pg, item_id).await?,
        );
    }
    Ok(stock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insufficient_stock_message_starts_with_named_const() {
        let err = insufficient_stock_err("have=0 need=2");
        let msg = err.to_string();
        assert!(
            msg.starts_with(INSUFFICIENT_STOCK),
            "expected {INSUFFICIENT_STOCK} prefix, got {msg}"
        );
        assert_eq!(INSUFFICIENT_STOCK, "INSUFFICIENT_STOCK");
    }

    #[test]
    fn debit_qty_bind_uses_try_from() {
        assert_eq!(pg_qty(2).unwrap(), 2);
        assert!(pg_qty(i64::from(i32::MAX).saturating_add(1)).is_err());
    }
}
