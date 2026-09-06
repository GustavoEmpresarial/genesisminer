//! Global admin recall: credit every placed-rack component into stock, then
//! delete slots / multiplier slots / `placed_racks` in **one** TX.
//!
//! Node 1:1 (`recall-all.ts` `runRecallAttempt` + `collectRackComponents`).
//! Do **not** lock `game_states`. Timeouts: `HARDWARE_TX_TIMEOUT_MS` only.

use std::collections::HashMap;

use deadpool_postgres::GenericClient;
use tokio_postgres::Row;

use crate::config::HARDWARE_TX_TIMEOUT_MS;
use crate::instances::{mint_instances, ITEM_INSTANCE_STATUS_STOCK};
use crate::pg_types::{pg_qty, pg_user_id};

/// Node `HARDWARE_RECALL_ALL_PATH`.
pub const RECALL_ALL_PATH: &str = "/v1/hardware/recall-all";

const CREDIT_QTY: i64 = 1;

const RECALL_STOCK_INCREMENT_SQL: &str =
    "INSERT INTO stock (user_id, item_id, qty) VALUES ($1, $2, $3)
   ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty";

pub struct RecallAllOutcome {
    pub items_moved: i64,
    pub racks_processed: i64,
}

fn js_truthy_id(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty())
}

fn row_text_opt(row: &Row, col: &str) -> Option<String> {
    if let Ok(v) = row.try_get::<_, Option<String>>(col) {
        return v;
    }
    row.try_get::<_, String>(col).ok()
}

fn row_user_id(row: &Row) -> anyhow::Result<i64> {
    if let Ok(v) = row.try_get::<_, i32>("user_id") {
        return Ok(i64::from(v));
    }
    row.try_get::<_, i64>("user_id")
        .map_err(|e| anyhow::anyhow!("placed_racks.user_id: {e}"))
}

/// Same rules as Node `collectRackComponents`: push each truthy id.
pub fn collect_rack_components(
    item_id: Option<&str>,
    wiring_id: Option<&str>,
    battery_id: Option<&str>,
    slot_item_ids: &[Option<String>],
    multiplier_item_ids: &[Option<String>],
) -> Vec<String> {
    let mut components = Vec::new();
    if let Some(id) = item_id.filter(|s| !s.is_empty()) {
        components.push(id.to_string());
    }
    if let Some(id) = wiring_id.filter(|s| !s.is_empty()) {
        components.push(id.to_string());
    }
    if let Some(id) = battery_id.filter(|s| !s.is_empty()) {
        components.push(id.to_string());
    }
    for id in slot_item_ids {
        if let Some(s) = id.as_deref().filter(|s| !s.is_empty()) {
            components.push(s.to_string());
        }
    }
    for id in multiplier_item_ids {
        if let Some(s) = id.as_deref().filter(|s| !s.is_empty()) {
            components.push(s.to_string());
        }
    }
    components
}

fn group_item_ids_by_rack(
    rows: &[(String, Option<String>)],
    rack_order: &[String],
) -> HashMap<String, Vec<Option<String>>> {
    let mut lists: HashMap<String, Vec<Option<String>>> = HashMap::new();
    for id in rack_order {
        lists.insert(id.clone(), Vec::new());
    }
    for (rack_id, item_id) in rows {
        lists
            .entry(rack_id.clone())
            .or_default()
            .push(item_id.clone());
    }
    lists
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

async fn load_item_ids_by_rack<C: GenericClient>(
    client: &C,
    sql: &str,
    rack_ids: &[String],
) -> anyhow::Result<HashMap<String, Vec<Option<String>>>> {
    let rows = client.query(sql, &[&rack_ids]).await?;
    let mut pairs = Vec::with_capacity(rows.len());
    for row in rows {
        let rack_id: String = row.get("rack_id");
        pairs.push((rack_id, row_text_opt(&row, "item_id")));
    }
    Ok(group_item_ids_by_rack(&pairs, rack_ids))
}

/// Credit every component then DELETE racks/slots in this TX. Empty → 0/0.
pub async fn recall_all<C: GenericClient>(client: &C) -> anyhow::Result<RecallAllOutcome> {
    set_hardware_tx_timeouts(client).await?;

    let racks = client
        .query(
            "SELECT id, user_id, item_id, wiring_id, battery_id FROM placed_racks",
            &[],
        )
        .await?;
    if racks.is_empty() {
        return Ok(RecallAllOutcome {
            items_moved: 0,
            racks_processed: 0,
        });
    }

    let rack_ids: Vec<String> = racks.iter().map(|r| r.get::<_, String>("id")).collect();
    let slots_by_rack = load_item_ids_by_rack(
        client,
        "SELECT rack_id, machine_item_id AS item_id FROM rack_slots WHERE rack_id = ANY($1::text[])",
        &rack_ids,
    )
    .await?;
    let multi_by_rack = load_item_ids_by_rack(
        client,
        "SELECT rack_id, multiplier_item_id AS item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1::text[])",
        &rack_ids,
    )
    .await?;

    let mut items_moved: i64 = 0;
    for row in &racks {
        let user_id = row_user_id(row)?;
        let rack_id: String = row.get("id");
        let empty: Vec<Option<String>> = Vec::new();
        let slots = slots_by_rack.get(&rack_id).unwrap_or(&empty);
        let multis = multi_by_rack.get(&rack_id).unwrap_or(&empty);
        let components = collect_rack_components(
            js_truthy_id(row_text_opt(row, "item_id")).as_deref(),
            js_truthy_id(row_text_opt(row, "wiring_id")).as_deref(),
            js_truthy_id(row_text_opt(row, "battery_id")).as_deref(),
            slots,
            multis,
        );
        for item_id in components {
            let uid = pg_user_id(user_id)?;
            let qty = pg_qty(CREDIT_QTY)?;
            client
                .execute(RECALL_STOCK_INCREMENT_SQL, &[&uid, &item_id, &qty])
                .await?;
            mint_instances(
                client,
                user_id,
                &item_id,
                CREDIT_QTY,
                ITEM_INSTANCE_STATUS_STOCK,
            )
            .await?;
            items_moved += 1;
        }
    }

    client
        .execute(
            "DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks)",
            &[],
        )
        .await?;
    client
        .execute(
            "DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks)",
            &[],
        )
        .await?;
    client.execute("DELETE FROM placed_racks", &[]).await?;

    Ok(RecallAllOutcome {
        items_moved,
        racks_processed: i64::try_from(racks.len())
            .map_err(|_| anyhow::anyhow!("rack count exceeds i64"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_all_path_matches_node() {
        assert_eq!(RECALL_ALL_PATH, "/v1/hardware/recall-all");
    }

    #[test]
    fn recall_credit_sql_is_increment_only() {
        assert!(RECALL_STOCK_INCREMENT_SQL.contains("stock.qty + EXCLUDED.qty"));
        assert!(!RECALL_STOCK_INCREMENT_SQL
            .to_ascii_lowercase()
            .contains("lease"));
        assert_eq!(CREDIT_QTY, 1);
    }

    #[test]
    fn collect_matches_node_truthy_rules() {
        assert!(collect_rack_components(None, None, None, &[], &[]).is_empty());
        assert_eq!(
            collect_rack_components(Some(""), Some("w"), None, &[], &[]),
            vec!["w".to_string()]
        );
        let slots = vec![Some("m1".into()), None, Some("m2".into())];
        let multis = vec![Some("x".into())];
        assert_eq!(
            collect_rack_components(Some("c"), Some("w"), Some("b"), &slots, &multis),
            vec![
                "c".to_string(),
                "w".to_string(),
                "b".to_string(),
                "m1".to_string(),
                "m2".to_string(),
                "x".to_string()
            ]
        );
    }
}
