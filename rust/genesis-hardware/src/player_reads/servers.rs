//! Servers state + player `game-state/me` — Node `state-snapshot.ts` + `loadAdminGameStateByUserId`.
//!
//! The admin variant (`by-email`) ports `loadAdminGameStateByEmail` from
//! `server/modules/admin/users/services/admin-game-state.ts`: same payload as
//! the player twin plus `ensureOwnedRoomIds` (default rooms + rooms inferred
//! from placed racks) and, under `adminEdit`, empty lease arrays.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::constants::{ASIC_ROOM_ID, EXTRA_ROOM_ID, ROOM_INITIAL_ID};
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::pg_types::pg_user_id;

use super::inventory::overlay_timed_lease_stock_counts;
use super::{
    f64_cell, i32_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError,
    HTTP_BAD_REQUEST,
};

/// Node `SAVE_GAME_ITEM_ID` max length.
const SAVE_GAME_ITEM_ID_MAX: usize = 200;
const SAVE_GAME_ITEM_ID_MIN: usize = 1;
const STATE_VERSION: i32 = 1;
const ROOM_INITIAL: &str = "room_initial";
const ROOM_MAIN: &str = "main";
const LEASE_STOCK: &str = "stock";
const LEASE_EQUIPPED: &str = "equipped";
const REFERRAL_BONUS_CLAIMED: i32 = 1;
/// Node `EMAIL_MAX` in admin-game-state.ts.
const EMAIL_MAX: usize = 254;

/// Node `ERR_EMAIL` / `ERR_USER_NOT_FOUND` in admin-game-state.ts.
const ERR_EMAIL: &str = "Email inválido.";
const ERR_USER_NOT_FOUND: &str = "Utilizador não encontrado.";
const CODE_VALIDATION: &str = "VALIDATION";

const _: () = assert!(SAVE_GAME_ITEM_ID_MAX == 200);
const _: () = assert!(SAVE_GAME_ITEM_ID_MIN == 1);
const _: () = assert!(EMAIL_MAX == 254);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServersUserRequest {
    pub user_id: i64,
}

/// Node `GET /api/game-state/:email` with `:email` ≠ `me` (admin users tab).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminGameStateByEmailRequest {
    pub email: String,
    #[serde(default)]
    pub admin_edit: bool,
}

/// Node `loadAdminGameStateByUserId(userId, { adminEdit })` vs `callGameStateMe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GameStateAudience {
    /// `GET /api/game-state/me` — owned rooms straight from `user_rig_rooms`.
    PlayerMe,
    /// Admin users tab. `admin_edit` mirrors the `X-Admin-Edit: 1` header.
    Admin { admin_edit: bool },
}

pub async fn run_servers_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    build_servers_state(&conn, user_id).await
}

pub async fn run_game_state_me(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    build_game_state(&conn, user_id, GameStateAudience::PlayerMe).await
}

/// Node `loadAdminGameStateByEmail`. Prisma's `mode: 'insensitive'` equals maps
/// to `ILIKE`, whose wildcards would leak into the lookup — compare lowercased
/// like `deleteUserByEmail` already does in Node.
pub async fn run_admin_game_state_by_email(
    pool: &Pool,
    email: &str,
    admin_edit: bool,
) -> Result<Value, PlayerReadError> {
    let em = email.trim();
    if em.is_empty() || em.len() > EMAIL_MAX {
        return Err(PlayerReadError {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_EMAIL.into(),
            code: Some(CODE_VALIDATION.into()),
        });
    }
    let conn = pool.get().await?;
    let row = conn
        .query_opt(
            "SELECT id FROM users WHERE LOWER(BTRIM(email::text)) = LOWER($1) LIMIT 1",
            &[&em],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::not_found(ERR_USER_NOT_FOUND));
    };
    let user_id = i64::from(i32_cell(&row, "id"));
    build_game_state(&conn, user_id, GameStateAudience::Admin { admin_edit }).await
}

async fn build_game_state<C: GenericClient>(
    conn: &C,
    user_id: i64,
    audience: GameStateAudience,
) -> Result<Value, PlayerReadError> {
    let dto = build_servers_state(conn, user_id).await?;
    let uid = pg_user_id(user_id)?;
    let gs = conn
        .query_opt(
            "SELECT start_time, claimed_referrals, referral_bonus_claimed,
                    black_market_balance::double precision AS black_market_balance
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let coins = conn
        .query(
            "SELECT coin_id, amount::double precision AS amount FROM coin_balances WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let boxes = conn
        .query(
            "SELECT box_id, qty FROM unopened_boxes WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let rooms = conn
        .query(
            "SELECT room_id FROM user_rig_rooms WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut coin_balances = serde_json::Map::new();
    for r in &coins {
        coin_balances.insert(string_cell(r, "coin_id"), json!(f64_cell(r, "amount")));
    }
    let mut unopened = serde_json::Map::new();
    for r in &boxes {
        unopened.insert(string_cell(r, "box_id"), json!(i32_cell(r, "qty")));
    }
    let owned: Vec<String> = rooms.iter().map(|r| string_cell(r, "room_id")).collect();
    let start_time = gs.as_ref().map(|r| i64_cell(r, "start_time")).unwrap_or(0);
    let claimed = gs
        .as_ref()
        .map(|r| i32_cell(r, "claimed_referrals").max(0))
        .unwrap_or(0);
    let bonus = gs
        .as_ref()
        .map(|r| i32_cell(r, "referral_bonus_claimed") == REFERRAL_BONUS_CLAIMED)
        .unwrap_or(false);
    let bm = gs
        .as_ref()
        .map(|r| f64_cell(r, "black_market_balance"))
        .unwrap_or(0.0);
    let placed_racks = dto.get("placedRacks").cloned().unwrap_or(json!([]));
    let admin_edit = matches!(audience, GameStateAudience::Admin { admin_edit: true });
    let owned_room_ids = match audience {
        GameStateAudience::PlayerMe => owned,
        GameStateAudience::Admin { .. } => {
            ensure_owned_room_ids(owned, &room_ids_from_placed_racks(&placed_racks))
        }
    };
    let mut payload = json!({
        "usdc": dto.get("usdc").cloned().unwrap_or(json!(0)),
        "blackMarketBalance": bm,
        "startTime": start_time,
        "stock": dto.get("stock").cloned().unwrap_or(json!({})),
        "unopenedBoxes": unopened,
        "claimedBoxes": [],
        "storedBatteries": dto.get("storedBatteries").cloned().unwrap_or(json!([])),
        "placedRacks": placed_racks,
        "playerListings": [],
        "coinBalances": coin_balances,
        "claimedReferrals": claimed,
        "referralBonusClaimed": bonus,
        "dailyActions": {},
        "serverUpdatedAt": dto.get("serverUpdatedAt").cloned().unwrap_or(json!(0)),
        "asicLeaseDetails": if admin_edit {
            json!([])
        } else {
            dto.get("asicLeaseDetails").cloned().unwrap_or(json!([]))
        },
        "ownedRoomIds": owned_room_ids,
    });
    // Node only adds `asicLeases` on the admin-edit branch.
    if admin_edit {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("asicLeases".into(), json!([]));
        }
    }
    Ok(payload)
}

/// Node `roomIdsFromPlacedRacks` — `main`/blank collapse to the initial room.
fn room_ids_from_placed_racks(placed_racks: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for rack in placed_racks.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let raw = rack.get("roomId").and_then(Value::as_str).unwrap_or("");
        let id = normalize_placed_rack_room_id(raw);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(id);
    }
    out
}

/// Node `ensureOwnedRoomIds` — `DEFAULT_PLAYER_OWNED_ROOM_IDS` first, then the
/// stored rooms, de-duplicated and trimmed.
fn ensure_owned_room_ids(stored: Vec<String>, from_racks: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let defaults = [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID];
    for id in defaults
        .iter()
        .map(|s| (*s).to_string())
        .chain(stored)
        .chain(from_racks.iter().cloned())
    {
        let trimmed = id.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

async fn build_servers_state<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let gs = client
        .query_opt(
            "SELECT usdc::double precision AS usdc, server_updated_at,
                    nft_asic_mined_usd_total::double precision AS nft_asic_mined_usd_total
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let usdc = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);
    let server_updated_at = gs
        .as_ref()
        .map(|r| i64_cell(r, "server_updated_at"))
        .unwrap_or(0);
    let nft_asic = gs
        .as_ref()
        .map(|r| f64_cell(r, "nft_asic_mined_usd_total"))
        .unwrap_or(0.0);

    let stock_rows = client
        .query("SELECT item_id, qty FROM stock WHERE user_id = $1", &[&uid])
        .await?;
    let mut stock: HashMap<String, i64> = HashMap::new();
    for r in &stock_rows {
        let raw = string_cell(r, "item_id");
        if !is_valid_save_game_item_id(&raw) {
            continue;
        }
        let item_id = normalize_known_1000wh_battery_catalog_id(Some(raw.as_str()));
        let q = i64::from(i32_cell(r, "qty"));
        *stock.entry(item_id).or_insert(0) += q;
    }
    overlay_timed_lease_stock_counts(client, user_id, &mut stock).await?;

    let bats = client
        .query(
            "SELECT id, item_id, display_name, image_url FROM stored_batteries WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let stored_batteries: Vec<Value> = bats
        .iter()
        .map(|r| {
            json!({
                "id": string_cell(r, "id"),
                "itemId": normalize_known_1000wh_battery_catalog_id(Some(string_cell(r, "item_id").as_str())),
                "displayName": opt_string_cell(r, "display_name"),
                "imageUrl": opt_string_cell(r, "image_url"),
            })
        })
        .collect();

    let racks = client
        .query(
            "SELECT id, item_id, wiring_id, battery_id, is_on, selected_coin_id, room_id, slot_index,
                    battery_catalog_item_id, battery_display_name, battery_image_url
               FROM placed_racks WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let rack_ids: Vec<String> = racks.iter().map(|r| string_cell(r, "id")).collect();
    let (slots, multipliers) = if rack_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let sl = client
            .query(
                "SELECT rack_id, slot_index, machine_item_id, machine_lease_id
                   FROM rack_slots WHERE rack_id = ANY($1::text[])
                   ORDER BY rack_id ASC, slot_index ASC",
                &[&rack_ids],
            )
            .await?;
        let mu = client
            .query(
                "SELECT rack_id, slot_index, multiplier_item_id
                   FROM rack_multiplier_slots WHERE rack_id = ANY($1::text[])
                   ORDER BY rack_id ASC, slot_index ASC",
                &[&rack_ids],
            )
            .await?;
        (sl, mu)
    };
    let placed_racks = map_placed_racks(&racks, &slots, &multipliers);

    let leases = client
        .query(
            "SELECT id, item_id, expires_at, status, rack_id, slot_index
               FROM player_asic_leases WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let asic_lease_details: Vec<Value> = leases
        .iter()
        .filter_map(|r| {
            let st = string_cell(r, "status").to_ascii_lowercase();
            if st != LEASE_STOCK && st != LEASE_EQUIPPED {
                return None;
            }
            Some(json!({
                "leaseId": string_cell(r, "id"),
                "itemId": string_cell(r, "item_id"),
                "expiresAt": i64_cell(r, "expires_at"),
                "status": st,
                "rackId": opt_string_cell(r, "rack_id"),
                "slotIndex": opt_i32_cell(r, "slot_index"),
            }))
        })
        .collect();

    let rig_rooms = load_rig_rooms_read_only(client, user_id).await?;
    let mining_coins = {
        // DB-only coins (no app-cache overlay) — same shape as catalog GET.
        let dummy_pool_coins = catalog_mining_coins_from_client(client).await?;
        dummy_pool_coins
    };
    let upgrades = super::catalog::run_catalog_upgrades_on_client(client, Some(user_id)).await?;

    let stock_json: serde_json::Map<String, Value> = stock
        .into_iter()
        .filter(|(_, q)| *q > 0)
        .map(|(k, v)| (k, json!(v)))
        .collect();

    Ok(json!({
        "version": STATE_VERSION,
        "usdc": usdc,
        "serverUpdatedAt": server_updated_at,
        "stateVersion": server_updated_at,
        "stock": stock_json,
        "storedBatteries": stored_batteries,
        "placedRacks": placed_racks,
        "rigRooms": rig_rooms,
        "miningCoins": mining_coins,
        "upgrades": upgrades.get("upgrades").cloned().unwrap_or(json!([])),
        "nftAsicMinedUsdTotal": nft_asic,
        "asicLeaseDetails": asic_lease_details,
    }))
}

async fn catalog_mining_coins_from_client<C: GenericClient>(
    client: &C,
) -> Result<Value, PlayerReadError> {
    let rows = client
        .query(
            "SELECT id, name, symbol, description, color, algorithm,
                    multiplier::double precision AS multiplier,
                    difficulty::double precision AS difficulty,
                    min_proportion::double precision AS min_proportion,
                    usdc_rate::double precision AS usdc_rate,
                    is_active, network_hashrate::double precision AS network_hashrate,
                    block_reward::double precision AS block_reward,
                    block_time::double precision AS block_time,
                    price_usd::double precision AS price_usd,
                    target_daily_usd::double precision AS target_daily_usd,
                    show_in_exchange, nft_room_only
               FROM mining_coins ORDER BY name ASC",
            &[],
        )
        .await?;
    const DEFAULT_NETWORK_HASHRATE: f64 = 100.0;
    const _: () = assert!(DEFAULT_NETWORK_HASHRATE as i64 == 100);
    Ok(json!(rows
        .iter()
        .map(|r| {
            let mut used_rate = f64_cell(r, "network_hashrate");
            if !used_rate.is_finite() || used_rate == 0.0 {
                used_rate = DEFAULT_NETWORK_HASHRATE;
            }
            json!({
                "id": string_cell(r, "id"),
                "name": string_cell(r, "name"),
                "symbol": string_cell(r, "symbol"),
                "description": string_cell(r, "description"),
                "color": opt_string_cell(r, "color"),
                "algorithm": opt_string_cell(r, "algorithm"),
                "multiplier": f64_cell(r, "multiplier"),
                "difficulty": f64_cell(r, "difficulty"),
                "minProportion": f64_cell(r, "min_proportion"),
                "usdcRate": f64_cell(r, "usdc_rate"),
                "isActive": i32_cell(r, "is_active") != 0,
                "networkHashrate": used_rate,
                "blockReward": f64_cell(r, "block_reward"),
                "blockTime": f64_cell(r, "block_time"),
                "priceUSD": f64_cell(r, "price_usd"),
                "targetDailyUSD": f64_cell(r, "target_daily_usd"),
                "showInExchange": i32_cell(r, "show_in_exchange") != 0,
                "nftRoomOnly": i32_cell(r, "nft_room_only") == 1,
            })
        })
        .collect::<Vec<_>>()))
}

async fn load_rig_rooms_read_only<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rack_rooms = client
        .query(
            "SELECT DISTINCT
                CASE
                  WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = '' OR BTRIM(room_id) = $2 THEN $3
                  ELSE BTRIM(room_id)
                END AS room_id
               FROM placed_racks WHERE user_id = $1",
            &[&uid, &ROOM_MAIN, &ROOM_INITIAL],
        )
        .await?;
    let mut with_racks = HashSet::new();
    for r in &rack_rooms {
        with_racks.insert(string_cell(r, "room_id"));
    }
    let user = client
        .query_opt("SELECT access_level_id FROM users WHERE id = $1", &[&uid])
        .await?;
    let access_id = user
        .as_ref()
        .and_then(|r| opt_string_cell(r, "access_level_id"))
        .unwrap_or_default();
    let rows = client
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
    let mut out = Vec::new();
    for r in &rows {
        let id = string_cell(r, "id");
        let allowed = parse_json_string_array(opt_string_cell(r, "allowed_levels"));
        let owned = opt_string_cell(r, "purchased_at").is_some()
            || r.try_get::<_, Option<i64>>("purchased_at")
                .ok()
                .flatten()
                .is_some();
        let access_ok = allowed.is_empty() || allowed.iter().any(|p| p == &access_id);
        if !(owned || with_racks.contains(&id) || access_ok) {
            continue;
        }
        out.push(json!({
            "id": id,
            "name": string_cell(r, "name"),
            "initialCapacity": i32_cell(r, "initial_capacity"),
            "maxCapacity": i32_cell(r, "max_capacity"),
            "baseSlotPrice": f64_cell(r, "base_slot_price"),
            "slotPriceIncreasePercent": f64_cell(r, "slot_price_increase_percent"),
            "allowedPlanIds": allowed,
            "allowedSeasonPassIds": parse_json_string_array(opt_string_cell(r, "allowed_season_pass_ids")),
            "isActive": i32_cell(r, "is_active") != 0,
            "sortOrder": i32_cell(r, "sort_order"),
            "owned": owned,
            "unlockedSlots": i32_cell(r, "unlocked_slots"),
            "nftAutoArmario1Only": false,
        }));
    }
    Ok(out)
}

fn map_placed_racks(
    racks: &[tokio_postgres::Row],
    slots: &[tokio_postgres::Row],
    multipliers: &[tokio_postgres::Row],
) -> Vec<Value> {
    let mut slots_map: HashMap<String, Vec<Value>> = HashMap::new();
    let mut lease_map: HashMap<String, Vec<Value>> = HashMap::new();
    let mut mult_map: HashMap<String, Vec<Value>> = HashMap::new();
    for s in slots {
        let rid = string_cell(s, "rack_id");
        let idx = i32_cell(s, "slot_index") as usize;
        let arr = slots_map.entry(rid.clone()).or_default();
        let lease_arr = lease_map.entry(rid).or_default();
        grow(arr, idx + 1);
        grow(lease_arr, idx + 1);
        arr[idx] = opt_string_cell(s, "machine_item_id")
            .map(Value::String)
            .unwrap_or(Value::Null);
        lease_arr[idx] = opt_string_cell(s, "machine_lease_id")
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
    for m in multipliers {
        let rid = string_cell(m, "rack_id");
        let idx = i32_cell(m, "slot_index") as usize;
        let arr = mult_map.entry(rid).or_default();
        grow(arr, idx + 1);
        arr[idx] = opt_string_cell(m, "multiplier_item_id")
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
    racks
        .iter()
        .map(|r| {
            let id = string_cell(r, "id");
            let room = opt_string_cell(r, "room_id").unwrap_or_default();
            json!({
                "id": id,
                "itemId": string_cell(r, "item_id"),
                "slots": slots_map.get(&string_cell(r, "id")).cloned().unwrap_or_default(),
                "slotLeaseIds": lease_map.get(&string_cell(r, "id")).cloned().unwrap_or_default(),
                "multiplierSlots": mult_map.get(&string_cell(r, "id")).cloned().unwrap_or_default(),
                "wiringId": opt_string_cell(r, "wiring_id"),
                "batteryId": opt_string_cell(r, "battery_id"),
                "isOn": i32_cell(r, "is_on") != 0,
                "selectedCoinId": opt_string_cell(r, "selected_coin_id"),
                "batteryCatalogItemId": opt_string_cell(r, "battery_catalog_item_id")
                    .map(|s| normalize_known_1000wh_battery_catalog_id(Some(s.as_str()))),
                "batteryDisplayName": opt_string_cell(r, "battery_display_name"),
                "batteryImageUrl": opt_string_cell(r, "battery_image_url"),
                "roomId": normalize_placed_rack_room_id(&room),
                "slotIndex": i32_cell(r, "slot_index"),
            })
        })
        .collect()
}

fn grow(arr: &mut Vec<Value>, len: usize) {
    while arr.len() < len {
        arr.push(Value::Null);
    }
}

fn is_valid_save_game_item_id(value: &str) -> bool {
    let n = value.len();
    if n < SAVE_GAME_ITEM_ID_MIN || n > SAVE_GAME_ITEM_ID_MAX {
        return false;
    }
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

fn parse_json_string_array(raw: Option<String>) -> Vec<String> {
    let Some(s) = raw else {
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

fn i64_cell(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v as i64;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_initial_room_matches_the_shared_constant() {
        assert_eq!(ROOM_INITIAL, ROOM_INITIAL_ID);
    }

    #[test]
    fn admin_owned_rooms_lead_with_the_default_three() {
        let out = ensure_owned_room_ids(Vec::new(), &[]);
        assert_eq!(out, vec![ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID]);
    }

    #[test]
    fn admin_owned_rooms_dedupe_and_trim_stored_ids() {
        let out = ensure_owned_room_ids(
            vec![
                " room_custom ".into(),
                ROOM_INITIAL_ID.into(),
                "".into(),
                "room_custom".into(),
            ],
            &["room_from_rack".into(), "room_custom".into()],
        );
        assert_eq!(
            out,
            vec![
                ROOM_INITIAL_ID,
                ASIC_ROOM_ID,
                EXTRA_ROOM_ID,
                "room_custom",
                "room_from_rack"
            ]
        );
    }

    #[test]
    fn rack_room_ids_collapse_main_and_blank_to_initial() {
        let racks = json!([
            { "roomId": "main" },
            { "roomId": "" },
            { "roomId": "room_x" },
            { "roomId": "room_x" },
            {}
        ]);
        assert_eq!(
            room_ids_from_placed_racks(&racks),
            vec![ROOM_INITIAL_ID.to_string(), "room_x".to_string()]
        );
    }

    #[test]
    fn rack_room_ids_tolerate_non_arrays() {
        assert!(room_ids_from_placed_racks(&Value::Null).is_empty());
        assert!(room_ids_from_placed_racks(&json!({})).is_empty());
    }
}
