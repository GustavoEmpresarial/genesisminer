//! Admin wipe of one user's item tables (child → parent) in **one** TX.
//!
//! Node 1:1 plus leases / intent-idem orphans. Do **not** lock or delete
//! `game_states`, `unopened_boxes`, `player_listings`, users, or coins.
//! Join rows in `player_listing_instances` for this user's units are removed
//! before `item_instances`.
//! Timeouts: `HARDWARE_TX_TIMEOUT_MS` only.

use deadpool_postgres::GenericClient;

use crate::config::HARDWARE_TX_TIMEOUT_MS;
use crate::pg_types::pg_user_id;

/// Node `HARDWARE_WIPE_USER_PATH`.
pub const WIPE_USER_PATH: &str = "/v1/hardware/wipe-user";

const DELETE_RACK_SLOTS_SQL: &str =
    "DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)";
const DELETE_RACK_MULTIPLIER_SLOTS_SQL: &str =
    "DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)";
const DELETE_PLACED_RACKS_SQL: &str = "DELETE FROM placed_racks WHERE user_id = $1";
const DELETE_STORED_BATTERIES_SQL: &str = "DELETE FROM stored_batteries WHERE user_id = $1";
const DELETE_STOCK_SQL: &str = "DELETE FROM stock WHERE user_id = $1";
const DELETE_LISTING_INSTANCES_SQL: &str =
    "DELETE FROM player_listing_instances WHERE instance_id IN (SELECT id FROM item_instances WHERE user_id = $1)";
const DELETE_ITEM_INSTANCES_SQL: &str = "DELETE FROM item_instances WHERE user_id = $1";
const DELETE_ASIC_LEASES_SQL: &str = "DELETE FROM player_asic_leases WHERE user_id = $1";
const DELETE_INTENT_IDEM_SQL: &str =
    "DELETE FROM game_servers_intent_idempotency WHERE user_id = $1";

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

/// Wipe item tables for `user_id`. Caller owns BEGIN/COMMIT.
pub async fn wipe_user<C: GenericClient>(client: &C, user_id: i64) -> anyhow::Result<()> {
    set_hardware_tx_timeouts(client).await?;
    let uid = pg_user_id(user_id)?;
    client.execute(DELETE_RACK_SLOTS_SQL, &[&uid]).await?;
    client
        .execute(DELETE_RACK_MULTIPLIER_SLOTS_SQL, &[&uid])
        .await?;
    client.execute(DELETE_PLACED_RACKS_SQL, &[&uid]).await?;
    client.execute(DELETE_STORED_BATTERIES_SQL, &[&uid]).await?;
    client.execute(DELETE_STOCK_SQL, &[&uid]).await?;
    client
        .execute(DELETE_LISTING_INSTANCES_SQL, &[&uid])
        .await?;
    client.execute(DELETE_ITEM_INSTANCES_SQL, &[&uid]).await?;
    client.execute(DELETE_ASIC_LEASES_SQL, &[&uid]).await?;
    client.execute(DELETE_INTENT_IDEM_SQL, &[&uid]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_user_path_matches_node() {
        assert_eq!(WIPE_USER_PATH, "/v1/hardware/wipe-user");
    }

    #[test]
    fn wipe_sql_is_user_scoped_child_to_parent() {
        assert!(DELETE_RACK_SLOTS_SQL.contains("placed_racks WHERE user_id = $1"));
        assert!(DELETE_RACK_MULTIPLIER_SLOTS_SQL.contains("placed_racks WHERE user_id = $1"));
        assert_eq!(
            DELETE_PLACED_RACKS_SQL,
            "DELETE FROM placed_racks WHERE user_id = $1"
        );
        assert_eq!(
            DELETE_STORED_BATTERIES_SQL,
            "DELETE FROM stored_batteries WHERE user_id = $1"
        );
        assert_eq!(DELETE_STOCK_SQL, "DELETE FROM stock WHERE user_id = $1");
        assert_eq!(
            DELETE_LISTING_INSTANCES_SQL,
            "DELETE FROM player_listing_instances WHERE instance_id IN (SELECT id FROM item_instances WHERE user_id = $1)"
        );
        assert!(!DELETE_LISTING_INSTANCES_SQL.contains("player_listings"));
        assert_eq!(
            DELETE_ITEM_INSTANCES_SQL,
            "DELETE FROM item_instances WHERE user_id = $1"
        );
        assert_eq!(
            DELETE_ASIC_LEASES_SQL,
            "DELETE FROM player_asic_leases WHERE user_id = $1"
        );
        assert_eq!(
            DELETE_INTENT_IDEM_SQL,
            "DELETE FROM game_servers_intent_idempotency WHERE user_id = $1"
        );
        assert!(!DELETE_STOCK_SQL.contains("unopened_boxes"));
        assert!(!DELETE_STOCK_SQL.contains("game_states"));
    }
}
