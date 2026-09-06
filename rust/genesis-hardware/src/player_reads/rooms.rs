//! Rig-room reads — Node `GET /api/rig-rooms` + `GET /api/my-rig-rooms/:email`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::constants::{ASIC_ROOM_ID, EXTRA_ROOM_ID, NFT_AUTO_ROOM_ID};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::pg_types::pg_user_id;

use super::{f64_cell, i32_cell, opt_i64_cell, opt_string_cell, string_cell, PlayerReadError};

/// Node `NFT_AUTO_POLICY_ROOM_NAME_KEYS` in nft-room-mining.ts.
const NFT_AUTO_POLICY_ROOM_NAME_KEYS: &[&str] = &[
    "sala nfts",
    "nfts auto",
    "nft auto",
    "nfts arbam",
    "sala dolar/nfts",
    "sala dolar / nfts",
];
/// Node `DEFAULT_ASIC_UNLOCKED_SLOTS`.
const DEFAULT_UNLOCKED_SLOTS: i32 = 0;
/// Node `COMBINING_DIACRITICS_RANGE_*`.
const COMBINING_DIACRITICS_START: u32 = 0x0300;
const COMBINING_DIACRITICS_END: u32 = 0x036F;
const ROOM_MAIN: &str = "main";

const _: () = assert!(DEFAULT_UNLOCKED_SLOTS == 0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyRoomsRequest {
    pub user_id: i64,
    #[serde(default)]
    pub email: Option<String>,
}

pub async fn run_rig_rooms_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, name, initial_capacity, max_capacity,
                    base_slot_price::double precision AS base_slot_price,
                    slot_price_increase_percent::double precision AS slot_price_increase_percent,
                    allowed_levels, allowed_season_pass_ids, is_active, sort_order
               FROM rig_rooms
              ORDER BY sort_order ASC, name ASC",
            &[],
        )
        .await?;
    let items: Vec<Value> = rows.iter().map(map_public_room).collect();
    Ok(json!({ "items": items }))
}

pub async fn run_my_rig_rooms(
    pool: &Pool,
    user_id: i64,
    email: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    if let Some(path_email) = email {
        assert_email_is_self(&conn, uid, path_email).await?;
    }
    grant_default_player_rooms(&conn, uid).await?;
    let access = resolve_user_room_access(&conn, uid).await?;
    let rack_rooms = load_placed_rack_room_ids(&conn, uid).await?;
    let rows = conn
        .query(
            "SELECT rr.id, rr.name, rr.initial_capacity, rr.max_capacity,
                    rr.base_slot_price::double precision AS base_slot_price,
                    rr.slot_price_increase_percent::double precision AS slot_price_increase_percent,
                    rr.allowed_levels, rr.allowed_season_pass_ids, rr.is_active, rr.sort_order,
                    urr.purchased_at, urr.unlocked_slots
               FROM rig_rooms rr
               LEFT JOIN user_rig_rooms urr ON urr.room_id = rr.id AND urr.user_id = $1
              ORDER BY rr.sort_order ASC",
            &[&uid],
        )
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .filter_map(|r| {
            let allowed_plan = parse_json_string_array(opt_string_cell(r, "allowed_levels"));
            let allowed_pass = parse_json_string_array(opt_string_cell(r, "allowed_season_pass_ids"));
            let owned = opt_i64_cell(r, "purchased_at").is_some();
            let id = string_cell(r, "id");
            let has_racks = rack_rooms.contains(&id);
            if !(owned || has_racks || room_access_allowed(&allowed_plan, &allowed_pass, &access)) {
                return None;
            }
            Some(json!({
                "id": id,
                "name": string_cell(r, "name"),
                "initialCapacity": i32_cell(r, "initial_capacity"),
                "maxCapacity": i32_cell(r, "max_capacity"),
                "baseSlotPrice": f64_cell(r, "base_slot_price"),
                "slotPriceIncreasePercent": f64_cell(r, "slot_price_increase_percent"),
                "allowedPlanIds": allowed_plan,
                "allowedSeasonPassIds": allowed_pass,
                "isActive": i32_cell(r, "is_active") != 0,
                "sortOrder": i32_cell(r, "sort_order"),
                "owned": owned,
                "unlockedSlots": i32_cell(r, "unlocked_slots"),
                "nftAutoArmario1Only": is_nft_auto_armario1_only(&string_cell(r, "id"), opt_string_cell(r, "name").as_deref()),
            }))
        })
        .collect();
    Ok(json!({ "items": items }))
}

async fn assert_email_is_self<C: GenericClient>(
    client: &C,
    uid: i32,
    path_email: &str,
) -> Result<(), PlayerReadError> {
    let row = client
        .query_opt("SELECT email FROM users WHERE id = $1", &[&uid])
        .await?;
    let Some(r) = row else {
        return Err(PlayerReadError::not_found("User not found."));
    };
    let session = string_cell(&r, "email").trim().to_ascii_lowercase();
    let path = path_email.trim().to_ascii_lowercase();
    if session.is_empty() || session != path {
        return Err(PlayerReadError::forbidden("Access denied."));
    }
    Ok(())
}

async fn grant_default_player_rooms<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<(), PlayerReadError> {
    let now = current_unix_ms();
    for room_id in [ASIC_ROOM_ID, EXTRA_ROOM_ID] {
        client
            .execute(
                "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, room_id) DO NOTHING",
                &[&uid, &room_id, &now, &DEFAULT_UNLOCKED_SLOTS],
            )
            .await?;
    }
    Ok(())
}

struct UserRoomAccess {
    plan_ids: Vec<String>,
    pass_ids: Vec<String>,
}

async fn resolve_user_room_access<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<UserRoomAccess, PlayerReadError> {
    let user = client
        .query_opt("SELECT access_level_id FROM users WHERE id = $1", &[&uid])
        .await?;
    let grants = client
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let passes = client
        .query(
            "SELECT pass_id FROM season_purchases WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut plan_ids = Vec::new();
    if let Some(u) = user {
        if let Some(id) = opt_string_cell(&u, "access_level_id") {
            plan_ids.push(id);
        }
    }
    for g in &grants {
        let id = string_cell(g, "access_level_id");
        if !id.is_empty() && !plan_ids.contains(&id) {
            plan_ids.push(id);
        }
    }
    Ok(UserRoomAccess {
        plan_ids,
        pass_ids: passes.iter().map(|r| string_cell(r, "pass_id")).collect(),
    })
}

async fn load_placed_rack_room_ids<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<std::collections::HashSet<String>, PlayerReadError> {
    let rows = client
        .query(
            "SELECT DISTINCT
                    CASE
                      WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = ''
                           OR BTRIM(room_id) = $2 THEN $3
                      ELSE BTRIM(room_id)
                    END AS room_id
               FROM placed_racks WHERE user_id = $1",
            &[
                &uid,
                &ROOM_MAIN,
                &genesis_core::calculator::constants::ROOM_INITIAL_ID,
            ],
        )
        .await?;
    Ok(rows.iter().map(|r| string_cell(r, "room_id")).collect())
}

fn map_public_room(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": string_cell(r, "id"),
        "name": string_cell(r, "name"),
        "initialCapacity": i32_cell(r, "initial_capacity"),
        "maxCapacity": i32_cell(r, "max_capacity"),
        "baseSlotPrice": f64_cell(r, "base_slot_price"),
        "slotPriceIncreasePercent": f64_cell(r, "slot_price_increase_percent"),
        "allowedPlanIds": parse_json_string_array(opt_string_cell(r, "allowed_levels")),
        "allowedSeasonPassIds": parse_json_string_array(opt_string_cell(r, "allowed_season_pass_ids")),
        "isActive": i32_cell(r, "is_active") != 0,
        "sortOrder": i32_cell(r, "sort_order"),
        "nftAutoArmario1Only": is_nft_auto_armario1_only(&string_cell(r, "id"), opt_string_cell(r, "name").as_deref()),
    })
}

fn parse_json_string_array(raw: Option<String>) -> Vec<String> {
    let Some(s) = raw.filter(|v| !v.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&s) {
        Ok(Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn room_access_allowed(plan: &[String], pass: &[String], access: &UserRoomAccess) -> bool {
    let plan_ok = plan.is_empty()
        || plan
            .iter()
            .any(|id| access.plan_ids.iter().any(|p| p == id));
    let season_ok = pass.is_empty()
        || pass
            .iter()
            .any(|id| access.pass_ids.iter().any(|p| p == id));
    plan_ok && season_ok
}

fn is_nft_auto_armario1_only(id: &str, name: Option<&str>) -> bool {
    if id.trim() == NFT_AUTO_ROOM_ID {
        return true;
    }
    let kn = normalize_policy_name(name.unwrap_or(""));
    NFT_AUTO_POLICY_ROOM_NAME_KEYS.contains(&kn.as_str())
}

fn normalize_policy_name(name: &str) -> String {
    let stripped: String = name
        .chars()
        .filter(|c| {
            let u = *c as u32;
            u < COMBINING_DIACRITICS_START || u > COMBINING_DIACRITICS_END
        })
        .collect();
    stripped
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_auto_by_id() {
        assert!(is_nft_auto_armario1_only(NFT_AUTO_ROOM_ID, Some("other")));
        assert!(!is_nft_auto_armario1_only("room_x", Some("Sala Principal")));
        assert!(is_nft_auto_armario1_only("x", Some("Sala NFTs")));
    }

    #[test]
    fn access_empty_lists_open() {
        let access = UserRoomAccess {
            plan_ids: vec!["p1".into()],
            pass_ids: vec![],
        };
        assert!(room_access_allowed(&[], &[], &access));
        assert!(!room_access_allowed(&["other".into()], &[], &access));
    }
}
