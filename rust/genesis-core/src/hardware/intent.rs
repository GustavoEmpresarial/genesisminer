//! Rack place/remove + miner/aux equip/unequip — 1:1 with `rack-aux-intent.ts`.

use std::collections::{HashMap, HashSet};

use crate::calculator::room_id::normalize_placed_rack_room_id;

use super::duration::{is_timed_asic_duration, normalize_asic_duration_config};
use super::item_id::is_valid_save_game_item_id;
use super::rack_compat::{is_compatible_with_rack, merge_catalog_root_id};
use super::room::{
    is_asic_machine_upgrade_row, is_asic_mining_room_id, is_chassis_allowed_in_room,
    is_nft_collectible_machine_row, is_nft_room_catalog_machine_row, resolve_room_kind, room_rules,
    RoomKind, NFT_CHASSIS_ID,
};
use super::types::{
    AuxEquipInput, AuxUnequipInput, HardwareApplyResult, HardwareState, PlacedRack, StoredBattery,
    UpgradeRow, ASIC_ONLY_CHASSIS_ROOT_IDS, COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY,
    DEFAULT_SLOTS_CAP, MAX_AI_SLOTS_CAP, MAX_SLOTS_CAPACITY, MAX_SLOT_INDEX_FALLBACK,
    MAX_SLOT_INDEX_RAW, STANDARD_ONLY_CHASSIS_ROOT_ID,
};

const RANDOM_ID_BYTE_LEN: usize = 16;

fn new_uuid_string() -> String {
    let mut bytes = [0u8; RANDOM_ID_BYTE_LEN];
    if getrandom::getrandom(&mut bytes).is_ok() {
        // RFC 4122 version 4 / variant 1 bits — same shape as `crypto.randomUUID()`.
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        return format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0],
            bytes[1],
            bytes[2],
            bytes[3],
            bytes[4],
            bytes[5],
            bytes[6],
            bytes[7],
            bytes[8],
            bytes[9],
            bytes[10],
            bytes[11],
            bytes[12],
            bytes[13],
            bytes[14],
            bytes[15]
        );
    }
    format!(
        "sb_fallback_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn clone_rack(r: &PlacedRack) -> PlacedRack {
    r.clone()
}

fn find_upgrade<'a>(upgrades: &'a [UpgradeRow], id: &str) -> Option<&'a UpgradeRow> {
    upgrades.iter().find(|u| u.id == id)
}

fn is_battery_upgrade(upgrades: &[UpgradeRow], id: &str) -> bool {
    upgrades
        .iter()
        .any(|u| u.id == id && u.type_name.as_deref() == Some("battery"))
}

fn is_machine_upgrade(upgrades: &[UpgradeRow], id: &str) -> bool {
    upgrades
        .iter()
        .any(|u| u.id == id && u.type_name.as_deref() == Some("machine"))
}

fn upgrade_timed_asic_config(
    upgrades: &[UpgradeRow],
    item_id: &str,
) -> super::duration::AsicDurationConfig {
    let def = find_upgrade(upgrades, item_id);
    normalize_asic_duration_config(
        def.and_then(|d| d.asic_duration_amount),
        def.and_then(|d| d.asic_duration_unit.as_deref()),
        def.and_then(|d| d.asic_duration_kind.as_deref()),
    )
}

fn is_timed_machine_stock_item(upgrades: &[UpgradeRow], item_id: &str) -> bool {
    let Some(def) = find_upgrade(upgrades, item_id) else {
        return false;
    };
    if def.type_name.as_deref() != Some("machine") {
        return false;
    }
    if !is_nft_room_catalog_machine_row(&def.machine_ref()) {
        return false;
    }
    is_timed_asic_duration(&upgrade_timed_asic_config(upgrades, item_id))
}

pub fn resolve_equipped_battery_catalog_id(
    battery_id: Option<&str>,
    stored_batteries: &[StoredBattery],
    upgrades: &[UpgradeRow],
    hints: Option<&HashMap<String, String>>,
) -> Option<String> {
    let bid = battery_id.map(str::trim).filter(|s| !s.is_empty())?;
    if let Some(hinted) = hints.and_then(|h| h.get(bid)).map(|s| s.trim().to_string()) {
        if !hinted.is_empty()
            && upgrades
                .iter()
                .any(|u| u.id == hinted && u.type_name.as_deref() == Some("battery"))
        {
            return Some(hinted);
        }
    }
    if upgrades
        .iter()
        .any(|u| u.id == bid && u.type_name.as_deref() == Some("battery"))
    {
        return Some(bid.to_string());
    }
    let row = stored_batteries.iter().find(|b| b.id == bid);
    let cat = row
        .map(|b| b.item_id.trim().to_string())
        .unwrap_or_default();
    if !cat.is_empty()
        && upgrades
            .iter()
            .any(|u| u.id == cat && u.type_name.as_deref() == Some("battery"))
    {
        return Some(cat);
    }
    None
}

fn return_battery_instance_to_stock(
    stock: &mut HashMap<String, i64>,
    stored_batteries: &mut Vec<StoredBattery>,
    battery_id: &str,
    catalog_id: &str,
) {
    let cat = catalog_id.trim();
    if cat.is_empty() {
        return;
    }
    let id = battery_id.trim();
    if !id.is_empty() {
        stored_batteries.retain(|b| b.id != id);
    }
    *stock.entry(cat.to_string()).or_insert(0) += 1;
}

fn bump_stock(stock: &mut HashMap<String, i64>, id: Option<&str>) {
    let item_id = id.map(str::trim).unwrap_or("");
    if item_id.is_empty() {
        return;
    }
    *stock.entry(item_id.to_string()).or_insert(0) += 1;
}

fn consume_stock_or_delete(stock: &mut HashMap<String, i64>, item_id: &str) {
    let qty = stock.get(item_id).copied().unwrap_or(0) - 1;
    if qty <= 0 {
        stock.remove(item_id);
    } else {
        stock.insert(item_id.to_string(), qty);
    }
}

pub fn resolve_chassis_affinity_for_place(chassis_id: &str, affinity_raw: Option<&str>) -> String {
    if merge_catalog_root_id(chassis_id) == STANDARD_ONLY_CHASSIS_ROOT_ID {
        return "standard".into();
    }
    let from_row = affinity_raw.unwrap_or("").trim().to_ascii_lowercase();
    if !from_row.is_empty() {
        return from_row;
    }
    let id = chassis_id.trim().to_ascii_lowercase();
    if id == NFT_CHASSIS_ID {
        return "nft".into();
    }
    if ASIC_ONLY_CHASSIS_ROOT_IDS.iter().any(|r| *r == id) {
        return "asic".into();
    }
    if ASIC_ONLY_CHASSIS_ROOT_IDS
        .iter()
        .any(|root| id.starts_with(&format!("merge_{root}_")) || id.contains(&format!("_{root}_")))
    {
        return "asic".into();
    }
    COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY.to_string()
}

pub fn is_chassis_affinity_allowed_in_room(
    affinity_raw: &str,
    room_id: &str,
    nft_room_ids: Option<&HashSet<String>>,
    asic_room_ids: Option<&HashSet<String>>,
) -> bool {
    let affinity = affinity_raw.trim().to_ascii_lowercase();
    let in_nft = resolve_room_kind(room_id, nft_room_ids) == RoomKind::Nft;
    let in_asic = is_asic_mining_room_id(room_id, asic_room_ids);
    let in_standard = !in_nft && !in_asic;

    match affinity.as_str() {
        "any" => true,
        "asic" => in_asic,
        "nft" => in_nft,
        "standard" => in_standard,
        "asic+nft" | "nft+asic" => in_asic || in_nft,
        "asic+standard" | "standard+asic" => in_asic || in_standard,
        "nft+standard" | "standard+nft" => in_nft || in_standard,
        _ => in_standard,
    }
}

pub fn apply_rack_miner_equip(
    prev: &HardwareState,
    rack_id: &str,
    slot_index_raw: i64,
    catalog_item_id: &str,
    upgrades: &[UpgradeRow],
    nft_room_ids: Option<&HashSet<String>>,
    asic_room_ids: Option<&HashSet<String>>,
) -> HardwareApplyResult {
    let Some(ri) = prev.placed_racks.iter().position(|r| r.id == rack_id) else {
        return HardwareApplyResult::fail("Rig not found.");
    };

    let slot_index = slot_index_raw;
    if slot_index < 0 {
        return HardwareApplyResult::fail("Invalid GPU slot.");
    }

    let item_id = catalog_item_id.trim();
    if !is_valid_save_game_item_id(item_id) || !is_machine_upgrade(upgrades, item_id) {
        return HardwareApplyResult::fail("Invalid GPU.");
    }

    let Some(def) = upgrades
        .iter()
        .find(|u| u.id == item_id && u.type_name.as_deref() == Some("machine"))
    else {
        return HardwareApplyResult::fail("GPU unavailable or inactive.");
    };
    if def.is_active == Some(0) {
        return HardwareApplyResult::fail("GPU unavailable or inactive.");
    }

    let mut placed_racks: Vec<PlacedRack> = prev.placed_racks.iter().map(clone_rack).collect();
    let mut rack = clone_rack(&placed_racks[ri]);
    let room_norm = normalize_placed_rack_room_id(&rack.room_id);
    let machine_row = def.machine_ref();
    let is_asic_machine = is_asic_machine_upgrade_row(&machine_row);
    let in_asic_room = is_asic_mining_room_id(&room_norm, asic_room_ids);
    let in_nft_room = room_rules(&room_norm, nft_room_ids).asic_machines_only;

    if is_asic_machine && !in_asic_room {
        return HardwareApplyResult::fail("ASIC machines can only be installed in the ASICs Room.");
    }
    if in_asic_room && !is_asic_machine {
        return HardwareApplyResult::fail("Only ASICs can be installed in the ASICs Room.");
    }
    if in_nft_room {
        if !is_nft_collectible_machine_row(&machine_row) {
            return HardwareApplyResult::fail(
                "Only NFT collectible machines can be installed in the NFT Room.",
            );
        }
        let coin = def
            .nft_mining_coin_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        if coin.is_empty() {
            return HardwareApplyResult::fail(
                "This machine has no coin configured in the admin panel (NFT Room) yet.",
            );
        }
    }

    let rack_def = find_upgrade(upgrades, &rack.item_id);
    let declared_slots = rack_def
        .and_then(|d| d.slots_capacity)
        .map(|n| n.max(0).min(MAX_SLOTS_CAPACITY))
        .unwrap_or(0);
    let max_allowed_slot = if declared_slots > 0 {
        declared_slots - 1
    } else {
        MAX_SLOT_INDEX_FALLBACK
    };
    if slot_index > max_allowed_slot {
        return HardwareApplyResult::fail("Invalid GPU slot.");
    }
    while rack.slots.len() <= slot_index as usize {
        rack.slots.push(String::new());
    }
    if !rack.slots[slot_index as usize].is_empty() {
        return HardwareApplyResult::fail("Slot already occupied.");
    }
    if let Some(compat) = def.compatible_racks.as_deref() {
        if !compat.is_empty() && !is_compatible_with_rack(Some(compat), &rack.item_id) {
            return HardwareApplyResult::fail("GPU incompatible with this rig.");
        }
    }

    let mut stock = prev.stock.clone();
    let timed = is_timed_machine_stock_item(upgrades, item_id);
    if !timed {
        if stock.get(item_id).copied().unwrap_or(0) < 1 {
            return HardwareApplyResult::fail("Insufficient stock.");
        }
        consume_stock_or_delete(&mut stock, item_id);
    } else if stock.get(item_id).copied().unwrap_or(0) < 1 {
        return HardwareApplyResult::fail("No valid ASICs in stock (expired or sold out).");
    }

    while rack.slot_lease_ids.len() <= slot_index as usize {
        rack.slot_lease_ids.push(String::new());
    }
    rack.slots[slot_index as usize] = item_id.to_string();
    placed_racks[ri] = rack;
    HardwareApplyResult::ok_state(HardwareState {
        stock,
        stored_batteries: prev.stored_batteries.clone(),
        placed_racks,
    })
}

pub fn apply_rack_miner_unequip(
    prev: &HardwareState,
    rack_id: &str,
    slot_index_raw: i64,
    upgrades: &[UpgradeRow],
) -> HardwareApplyResult {
    let Some(ri) = prev.placed_racks.iter().position(|r| r.id == rack_id) else {
        return HardwareApplyResult::fail("Rig not found.");
    };
    if slot_index_raw < 0 {
        return HardwareApplyResult::fail("Invalid GPU slot.");
    }
    let slot_index = slot_index_raw as usize;
    let mut placed_racks: Vec<PlacedRack> = prev.placed_racks.iter().map(clone_rack).collect();
    let mut rack = clone_rack(&placed_racks[ri]);
    if slot_index >= rack.slots.len() {
        return HardwareApplyResult::fail("Invalid GPU slot.");
    }
    let item_id = rack.slots[slot_index].trim().to_string();
    if item_id.is_empty() {
        return HardwareApplyResult::fail("Nothing equipped in that slot.");
    }

    let mut stock = prev.stock.clone();
    if !is_timed_machine_stock_item(upgrades, &item_id) {
        *stock.entry(item_id).or_insert(0) += 1;
    }
    rack.slots[slot_index] = String::new();
    if rack.slot_lease_ids.len() > slot_index {
        rack.slot_lease_ids[slot_index] = String::new();
    }
    placed_racks[ri] = rack;
    HardwareApplyResult::ok_state(HardwareState {
        stock,
        stored_batteries: prev.stored_batteries.clone(),
        placed_racks,
    })
}

pub fn apply_rack_aux_equip(
    prev: &HardwareState,
    rack_id: &str,
    input: &AuxEquipInput,
    upgrades: &[UpgradeRow],
    rack_hints: Option<&HashMap<String, String>>,
) -> HardwareApplyResult {
    let Some(ri) = prev.placed_racks.iter().position(|r| r.id == rack_id) else {
        return HardwareApplyResult::fail("Rig not found.");
    };
    let mut placed_racks = prev.placed_racks.clone();
    let mut r = clone_rack(&placed_racks[ri]);
    let mut ns = prev.stock.clone();
    let mut nb = prev.stored_batteries.clone();

    let mut old_item_id: Option<String> = None;
    let mut old_battery_id: Option<String> = None;
    match input {
        AuxEquipInput::BatteryFromWarehouse { .. } | AuxEquipInput::BatteryFromStock { .. } => {
            if let Some(bid) = r
                .battery_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                old_item_id = Some(bid.to_string());
                old_battery_id = Some(bid.to_string());
            }
        }
        AuxEquipInput::Wiring { .. } => {
            if let Some(wid) = r
                .wiring_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                old_item_id = Some(wid.to_string());
            }
        }
        AuxEquipInput::Multiplier {
            multiplier_slot_index,
            ..
        } => {
            let idx = *multiplier_slot_index as usize;
            if let Some(mid) = r
                .multiplier_slots
                .get(idx)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                old_item_id = Some(mid.to_string());
            }
        }
    }

    if let Some(old) = old_item_id {
        match input {
            AuxEquipInput::BatteryFromWarehouse { .. } | AuxEquipInput::BatteryFromStock { .. } => {
                if let Some(old_bid) = old_battery_id {
                    if let Some(cat_old) = resolve_equipped_battery_catalog_id(
                        Some(&old_bid),
                        &nb,
                        upgrades,
                        rack_hints,
                    ) {
                        return_battery_instance_to_stock(&mut ns, &mut nb, &old_bid, &cat_old);
                    }
                }
            }
            _ => {
                *ns.entry(old).or_insert(0) += 1;
            }
        }
    }

    match input {
        AuxEquipInput::BatteryFromWarehouse { stored_battery_id } => {
            let sbid = stored_battery_id.trim();
            let Some(s) = nb.iter().find(|b| b.id == sbid).cloned() else {
                return HardwareApplyResult::fail("Battery instance not found.");
            };
            let cat_w = s.item_id.trim().to_string();
            if let Some(up_w) = upgrades
                .iter()
                .find(|u| u.id == cat_w && u.type_name.as_deref() == Some("battery"))
            {
                if let Some(compat) = up_w.compatible_racks.as_deref() {
                    if !compat.is_empty() && !is_compatible_with_rack(Some(compat), &r.item_id) {
                        return HardwareApplyResult::fail("Battery incompatible with this rig.");
                    }
                }
                r.battery_display_name = up_w.name.clone();
                r.battery_image_url = up_w.image.clone();
            }
            nb.retain(|b| b.id != sbid);
            r.battery_id = Some(sbid.to_string());
            r.battery_catalog_item_id = Some(cat_w);
            r.is_on = true;
        }
        AuxEquipInput::BatteryFromStock { catalog_item_id } => {
            let iid = catalog_item_id.trim();
            if !is_valid_save_game_item_id(iid) || !is_battery_upgrade(upgrades, iid) {
                return HardwareApplyResult::fail("Invalid battery item.");
            }
            if let Some(up_s) = upgrades
                .iter()
                .find(|u| u.id == iid && u.type_name.as_deref() == Some("battery"))
            {
                if let Some(compat) = up_s.compatible_racks.as_deref() {
                    if !compat.is_empty() && !is_compatible_with_rack(Some(compat), &r.item_id) {
                        return HardwareApplyResult::fail("Battery incompatible with this rig.");
                    }
                }
                r.battery_display_name = up_s.name.clone();
                r.battery_image_url = up_s.image.clone();
            }
            if ns.get(iid).copied().unwrap_or(0) < 1 {
                return HardwareApplyResult::fail("Insufficient stock.");
            }
            consume_stock_or_delete(&mut ns, iid);
            r.battery_id = Some(new_uuid_string());
            r.battery_catalog_item_id = Some(iid.to_string());
            r.is_on = true;
        }
        AuxEquipInput::Wiring { catalog_item_id } => {
            let iid = catalog_item_id.trim();
            if !is_valid_save_game_item_id(iid) {
                return HardwareApplyResult::fail("Invalid circuit.");
            }
            if let Some(wire_def) = find_upgrade(upgrades, iid) {
                if let Some(compat) = wire_def.compatible_racks.as_deref() {
                    if !compat.is_empty() && !is_compatible_with_rack(Some(compat), &r.item_id) {
                        return HardwareApplyResult::fail("Wiring incompatible with this rig.");
                    }
                }
            }
            if ns.get(iid).copied().unwrap_or(0) < 1 {
                return HardwareApplyResult::fail("Insufficient stock.");
            }
            consume_stock_or_delete(&mut ns, iid);
            r.wiring_id = Some(iid.to_string());
        }
        AuxEquipInput::Multiplier {
            catalog_item_id,
            multiplier_slot_index,
        } => {
            let iid = catalog_item_id.trim();
            let idx = *multiplier_slot_index;
            if idx < 0 {
                return HardwareApplyResult::fail("Invalid slot index.");
            }
            if !is_valid_save_game_item_id(iid) {
                return HardwareApplyResult::fail("Invalid multiplier.");
            }
            if let Some(chip_def) = find_upgrade(upgrades, iid) {
                if let Some(compat) = chip_def.compatible_racks.as_deref() {
                    if !compat.is_empty() && !is_compatible_with_rack(Some(compat), &r.item_id) {
                        return HardwareApplyResult::fail("Chip incompatible with this rig.");
                    }
                }
            }
            if ns.get(iid).copied().unwrap_or(0) < 1 {
                return HardwareApplyResult::fail("Insufficient stock.");
            }
            consume_stock_or_delete(&mut ns, iid);
            let idx_us = idx as usize;
            while r.multiplier_slots.len() <= idx_us {
                r.multiplier_slots.push(String::new());
            }
            r.multiplier_slots[idx_us] = iid.to_string();
        }
    }

    placed_racks[ri] = r;
    HardwareApplyResult::ok_state(HardwareState {
        stock: ns,
        stored_batteries: nb,
        placed_racks,
    })
}

pub fn apply_rack_aux_unequip(
    prev: &HardwareState,
    rack_id: &str,
    input: &AuxUnequipInput,
    upgrades: &[UpgradeRow],
    rack_hints: Option<&HashMap<String, String>>,
) -> HardwareApplyResult {
    let Some(ri) = prev.placed_racks.iter().position(|r| r.id == rack_id) else {
        return HardwareApplyResult::fail("Rig not found.");
    };
    let mut placed_racks = prev.placed_racks.clone();
    let mut r = clone_rack(&placed_racks[ri]);
    let mut ns = prev.stock.clone();
    let mut nb = prev.stored_batteries.clone();

    let id = match input {
        AuxUnequipInput::Battery => r.battery_id.clone(),
        AuxUnequipInput::Wiring => r.wiring_id.clone(),
        AuxUnequipInput::Multiplier {
            multiplier_slot_index,
        } => r
            .multiplier_slots
            .get(*multiplier_slot_index as usize)
            .cloned()
            .filter(|s| !s.is_empty()),
    };
    let Some(id) = id.filter(|s| !s.trim().is_empty()) else {
        return HardwareApplyResult::fail("Nothing equipped in that slot.");
    };

    match input {
        AuxUnequipInput::Battery => {
            let Some(cat_id) =
                resolve_equipped_battery_catalog_id(Some(&id), &nb, upgrades, rack_hints)
            else {
                return HardwareApplyResult::fail("Cannot unequip battery: unknown catalog item.");
            };
            return_battery_instance_to_stock(&mut ns, &mut nb, &id, &cat_id);
            r.battery_id = None;
            r.battery_catalog_item_id = None;
            r.battery_display_name = None;
            r.battery_image_url = None;
            r.is_on = false;
        }
        AuxUnequipInput::Wiring => {
            *ns.entry(id).or_insert(0) += 1;
            r.wiring_id = None;
        }
        AuxUnequipInput::Multiplier {
            multiplier_slot_index,
        } => {
            *ns.entry(id).or_insert(0) += 1;
            let idx = *multiplier_slot_index as usize;
            if idx < r.multiplier_slots.len() {
                r.multiplier_slots[idx] = String::new();
            }
        }
    }

    placed_racks[ri] = r;
    HardwareApplyResult::ok_state(HardwareState {
        stock: ns,
        stored_batteries: nb,
        placed_racks,
    })
}

pub fn apply_remove_rack_to_stock(
    prev: &HardwareState,
    rack_id: &str,
    upgrades: &[UpgradeRow],
    rack_hints: Option<&HashMap<String, String>>,
) -> HardwareApplyResult {
    let Some(ri) = prev.placed_racks.iter().position(|r| r.id == rack_id) else {
        return HardwareApplyResult::fail("Rig not found.");
    };
    let rack = clone_rack(&prev.placed_racks[ri]);
    let mut stock = prev.stock.clone();
    let mut stored_batteries = prev.stored_batteries.clone();

    bump_stock(&mut stock, Some(&rack.item_id));
    bump_stock(&mut stock, rack.wiring_id.as_deref());
    for sid in &rack.slots {
        let id = sid.trim();
        if id.is_empty() {
            continue;
        }
        if is_timed_machine_stock_item(upgrades, id) {
            continue;
        }
        bump_stock(&mut stock, Some(id));
    }
    for mid in &rack.multiplier_slots {
        bump_stock(&mut stock, Some(mid));
    }

    if let Some(battery_id) = rack
        .battery_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(cat_id) = resolve_equipped_battery_catalog_id(
            Some(battery_id),
            &stored_batteries,
            upgrades,
            rack_hints,
        ) {
            return_battery_instance_to_stock(
                &mut stock,
                &mut stored_batteries,
                battery_id,
                &cat_id,
            );
        }
    }

    let placed_racks: Vec<PlacedRack> = prev
        .placed_racks
        .iter()
        .filter(|r| r.id != rack_id)
        .map(clone_rack)
        .collect();
    HardwareApplyResult::ok_state(HardwareState {
        stock,
        stored_batteries,
        placed_racks,
    })
}

pub fn apply_place_rack_from_stock(
    prev: &HardwareState,
    catalog_item_id: &str,
    room_id_raw: &str,
    slot_index_raw: i64,
    upgrades: &[UpgradeRow],
    nft_room_ids: Option<&HashSet<String>>,
    asic_room_ids: Option<&HashSet<String>>,
) -> HardwareApplyResult {
    let type_id = catalog_item_id.trim();
    if type_id.is_empty() || !is_valid_save_game_item_id(type_id) {
        return HardwareApplyResult::fail("Invalid chassis.");
    }
    let Some(def) = find_upgrade(upgrades, type_id) else {
        return HardwareApplyResult::fail("Catalog item not found.");
    };
    if def.is_active == Some(0) {
        return HardwareApplyResult::fail("Item unavailable or inactive.");
    }
    let room_n = normalize_placed_rack_room_id(room_id_raw);
    if room_n.is_empty() || room_n == "null" {
        return HardwareApplyResult::fail("Invalid room.");
    }
    if !is_chassis_allowed_in_room(type_id, &room_n, nft_room_ids, asic_room_ids) {
        return if resolve_room_kind(&room_n, nft_room_ids) == RoomKind::Nft {
            HardwareApplyResult::fail(
                "Only the Rack H1 NFT Collection chassis is allowed in this room.",
            )
        } else {
            HardwareApplyResult::fail(
                "The Dollar NFT Rack can only be mounted in the NFT Room or the ASIC Room.",
            )
        };
    }
    let affinity = resolve_chassis_affinity_for_place(type_id, def.rack_room_affinity.as_deref());
    if !is_chassis_affinity_allowed_in_room(&affinity, &room_n, nft_room_ids, asic_room_ids) {
        return if affinity == "asic" {
            HardwareApplyResult::fail("This chassis can only be placed in the ASICs Room.")
        } else {
            HardwareApplyResult::fail("This chassis is not allowed in this room.")
        };
    }
    if slot_index_raw < 0 || slot_index_raw > MAX_SLOT_INDEX_RAW {
        return HardwareApplyResult::fail("Invalid slot index.");
    }
    let slot_index = slot_index_raw;
    let mut stock = prev.stock.clone();
    let mut stored_batteries = prev.stored_batteries.clone();
    let mut placed_before: Vec<PlacedRack> = prev.placed_racks.iter().map(clone_rack).collect();

    if let Some(occupied_index) = placed_before.iter().position(|r| {
        normalize_placed_rack_room_id(&r.room_id) == room_n && r.slot_index == slot_index
    }) {
        let old_rack = placed_before.remove(occupied_index);
        bump_stock(&mut stock, Some(&old_rack.item_id));
        bump_stock(&mut stock, old_rack.wiring_id.as_deref());
        for sid in &old_rack.slots {
            bump_stock(&mut stock, Some(sid));
        }
        for mid in &old_rack.multiplier_slots {
            bump_stock(&mut stock, Some(mid));
        }
        if let Some(old_battery_id) = old_rack
            .battery_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut hint = HashMap::new();
            if let Some(cat) = old_rack
                .battery_catalog_item_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                hint.insert(old_battery_id.to_string(), cat.to_string());
            }
            let hints = if hint.is_empty() { None } else { Some(&hint) };
            if let Some(cat_id) = resolve_equipped_battery_catalog_id(
                Some(old_battery_id),
                &stored_batteries,
                upgrades,
                hints,
            ) {
                return_battery_instance_to_stock(
                    &mut stock,
                    &mut stored_batteries,
                    old_battery_id,
                    &cat_id,
                );
            }
        }
    }

    let qty = stock.get(type_id).copied().unwrap_or(0);
    if qty < 1 {
        return HardwareApplyResult::fail("Stock insuficiente para montar esta rig.");
    }
    let cap = def
        .slots_capacity
        .filter(|n| *n > 0)
        .map(|n| n.max(1).min(MAX_SLOTS_CAPACITY))
        .unwrap_or(DEFAULT_SLOTS_CAP);
    let ai_cap = def
        .ai_slots_capacity
        .map(|n| n.max(0).min(MAX_AI_SLOTS_CAP))
        .unwrap_or(0);
    let rack_id = new_uuid_string();
    let slots = vec![String::new(); cap as usize];
    let multiplier_slots = vec![String::new(); ai_cap as usize];
    let new_rack = PlacedRack {
        id: rack_id,
        item_id: type_id.to_string(),
        slots,
        slot_lease_ids: Vec::new(),
        multiplier_slots,
        wiring_id: None,
        battery_id: None,
        is_on: false,
        selected_coin_id: None,
        room_id: room_n,
        slot_index,
        battery_catalog_item_id: None,
        battery_display_name: None,
        battery_image_url: None,
    };
    consume_stock_or_delete(&mut stock, type_id);
    placed_before.push(new_rack);
    HardwareApplyResult::ok_state(HardwareState {
        stock,
        stored_batteries,
        placed_racks: placed_before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calculator::constants::ASIC_ROOM_ID;
    use crate::calculator::constants::ROOM_INITIAL_ID;

    fn machine(id: &str, category: &str) -> UpgradeRow {
        UpgradeRow {
            id: id.into(),
            type_name: Some("machine".into()),
            category: Some(category.into()),
            is_active: Some(1),
            ..Default::default()
        }
    }

    fn chassis(id: &str, slots: i64) -> UpgradeRow {
        UpgradeRow {
            id: id.into(),
            type_name: Some("infrastructure".into()),
            slots_capacity: Some(slots),
            is_active: Some(1),
            ..Default::default()
        }
    }

    fn rack_in(room: &str) -> PlacedRack {
        PlacedRack {
            id: "rack1".into(),
            item_id: "rack04_cores".into(),
            slots: vec![String::new(), String::new()],
            room_id: room.into(),
            slot_index: 0,
            ..Default::default()
        }
    }

    #[test]
    fn miner_equip_insufficient_stock() {
        let prev = HardwareState {
            stock: HashMap::new(),
            stored_batteries: vec![],
            placed_racks: vec![rack_in(ROOM_INITIAL_ID)],
        };
        let upgrades = vec![chassis("rack04_cores", 2), machine("gpu_x", "gpu")];
        let out = apply_rack_miner_equip(&prev, "rack1", 0, "gpu_x", &upgrades, None, None);
        match out {
            HardwareApplyResult::Err(e) => assert_eq!(e.error, "Insufficient stock."),
            HardwareApplyResult::Ok(_) => panic!("expected fail"),
        }
    }

    #[test]
    fn miner_equip_slot_occupied() {
        let mut r = rack_in(ROOM_INITIAL_ID);
        r.slots[0] = "gpu_other".into();
        let prev = HardwareState {
            stock: HashMap::from([("gpu_x".into(), 1)]),
            stored_batteries: vec![],
            placed_racks: vec![r],
        };
        let upgrades = vec![chassis("rack04_cores", 2), machine("gpu_x", "gpu")];
        let out = apply_rack_miner_equip(&prev, "rack1", 0, "gpu_x", &upgrades, None, None);
        match out {
            HardwareApplyResult::Err(e) => assert_eq!(e.error, "Slot already occupied."),
            HardwareApplyResult::Ok(_) => panic!("expected fail"),
        }
    }

    #[test]
    fn miner_equip_asic_outside_asic_room() {
        let prev = HardwareState {
            stock: HashMap::from([("asic_x1".into(), 1)]),
            stored_batteries: vec![],
            placed_racks: vec![rack_in(ROOM_INITIAL_ID)],
        };
        let upgrades = vec![chassis("rack04_cores", 2), machine("asic_x1", "asic")];
        let asic_ids = HashSet::from([ASIC_ROOM_ID.to_string()]);
        let out = apply_rack_miner_equip(
            &prev,
            "rack1",
            0,
            "asic_x1",
            &upgrades,
            None,
            Some(&asic_ids),
        );
        match out {
            HardwareApplyResult::Err(e) => {
                assert_eq!(
                    e.error,
                    "ASIC machines can only be installed in the ASICs Room."
                );
            }
            HardwareApplyResult::Ok(_) => panic!("expected fail"),
        }
    }

    #[test]
    fn place_rack_decrements_stock_and_adds_rack() {
        let prev = HardwareState {
            stock: HashMap::from([("rack04_cores".into(), 2)]),
            stored_batteries: vec![],
            placed_racks: vec![],
        };
        let upgrades = vec![chassis("rack04_cores", 10)];
        let out = apply_place_rack_from_stock(
            &prev,
            "rack04_cores",
            ROOM_INITIAL_ID,
            0,
            &upgrades,
            None,
            None,
        );
        match out {
            HardwareApplyResult::Ok(ok) => {
                assert_eq!(ok.stock.get("rack04_cores").copied(), Some(1));
                assert_eq!(ok.placed_racks.len(), 1);
                assert_eq!(ok.placed_racks[0].item_id, "rack04_cores");
                assert_eq!(ok.placed_racks[0].slots.len(), 10);
            }
            HardwareApplyResult::Err(e) => panic!("unexpected {}", e.error),
        }
    }

    #[test]
    fn place_rack_empty_affinity_refuses_asic_room() {
        let prev = HardwareState {
            stock: HashMap::from([("rack04_cores".into(), 1)]),
            stored_batteries: vec![],
            placed_racks: vec![],
        };
        let upgrades = vec![chassis("rack04_cores", 10)];
        let asic_ids = HashSet::from([ASIC_ROOM_ID.to_string()]);
        let out = apply_place_rack_from_stock(
            &prev,
            "rack04_cores",
            ASIC_ROOM_ID,
            0,
            &upgrades,
            None,
            Some(&asic_ids),
        );
        match out {
            HardwareApplyResult::Err(e) => {
                assert_eq!(e.error, "This chassis is not allowed in this room.");
            }
            HardwareApplyResult::Ok(_) => panic!("expected fail"),
        }
    }

    #[test]
    fn place_rack_insufficient_stock() {
        let prev = HardwareState {
            stock: HashMap::new(),
            stored_batteries: vec![],
            placed_racks: vec![],
        };
        let upgrades = vec![chassis("rack04_cores", 10)];
        let out = apply_place_rack_from_stock(
            &prev,
            "rack04_cores",
            ROOM_INITIAL_ID,
            0,
            &upgrades,
            None,
            None,
        );
        match out {
            HardwareApplyResult::Err(e) => {
                assert_eq!(e.error, "Stock insuficiente para montar esta rig.");
            }
            HardwareApplyResult::Ok(_) => panic!("expected fail"),
        }
    }
}
