//! Finalize half of admin save-game override — Node `applyAdminSaveGameOverride`
//! after hardware persist: ensure `game_states`, bump timestamps, reload stock
//! (+ placed racks when the panel wrote them).

use std::collections::HashMap;

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::catalog::normalize_stock_catalog_item_id;
use genesis_core::hardware::types::PlacedRack;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::{now_ms, pg_user_id, PlayerReadError};

use super::{CODE_NOT_FOUND, CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_NOT_FOUND};

/// Twin of genesis-api → this worker after `/v1/hardware/persist`.
pub const ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH: &str =
    "/v1/admin/users/save-game-override-finalize";

const ERR_USER_NOT_FOUND: &str = "Utilizador não encontrado.";
const ERR_INVALID_USER: &str = "Invalid user id.";

const ENSURE_GAME_STATES_SQL: &str = "INSERT INTO game_states (
    user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
    last_updated_at, server_updated_at, black_market_balance
) VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
ON CONFLICT (user_id) DO NOTHING";

const BUMP_TIMESTAMPS_SQL: &str =
    "UPDATE game_states SET server_updated_at = $2, last_updated_at = $2 WHERE user_id = $1";

const LOAD_STOCK_SQL: &str = "SELECT item_id, qty FROM stock WHERE user_id = $1";

const LOAD_RACKS_SQL: &str = "SELECT * FROM placed_racks WHERE user_id = $1";

const LOAD_SLOTS_SQL: &str = "SELECT rack_id, slot_index, machine_item_id, machine_lease_id
   FROM rack_slots WHERE rack_id = ANY($1) ORDER BY slot_index";

const LOAD_MULTIPLIERS_SQL: &str = "SELECT rack_id, slot_index, multiplier_item_id
   FROM rack_multiplier_slots WHERE rack_id = ANY($1) ORDER BY slot_index";

const USER_EXISTS_SQL: &str = "SELECT 1 FROM users WHERE id = $1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGameOverrideFinalizeRequest {
    pub user_id: i64,
    #[serde(default)]
    pub wrote_racks: bool,
}

pub async fn run_save_game_override_finalize(
    pool: &Pool,
    req: &SaveGameOverrideFinalizeRequest,
) -> Result<Value, PlayerReadError> {
    if req.user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_USER,
            CODE_VALIDATION,
        ));
    }
    let uid = pg_user_id(req.user_id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;

    let exists = tx.query_opt(USER_EXISTS_SQL, &[&uid]).await?;
    if exists.is_none() {
        let _ = tx.rollback().await;
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    }

    let t = now_ms();
    tx.execute(ENSURE_GAME_STATES_SQL, &[&uid, &t]).await?;
    tx.query_one(
        "SELECT 1 FROM game_states WHERE user_id = $1 FOR UPDATE",
        &[&uid],
    )
    .await?;

    let now = now_ms();
    tx.execute(BUMP_TIMESTAMPS_SQL, &[&uid, &now]).await?;

    let stock = load_user_stock(&tx, uid).await?;
    let placed_racks = if req.wrote_racks {
        Some(load_user_placed_racks(&tx, uid).await?)
    } else {
        None
    };

    tx.commit().await?;

    let mut out = json!({
        "serverUpdatedAt": now,
        "stock": stock,
    });
    if let Some(racks) = placed_racks {
        out["placedRacks"] = serde_json::to_value(racks).unwrap_or(json!([]));
    }
    Ok(out)
}

fn row_lease_id(row: &tokio_postgres::Row) -> Option<String> {
    if let Ok(u) = row.try_get::<_, uuid::Uuid>("machine_lease_id") {
        return Some(u.to_string());
    }
    if let Ok(Some(u)) = row.try_get::<_, Option<uuid::Uuid>>("machine_lease_id") {
        return Some(u.to_string());
    }
    if let Ok(s) = row.try_get::<_, String>("machine_lease_id") {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(Some(s)) = row.try_get::<_, Option<String>>("machine_lease_id") {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

async fn load_user_stock<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<HashMap<String, i64>, PlayerReadError> {
    let rows = client.query(LOAD_STOCK_SQL, &[&uid]).await?;
    let mut stock = HashMap::new();
    for row in rows {
        let raw: String = row.get("item_id");
        let item_id = normalize_stock_catalog_item_id(Some(&raw));
        if item_id.is_empty() {
            continue;
        }
        let qty: i32 = row.get("qty");
        *stock.entry(item_id).or_insert(0) += i64::from(qty);
    }
    Ok(stock)
}

/// Shared with admin owned-rooms revoke (keep racks → hardware persist).
pub(crate) async fn load_user_placed_racks_for_admin<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<Vec<PlacedRack>, PlayerReadError> {
    load_user_placed_racks(client, uid).await
}

async fn load_user_placed_racks<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<Vec<PlacedRack>, PlayerReadError> {
    let rack_rows = client.query(LOAD_RACKS_SQL, &[&uid]).await?;
    if rack_rows.is_empty() {
        return Ok(vec![]);
    }
    let rack_ids: Vec<String> = rack_rows.iter().map(|r| r.get::<_, String>("id")).collect();
    let slots_rows = client.query(LOAD_SLOTS_SQL, &[&rack_ids]).await?;
    let multi_rows = client.query(LOAD_MULTIPLIERS_SQL, &[&rack_ids]).await?;

    let mut slots_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut lease_map: HashMap<String, Vec<String>> = HashMap::new();
    for s in &slots_rows {
        let rid: String = s.get("rack_id");
        let idx: i32 = s.get("slot_index");
        let mid: Option<String> = s.get("machine_item_id");
        let lid = row_lease_id(s);
        let arr = slots_map.entry(rid.clone()).or_default();
        let leases = lease_map.entry(rid).or_default();
        let i = idx as usize;
        while arr.len() <= i {
            arr.push(String::new());
            leases.push(String::new());
        }
        arr[i] = mid.unwrap_or_default();
        leases[i] = lid.unwrap_or_default();
    }
    let mut multi_map: HashMap<String, Vec<String>> = HashMap::new();
    for m in &multi_rows {
        let rid: String = m.get("rack_id");
        let idx: i32 = m.get("slot_index");
        let mid: String = m.get("multiplier_item_id");
        let arr = multi_map.entry(rid).or_default();
        let i = idx as usize;
        while arr.len() <= i {
            arr.push(String::new());
        }
        arr[i] = mid;
    }

    let mut out = Vec::new();
    for r in rack_rows {
        let id: String = r.get("id");
        let room_raw: Option<String> = r.try_get("room_id").ok().flatten();
        out.push(PlacedRack {
            id: id.clone(),
            item_id: r.try_get("item_id").unwrap_or_default(),
            slots: slots_map.remove(&id).unwrap_or_default(),
            slot_lease_ids: lease_map.remove(&id).unwrap_or_default(),
            multiplier_slots: multi_map.remove(&id).unwrap_or_default(),
            wiring_id: r.try_get("wiring_id").ok().flatten(),
            battery_id: r.try_get("battery_id").ok().flatten(),
            is_on: r.try_get::<_, i32>("is_on").ok().unwrap_or(0) != 0,
            selected_coin_id: r.try_get("selected_coin_id").ok().flatten(),
            room_id: normalize_placed_rack_room_id(room_raw.as_deref().unwrap_or("")),
            slot_index: i64::from(r.try_get::<_, i32>("slot_index").ok().unwrap_or(0)),
            battery_catalog_item_id: r.try_get("battery_catalog_item_id").ok().flatten(),
            battery_display_name: r.try_get("battery_display_name").ok().flatten(),
            battery_image_url: r.try_get("battery_image_url").ok().flatten(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalize_path_is_stable() {
        assert_eq!(
            ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH,
            "/v1/admin/users/save-game-override-finalize"
        );
    }

    #[test]
    fn ensure_sql_matches_node_insert() {
        assert!(ENSURE_GAME_STATES_SQL.contains("ON CONFLICT (user_id) DO NOTHING"));
        assert!(BUMP_TIMESTAMPS_SQL.contains("server_updated_at"));
        assert!(BUMP_TIMESTAMPS_SQL.contains("last_updated_at"));
    }
}
