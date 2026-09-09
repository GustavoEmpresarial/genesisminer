//! Room capacity, access gate, NFT coin strip, and persist fail-closed gates.
//!
//! Ported 1:1 from:
//! - `server/modules/rooms/services/room-capacity.ts` (`toCount`, `roomEffectiveCapacity`)
//! - `server/modules/rooms/services/room-access.ts` (gate parse + allow)
//! - `server/modules/servers/services/room-placement.ts` (`countRacksInRoom`)
//! - `stripSelectedCoinFromNftRoomRacks` (`nft-room-mining.ts`)
//! - `validatePlacedRacksForSave` fail-closed gates only (`placed-racks-validate.ts`)

use std::collections::HashMap;
use std::collections::HashSet;

use crate::calculator::constants::{NFT_AUTO_ALLOWED_CHASSIS_ID, ROOM_INITIAL_ID};
use crate::calculator::nft::is_nft_room_exclusive_mining_coin_ref;
use crate::calculator::room_id::normalize_placed_rack_room_id;
use crate::calculator::types::MiningCoinInput;
use crate::hardware::intent::{
    is_chassis_affinity_allowed_in_room, resolve_chassis_affinity_for_place,
};
use crate::hardware::item_id::is_valid_save_game_item_id;
use crate::hardware::rack_compat::merge_catalog_root_id;
use crate::hardware::types::{
    PlacedRack, MAX_AI_SLOTS_CAP, MAX_SLOTS_CAPACITY, STANDARD_ONLY_CHASSIS_ROOT_ID,
};

/// `placed-racks-validate.ts` `MAX_RACKS`.
pub const MAX_PLACED_RACKS: usize = 350;

pub const ERR_ROOM_NOT_AVAILABLE: &str = "Room not available.";
pub const ERR_ROOM_PURCHASE_ACCESS: &str =
    "You must purchase access to this room (or have the required level/pass) before mounting a rig there.";
pub const ERR_ROOM_CAPACITY_EXHAUSTED: &str = "Room capacity exhausted.";

pub const ERR_TOO_MANY_RIGS: &str = "Number of rigs exceeds the limit.";
pub const ERR_INVALID_RIG_ID: &str = "Invalid rig ID.";
pub const ERR_INVALID_CHASSIS: &str = "Invalid chassis.";
pub const ERR_NFT_ROOM_ONLY_H1: &str =
    "In the NFT AUTO room only the Rack H1 NFT Collection chassis is allowed.";
pub const ERR_H1_NFT_OR_ASIC: &str =
    "The Dollar NFT Rack can only be used in the NFT Room or the ASIC Room.";
pub const ERR_STANDARD_ONLY_RACK: &str = "This rack can only be placed in normal rooms.";
pub const ERR_INVALID_WIRING: &str = "Invalid wiring.";
pub const ERR_INVALID_BATTERY: &str = "Invalid battery.";
pub const ERR_TOO_MANY_MACHINE_SLOTS: &str = "Too many machine slots.";
pub const ERR_TOO_MANY_MULTIPLIERS: &str = "Too many multipliers.";
pub const ERR_INVALID_SLOT_PART: &str = "Invalid part in slot.";
pub const ERR_INVALID_MULTIPLIER_PART: &str = "Invalid part in multiplier slot.";
pub const ERR_INVALID_SELECTED_COIN: &str = "Invalid selected coin.";
pub const ERR_INVALID_COIN_ON_RIG: &str = "Invalid coin on a rig.";

/// Same English string as Node `NFT_ROOM_EXCLUSIVE_COIN_ERROR`.
pub const NFT_ROOM_EXCLUSIVE_COIN_ERROR: &str =
    "USDT, USDC, cbBTC, DAI, GHO, and GEMT can only be mined by ASICs in the NFT Room.";

/// Same English string as Node `POST /api/server-room/room-coins` NFT auto-room reject.
pub const NFT_ROOM_COIN_LOCKED_ERROR: &str = "In the NFT Room each ASIC uses the coin set in the admin panel (per model). Bulk coin change is not allowed here.";

/// Same English string as Node `POST /api/server-room/room-coins` ASIC-room reject.
pub const ASIC_ROOM_COIN_LOCKED_ERROR: &str = "In the ASIC Room each machine uses the coin set in the admin panel (per model). Bulk coin change is not allowed here.";

/// Same English strings as Node `save-servers` / `room-coins` coin validation.
pub const ERR_INVALID_COIN: &str = "Invalid coin.";
pub const ERR_UNKNOWN_COIN: &str = "Unknown coin.";
pub const ERR_COIN_DISABLED: &str = "This coin is disabled.";

/// `toCount` in `room-capacity.ts`: floor, finite, `> 0` else `0`.
pub fn to_count(raw: f64) -> i64 {
    if !raw.is_finite() {
        return 0;
    }
    let n = raw.floor() as i64;
    if n > 0 {
        n
    } else {
        0
    }
}

/// Slots the player actually has: `min(max, initial + unlocked)`.
pub fn room_effective_capacity(
    initial_capacity: f64,
    max_capacity: f64,
    unlocked_slots: f64,
) -> i64 {
    let initial = to_count(initial_capacity);
    let max = to_count(max_capacity);
    max.min(initial + to_count(unlocked_slots))
}

/// Slots still purchasable before the room ceiling.
pub fn room_purchasable_slots_remaining(
    initial_capacity: f64,
    max_capacity: f64,
    unlocked_slots: f64,
) -> i64 {
    (to_count(max_capacity)
        - room_effective_capacity(initial_capacity, max_capacity, unlocked_slots))
    .max(0)
}

/// Count racks occupying `room_id`, normalizing both sides (`countRacksInRoom`).
pub fn count_racks_in_room(racks: &[PlacedRack], room_id: &str) -> usize {
    let target = normalize_placed_rack_room_id(room_id);
    racks
        .iter()
        .filter(|r| normalize_placed_rack_room_id(&r.room_id) == target)
        .count()
}

/// Restrictions declared by the room. Empty lists = unrestricted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomAccessGate {
    pub allowed_plan_ids: Vec<String>,
    pub allowed_season_pass_ids: Vec<String>,
}

/// Parse `allowed_levels` / `allowed_season_pass_ids` JSON string arrays.
pub fn parse_json_string_array(raw: Option<&str>) -> Vec<String> {
    let Some(s) = raw.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<serde_json::Value>(s) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .map(|v| match v {
                serde_json::Value::String(t) => t,
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub fn room_access_gate_from_row(
    allowed_levels: Option<&str>,
    allowed_season_pass_ids: Option<&str>,
) -> RoomAccessGate {
    RoomAccessGate {
        allowed_plan_ids: parse_json_string_array(allowed_levels),
        allowed_season_pass_ids: parse_json_string_array(allowed_season_pass_ids),
    }
}

/// Unrestricted room opens to all; otherwise need matching plan **and** pass (if both set).
pub fn is_room_access_allowed_for_user(
    room: &RoomAccessGate,
    plan_ids: &[String],
    pass_ids: &[String],
) -> bool {
    let plan_ok = room.allowed_plan_ids.is_empty()
        || room
            .allowed_plan_ids
            .iter()
            .any(|id| plan_ids.iter().any(|p| p == id));
    let season_ok = room.allowed_season_pass_ids.is_empty()
        || room
            .allowed_season_pass_ids
            .iter()
            .any(|id| pass_ids.iter().any(|p| p == id));
    plan_ok && season_ok
}

pub fn is_initial_free_room(room_id: &str) -> bool {
    room_id == ROOM_INITIAL_ID
}

/// NFT-room coin comes from the ASIC; `selectedCoinId` on the rig confuses validation.
pub fn strip_selected_coin_from_nft_room_racks(
    racks: &mut [PlacedRack],
    nft_room_ids: &HashSet<String>,
) {
    for r in racks.iter_mut() {
        let room = normalize_placed_rack_room_id(&r.room_id);
        if !nft_room_ids.contains(&room) {
            continue;
        }
        let has_coin = r
            .selected_coin_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        if has_coin {
            r.selected_coin_id = None;
        }
    }
}

/// In-memory NFT AUTO sanitize (`sanitizePlacedRacksNftAutoRoom` without battery I/O).
/// Returns dismantled racks (caller credits batteries via DB).
/// `affinity_by_chassis`: catalog `rack_room_affinity` by upgrade id; missing key = None.
pub fn sanitize_nft_auto_room_racks(
    stock: &mut HashMap<String, i64>,
    racks: Vec<PlacedRack>,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
    affinity_by_chassis: &HashMap<String, Option<String>>,
) -> (Vec<PlacedRack>, Vec<PlacedRack>) {
    let mut kept = Vec::new();
    let mut dismantled = Vec::new();
    for mut r in racks {
        let room = normalize_placed_rack_room_id(&r.room_id);
        let chassis = r.item_id.trim().to_string();
        let in_nft = nft_room_ids.contains(&room);
        if in_nft {
            if chassis.is_empty() || chassis == NFT_AUTO_ALLOWED_CHASSIS_ID {
                r.selected_coin_id = None;
                kept.push(r);
                continue;
            }
        } else if chassis == NFT_AUTO_ALLOWED_CHASSIS_ID && !asic_room_ids.contains(&room) {
            // dismantle armario_1 outside NFT/ASIC
        } else if asic_room_ids.contains(&room) && !chassis.is_empty() {
            let catalog_aff = affinity_by_chassis.get(&chassis).and_then(|o| o.as_deref());
            let affinity = resolve_chassis_affinity_for_place(&chassis, catalog_aff);
            if is_chassis_affinity_allowed_in_room(
                &affinity,
                &room,
                Some(nft_room_ids),
                Some(asic_room_ids),
            ) {
                kept.push(r);
                continue;
            }
        } else {
            kept.push(r);
            continue;
        }
        credit_stock(stock, &chassis, 1);
        if let Some(w) = r
            .wiring_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            credit_stock(stock, w, 1);
        }
        for slot in &r.slots {
            let sid = slot.trim();
            if !sid.is_empty() {
                credit_stock(stock, sid, 1);
            }
        }
        for slot in &r.multiplier_slots {
            let mid = slot.trim();
            if !mid.is_empty() {
                credit_stock(stock, mid, 1);
            }
        }
        dismantled.push(r);
    }
    (kept, dismantled)
}

fn credit_stock(stock: &mut HashMap<String, i64>, item_id: &str, n: i64) {
    if item_id.is_empty() || n <= 0 {
        return;
    }
    *stock.entry(item_id.to_string()).or_insert(0) += n;
}

/// Fail-closed persist gates (IDs, limits, NFT/ASIC chassis rules). Exclusive-coin I/O is separate.
pub fn validate_placed_racks_fail_closed(
    racks: &[PlacedRack],
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
) -> Result<(), String> {
    if racks.len() > MAX_PLACED_RACKS {
        return Err(ERR_TOO_MANY_RIGS.to_string());
    }
    for r in racks {
        if !is_valid_save_game_item_id(&r.id) {
            return Err(ERR_INVALID_RIG_ID.to_string());
        }
        if !r.item_id.is_empty() && !is_valid_save_game_item_id(&r.item_id) {
            return Err(ERR_INVALID_CHASSIS.to_string());
        }
        let room = normalize_placed_rack_room_id(&r.room_id);
        let chassis = r.item_id.trim();
        if nft_room_ids.contains(&room)
            && !chassis.is_empty()
            && chassis != NFT_AUTO_ALLOWED_CHASSIS_ID
        {
            return Err(ERR_NFT_ROOM_ONLY_H1.to_string());
        }
        if !nft_room_ids.contains(&room)
            && !asic_room_ids.contains(&room)
            && chassis == NFT_AUTO_ALLOWED_CHASSIS_ID
        {
            return Err(ERR_H1_NFT_OR_ASIC.to_string());
        }
        if !chassis.is_empty()
            && merge_catalog_root_id(chassis) == STANDARD_ONLY_CHASSIS_ROOT_ID
            && (asic_room_ids.contains(&room) || nft_room_ids.contains(&room))
        {
            return Err(ERR_STANDARD_ONLY_RACK.to_string());
        }
        if let Some(w) = r
            .wiring_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !is_valid_save_game_item_id(w) {
                return Err(ERR_INVALID_WIRING.to_string());
            }
        }
        if let Some(b) = r
            .battery_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !is_valid_save_game_item_id(b) {
                return Err(ERR_INVALID_BATTERY.to_string());
            }
        }
        if r.slots.len() > MAX_SLOTS_CAPACITY as usize {
            return Err(ERR_TOO_MANY_MACHINE_SLOTS.to_string());
        }
        if r.multiplier_slots.len() > MAX_AI_SLOTS_CAP as usize {
            return Err(ERR_TOO_MANY_MULTIPLIERS.to_string());
        }
        for s in &r.slots {
            let t = s.trim();
            if t.is_empty() {
                continue;
            }
            if !is_valid_save_game_item_id(t) {
                return Err(ERR_INVALID_SLOT_PART.to_string());
            }
        }
        for s in &r.multiplier_slots {
            let t = s.trim();
            if t.is_empty() {
                continue;
            }
            if !is_valid_save_game_item_id(t) {
                return Err(ERR_INVALID_MULTIPLIER_PART.to_string());
            }
        }
        if let Some(c) = r
            .selected_coin_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !is_valid_save_game_item_id(c) {
                return Err(ERR_INVALID_SELECTED_COIN.to_string());
            }
        }
    }
    Ok(())
}

pub fn exclusive_coin_outside_nft_error(rack_id: &str, room_id: &str) -> String {
    format!(
        "{NFT_ROOM_EXCLUSIVE_COIN_ERROR} (rig {rack_id} in room {room_id} — change that rig's coin or move it to the NFT Room.)"
    )
}

/// Catalog row needed to decide NFT-exclusive coins (`id` + `symbol` + `nft_room_only`).
#[derive(Debug, Clone)]
pub struct ExclusiveCoinMeta {
    pub id: String,
    pub symbol: String,
    pub nft_room_only: bool,
}

fn coin_is_nft_exclusive(meta: &ExclusiveCoinMeta) -> bool {
    is_nft_room_exclusive_mining_coin_ref(&MiningCoinInput {
        id: meta.id.clone(),
        symbol: meta.symbol.clone(),
        name: String::new(),
        network_hashrate: 0.0,
        block_reward: 0.0,
        block_time: 0.0,
        price_usd: 0.0,
        usdc_rate: 0.0,
        nft_room_only: meta.nft_room_only,
        distribution_mode: Default::default(),
        distribution_usd_month: 0.0,
    })
}

/// Fail-closed exclusive-coin gate once `mining_coins` metadata is loaded.
pub fn validate_exclusive_coins_on_racks(
    racks: &[PlacedRack],
    nft_room_ids: &HashSet<String>,
    coins_by_id: &HashMap<String, ExclusiveCoinMeta>,
) -> Result<(), String> {
    for r in racks {
        let Some(cid) = r
            .selected_coin_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let room = normalize_placed_rack_room_id(&r.room_id);
        let chassis = r.item_id.trim();
        if nft_room_ids.contains(&room) || chassis == NFT_AUTO_ALLOWED_CHASSIS_ID {
            continue;
        }
        let Some(meta) = coins_by_id.get(cid) else {
            return Err(ERR_INVALID_COIN_ON_RIG.to_string());
        };
        if coin_is_nft_exclusive(meta) {
            return Err(exclusive_coin_outside_nft_error(&r.id, &room));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rack(id: &str, room: &str, item: &str) -> PlacedRack {
        PlacedRack {
            id: id.into(),
            item_id: item.into(),
            room_id: room.into(),
            ..Default::default()
        }
    }

    #[test]
    fn to_count_floor_finite_positive() {
        assert_eq!(to_count(3.9), 3);
        assert_eq!(to_count(0.0), 0);
        assert_eq!(to_count(-5.0), 0);
        assert_eq!(to_count(f64::NAN), 0);
        assert_eq!(to_count(f64::INFINITY), 0);
    }

    #[test]
    fn effective_capacity_matches_node_suite() {
        assert_eq!(room_effective_capacity(2.0, 10.0, 3.0), 5);
        assert_eq!(room_effective_capacity(2.0, 5.0, 99.0), 5);
        assert_eq!(room_effective_capacity(18.0, 18.0, 17.0), 18);
        assert_eq!(room_effective_capacity(12.0, 18.0, 9.0), 18);
        assert_eq!(room_effective_capacity(4.0, 10.0, 0.0), 4);
        assert_eq!(room_effective_capacity(4.0, 10.0, f64::NAN), 4);
        assert_eq!(room_effective_capacity(4.0, 10.0, -5.0), 4);
        assert_eq!(room_effective_capacity(-3.0, 10.0, 2.0), 2);
        assert_eq!(room_effective_capacity(5.0, 0.0, 3.0), 0);
    }

    #[test]
    fn purchasable_remaining_matches_node() {
        assert_eq!(room_purchasable_slots_remaining(2.0, 10.0, 3.0), 5);
        assert_eq!(room_purchasable_slots_remaining(2.0, 5.0, 3.0), 0);
        assert_eq!(room_purchasable_slots_remaining(18.0, 18.0, 12.0), 0);
        assert_eq!(room_purchasable_slots_remaining(8.0, 5.0, 10.0), 0);
        let initial = 2.0;
        let max = 10.0;
        for unlocked in [0.0, 1.0, 5.0, 8.0, 20.0] {
            let effective = room_effective_capacity(initial, max, unlocked);
            let remaining = room_purchasable_slots_remaining(initial, max, unlocked);
            assert_eq!(effective + remaining, to_count(max));
        }
    }

    #[test]
    fn count_racks_normalizes_both_sides() {
        let racks = vec![
            rack("a", "main", "rack04"),
            rack("b", "room_initial", "rack04"),
            rack("c", "room_other", "rack04"),
        ];
        assert_eq!(count_racks_in_room(&racks, "main"), 2);
        assert_eq!(count_racks_in_room(&racks, "room_initial"), 2);
        assert_eq!(count_racks_in_room(&racks, "room_other"), 1);
    }

    #[test]
    fn access_gate_unrestricted_allows_all() {
        let gate = room_access_gate_from_row(None, None);
        assert!(is_room_access_allowed_for_user(&gate, &[], &[]));
    }

    #[test]
    fn access_gate_requires_plan_and_pass_when_both_set() {
        let gate = room_access_gate_from_row(Some(r#"["vip"]"#), Some(r#"["pass1"]"#));
        assert!(!is_room_access_allowed_for_user(
            &gate,
            &["vip".into()],
            &[]
        ));
        assert!(is_room_access_allowed_for_user(
            &gate,
            &["vip".into()],
            &["pass1".into()]
        ));
    }

    #[test]
    fn strip_clears_nft_room_selected_coin() {
        let mut racks = vec![
            PlacedRack {
                id: "n1".into(),
                room_id: "room_nft".into(),
                selected_coin_id: Some("usdt".into()),
                ..Default::default()
            },
            PlacedRack {
                id: "s1".into(),
                room_id: "room_initial".into(),
                selected_coin_id: Some("btc".into()),
                ..Default::default()
            },
        ];
        let mut nft = HashSet::new();
        nft.insert(normalize_placed_rack_room_id("room_nft"));
        strip_selected_coin_from_nft_room_racks(&mut racks, &nft);
        assert!(racks[0].selected_coin_id.is_none());
        assert_eq!(racks[1].selected_coin_id.as_deref(), Some("btc"));
    }

    #[test]
    fn validate_rejects_over_max_racks_and_bad_nft_chassis() {
        let nft = HashSet::from([normalize_placed_rack_room_id("room_nft")]);
        let asic = HashSet::new();
        let bad = vec![rack("r1", "room_nft", "rack04")];
        assert_eq!(
            validate_placed_racks_fail_closed(&bad, &nft, &asic).unwrap_err(),
            ERR_NFT_ROOM_ONLY_H1
        );
        let too_many: Vec<PlacedRack> = (0..=MAX_PLACED_RACKS)
            .map(|i| rack(&format!("r{i}"), "room_initial", "rack04"))
            .collect();
        assert_eq!(
            validate_placed_racks_fail_closed(&too_many, &HashSet::new(), &HashSet::new())
                .unwrap_err(),
            ERR_TOO_MANY_RIGS
        );
    }

    #[test]
    fn sanitize_dismantles_illegal_nft_racks() {
        let mut stock = HashMap::new();
        stock.insert("gpu_x".into(), 0);
        let racks = vec![
            PlacedRack {
                id: "bad".into(),
                item_id: "rack04".into(),
                room_id: "room_nft".into(),
                wiring_id: Some("wiring_x".into()),
                slots: vec!["gpu_x".into()],
                ..Default::default()
            },
            rack("ok", "room_initial", "rack04"),
        ];
        let nft = HashSet::from([normalize_placed_rack_room_id("room_nft")]);
        let (kept, dismantled) =
            sanitize_nft_auto_room_racks(&mut stock, racks, &nft, &HashSet::new(), &HashMap::new());
        assert_eq!(kept.len(), 1);
        assert_eq!(dismantled.len(), 1);
        assert_eq!(stock.get("rack04").copied(), Some(1));
        assert_eq!(stock.get("wiring_x").copied(), Some(1));
        assert_eq!(stock.get("gpu_x").copied(), Some(1));
    }

    #[test]
    fn sanitize_dismantles_standard_affinity_in_asic_room() {
        use crate::calculator::constants::ASIC_ROOM_ID;
        let mut stock = HashMap::new();
        let racks = vec![
            rack("std", ASIC_ROOM_ID, "rack_a61"),
            rack("army", ASIC_ROOM_ID, "rack_army"),
        ];
        let nft = HashSet::new();
        let asic = HashSet::from([ASIC_ROOM_ID.to_string()]);
        let affinity = HashMap::from([
            ("rack_a61".into(), Some("standard".into())),
            ("rack_army".into(), Some("asic".into())),
        ]);
        let (kept, dismantled) =
            sanitize_nft_auto_room_racks(&mut stock, racks, &nft, &asic, &affinity);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].item_id, "rack_army");
        assert_eq!(dismantled.len(), 1);
        assert_eq!(dismantled[0].item_id, "rack_a61");
        assert_eq!(stock.get("rack_a61").copied(), Some(1));
        assert!(stock.get("rack_army").is_none());
    }
}
