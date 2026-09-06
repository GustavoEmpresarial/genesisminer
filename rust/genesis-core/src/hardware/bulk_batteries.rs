//! Bulk room battery fill / clear — pure domain (Node `batteries.bulk.ts`).

use std::collections::HashMap;

use uuid::Uuid;

use super::catalog::CANONICAL_1000WH_BATTERY_ID;
use super::item_id::is_valid_save_game_item_id;
use super::rack_compat::is_compatible_with_rack;
use super::types::{PlacedRack, StoredBattery, UpgradeRow};
use crate::calculator::room_id::normalize_placed_rack_room_id;

/// Node `STORED_BATTERY_CATALOG_PENDING_ID`.
pub const STORED_BATTERY_CATALOG_PENDING_ID: &str = "legacy_battery_missing_catalog";
/// Node `ROOM_ID_MAX_LEN`.
pub const ROOM_ID_MAX_LEN: usize = 120;
/// Node `temp_legacy_` prefix for unusable catalog rows.
const TEMP_LEGACY_PREFIX: &str = "temp_legacy_";
/// Node sort key `slot_asc`.
pub const RIG_SORT_SLOT_ASC: &str = "slot_asc";
/// Node sort key `hashrate_desc`.
pub const RIG_SORT_HASHRATE_DESC: &str = "hashrate_desc";
/// UUID hyphen layout lengths — Node `RACK_BATTERY_INSTANCE_UUID_RE`.
const UUID_PART_LENS: [usize; 5] = [8, 4, 4, 4, 12];
const UUID_TOTAL_LEN: usize = 36;

#[derive(Debug, Clone)]
pub struct BulkBatteryPrev {
    pub stock: HashMap<String, i64>,
    pub stored_batteries: Vec<StoredBattery>,
    pub placed_racks: Vec<PlacedRack>,
}

#[derive(Debug, Clone)]
pub struct BulkRoomBatteryResult {
    pub ok: bool,
    pub message: Option<String>,
    pub next: Option<BulkBatteryPrev>,
    pub applied_rigs: Option<usize>,
    pub compatible_rigs: Option<usize>,
    pub smart_fill: Option<bool>,
}

impl BulkRoomBatteryResult {
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(msg.into()),
            next: None,
            applied_rigs: None,
            compatible_rigs: None,
            smart_fill: None,
        }
    }
}

/// Node `RACK_BATTERY_INSTANCE_UUID_RE` (version nibble 1–8, variant 8|9|a|b).
pub fn is_rack_battery_instance_uuid(battery_id: &str) -> bool {
    let s = battery_id.trim();
    if s.len() != UUID_TOTAL_LEN {
        return false;
    }
    let bytes = s.as_bytes();
    let mut i = 0usize;
    for (part_i, &part_len) in UUID_PART_LENS.iter().enumerate() {
        if part_i > 0 {
            if bytes.get(i) != Some(&b'-') {
                return false;
            }
            i += 1;
        }
        for j in 0..part_len {
            let b = match bytes.get(i + j) {
                Some(b) => *b,
                None => return false,
            };
            let hex = b.is_ascii_hexdigit();
            if !hex {
                return false;
            }
            if part_i == 2 && j == 0 {
                let c = (b as char).to_ascii_lowercase();
                if !('1'..='8').contains(&c) {
                    return false;
                }
            }
            if part_i == 3 && j == 0 {
                let c = (b as char).to_ascii_lowercase();
                if !matches!(c, '8' | '9' | 'a' | 'b') {
                    return false;
                }
            }
        }
        i += part_len;
    }
    true
}

pub fn is_valid_room_id(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() || s.len() > ROOM_ID_MAX_LEN {
        return false;
    }
    !s.bytes().any(|b| b <= 0x1f || b == b'<' || b == b'>')
}

pub fn is_valid_battery_selection_id(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return true;
    }
    is_valid_save_game_item_id(s)
}

pub fn is_valid_battery_rig_sort(raw: &str) -> bool {
    raw == RIG_SORT_SLOT_ASC || raw == RIG_SORT_HASHRATE_DESC
}

pub fn parse_boolean_smart_fill(raw: &serde_json::Value) -> bool {
    match raw {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_i64() == Some(1) || n.as_u64() == Some(1),
        serde_json::Value::String(s) => s == "1" || s == "true",
        _ => false,
    }
}

fn is_usable_battery_catalog(def: &UpgradeRow) -> bool {
    if def.type_name.as_deref() != Some("battery") {
        return false;
    }
    if def.id.is_empty()
        || def.id == STORED_BATTERY_CATALOG_PENDING_ID
        || def.id.starts_with(TEMP_LEGACY_PREFIX)
    {
        return false;
    }
    if def.category.as_deref() == Some("legacy-temp") {
        return false;
    }
    match def.status.as_deref() {
        Some("legacy" | "exclusive" | "retired") => return false,
        _ => {}
    }
    if def.is_active == Some(0) || def.is_nft == Some(true) {
        return false;
    }
    true
}

fn is_battery_available_for_rack_use(row: &StoredBattery) -> bool {
    !row.id.trim().is_empty() && !row.item_id.trim().is_empty()
}

pub fn total_battery_instances(
    battery_item_id: &str,
    stock: &HashMap<String, i64>,
    stored: &[StoredBattery],
) -> i64 {
    if battery_item_id.is_empty() {
        return 0;
    }
    let s = stock.get(battery_item_id).copied().unwrap_or(0).max(0);
    let in_storage = stored
        .iter()
        .filter(|b| is_battery_available_for_rack_use(b) && b.item_id == battery_item_id)
        .count() as i64;
    s + in_storage
}

pub fn rack_theoretical_hash(
    placed_racks: &[PlacedRack],
    rack_index: usize,
    upgrades: &[UpgradeRow],
) -> f64 {
    let Some(rack) = placed_racks.get(rack_index) else {
        return 0.0;
    };
    let mut base = 0.0;
    for sid in &rack.slots {
        if sid.is_empty() {
            continue;
        }
        if let Some(u) = upgrades.iter().find(|u| u.id == *sid) {
            base += u.base_production.unwrap_or(0.0);
        }
    }
    let mut mult = 1.0;
    for sid in &rack.multiplier_slots {
        if sid.is_empty() {
            continue;
        }
        if let Some(u) = upgrades.iter().find(|u| u.id == *sid) {
            if let Some(m) = u.multiplier {
                mult += m;
            }
        }
    }
    base * mult
}

fn sort_rack_indices_for_allocation(
    indices: &[usize],
    placed_racks: &[PlacedRack],
    upgrades: &[UpgradeRow],
    rig_sort: &str,
) -> Vec<usize> {
    let mut arr = indices.to_vec();
    arr.sort_by(|&ai, &bi| {
        if rig_sort == RIG_SORT_HASHRATE_DESC {
            let ha = rack_theoretical_hash(placed_racks, ai, upgrades);
            let hb = rack_theoretical_hash(placed_racks, bi, upgrades);
            if (hb - ha).abs() > f64::EPSILON {
                return hb.partial_cmp(&ha).unwrap_or(std::cmp::Ordering::Equal);
            }
        }
        let sa = placed_racks
            .get(ai)
            .map(|r| r.slot_index)
            .unwrap_or(ai as i64);
        let sb = placed_racks
            .get(bi)
            .map(|r| r.slot_index)
            .unwrap_or(bi as i64);
        sa.cmp(&sb).then_with(|| ai.cmp(&bi))
    });
    arr
}

pub fn compatible_rack_indices_for_battery(
    placed_racks: &[PlacedRack],
    room_id: &str,
    bat_def: &UpgradeRow,
) -> Vec<usize> {
    if room_id.is_empty() || bat_def.type_name.as_deref() != Some("battery") {
        return vec![];
    }
    let room_norm = normalize_placed_rack_room_id(room_id);
    placed_racks
        .iter()
        .enumerate()
        .filter(|(_, r)| normalize_placed_rack_room_id(&r.room_id) == room_norm)
        .filter(|(_, rack)| {
            let compat = bat_def.compatible_racks.as_deref();
            match compat {
                None | Some([]) => true,
                Some(list) => is_compatible_with_rack(Some(list), &rack.item_id),
            }
        })
        .map(|(i, _)| i)
        .collect()
}

fn unload_rack_battery_to_inventory(
    rack: &PlacedRack,
    ns: &mut HashMap<String, i64>,
    nb: &mut Vec<StoredBattery>,
    upgrades: &[UpgradeRow],
) {
    let Some(raw) = rack.battery_id.as_deref() else {
        return;
    };
    let id = raw.trim();
    if id.is_empty() {
        return;
    }

    let mut bump_stock = |catalog_id: &str| {
        let cat = catalog_id.trim();
        if cat.is_empty() {
            return;
        }
        let Some(upg) = upgrades
            .iter()
            .find(|u| u.id == cat && u.type_name.as_deref() == Some("battery"))
        else {
            return;
        };
        if !is_usable_battery_catalog(upg) {
            return;
        }
        *ns.entry(cat.to_string()).or_insert(0) += 1;
    };

    if let Some(inst_idx) = nb.iter().position(|b| b.id.trim() == id) {
        let row = nb.remove(inst_idx);
        bump_stock(&row.item_id);
        return;
    }

    if is_rack_battery_instance_uuid(id) {
        let cat_from_rack = rack
            .battery_catalog_item_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        let cat = if cat_from_rack.is_empty() {
            CANONICAL_1000WH_BATTERY_ID
        } else {
            cat_from_rack
        };
        bump_stock(cat);
        return;
    }

    bump_stock(id);
}

fn take_one_battery_unit(
    battery_item_id: &str,
    ns: &mut HashMap<String, i64>,
    nb: &mut Vec<StoredBattery>,
) -> Option<String> {
    let qty = ns.get(battery_item_id).copied().unwrap_or(0);
    if qty > 0 {
        let next = qty - 1;
        if next <= 0 {
            ns.remove(battery_item_id);
        } else {
            ns.insert(battery_item_id.to_string(), next);
        }
        return Some(Uuid::new_v4().to_string());
    }
    let matching: Vec<String> = nb
        .iter()
        .filter(|b| is_battery_available_for_rack_use(b) && b.item_id == battery_item_id)
        .map(|b| b.id.clone())
        .collect();
    let best = matching.first()?.clone();
    let idx = nb.iter().position(|x| x.id == best)?;
    let taken = nb.remove(idx);
    Some(taken.id)
}

fn apply_bulk_room_battery_smart_fill(
    prev: &BulkBatteryPrev,
    room_id: &str,
    upgrades: &[UpgradeRow],
    rig_sort: &str,
) -> BulkRoomBatteryResult {
    let room = normalize_placed_rack_room_id(room_id);
    if room.is_empty() {
        return BulkRoomBatteryResult::err("Invalid room.");
    }

    let racks_in_room_idx: Vec<usize> = prev
        .placed_racks
        .iter()
        .enumerate()
        .filter(|(_, r)| normalize_placed_rack_room_id(&r.room_id) == room)
        .map(|(i, _)| i)
        .collect();
    if racks_in_room_idx.is_empty() {
        return BulkRoomBatteryResult::err("No rigs in this room.");
    }

    let mut ns = prev.stock.clone();
    let mut nb = prev.stored_batteries.clone();
    let mut out = prev.placed_racks.clone();

    for &i in &racks_in_room_idx {
        let rack = out[i].clone();
        if rack
            .battery_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            continue;
        }
        unload_rack_battery_to_inventory(&rack, &mut ns, &mut nb, upgrades);
        out[i].battery_id = None;
        out[i].battery_catalog_item_id = None;
        out[i].battery_display_name = None;
        out[i].battery_image_url = None;
        out[i].is_on = false;
    }

    #[derive(Clone)]
    struct PoolEntry {
        item_id: String,
        storage_id: Option<String>,
    }
    let mut pool: Vec<PoolEntry> = Vec::new();

    for u in upgrades {
        if !is_usable_battery_catalog(u) {
            continue;
        }
        let qty_stock = ns.get(&u.id).copied().unwrap_or(0).max(0);
        let stored_list: Vec<&StoredBattery> = nb
            .iter()
            .filter(|b| is_battery_available_for_rack_use(b) && b.item_id == u.id)
            .collect();
        if qty_stock == 0 && stored_list.is_empty() {
            continue;
        }
        let usable_on_any = racks_in_room_idx.iter().any(|&ri| {
            let ch = &out[ri].item_id;
            if ch.is_empty() {
                return false;
            }
            match u.compatible_racks.as_deref() {
                None | Some([]) => true,
                Some(list) => is_compatible_with_rack(Some(list), ch),
            }
        });
        if !usable_on_any {
            continue;
        }
        for s in stored_list {
            pool.push(PoolEntry {
                item_id: u.id.clone(),
                storage_id: Some(s.id.clone()),
            });
        }
        for _ in 0..qty_stock {
            pool.push(PoolEntry {
                item_id: u.id.clone(),
                storage_id: None,
            });
        }
    }

    if pool.is_empty() {
        return BulkRoomBatteryResult::err(
            "No batteries in stock compatible with rigs in this room.",
        );
    }

    let sorted_racks =
        sort_rack_indices_for_allocation(&racks_in_room_idx, &out, upgrades, rig_sort);
    let mut applied = 0usize;

    for ri in sorted_racks {
        let rack = out[ri].clone();
        let ch = rack.item_id.clone();
        let idx = pool.iter().position(|p| {
            let Some(def) = upgrades.iter().find(|x| x.id == p.item_id) else {
                return false;
            };
            if !is_usable_battery_catalog(def) {
                return false;
            }
            match def.compatible_racks.as_deref() {
                None | Some([]) => true,
                Some(list) => is_compatible_with_rack(Some(list), &ch),
            }
        });
        let Some(idx) = idx else {
            continue;
        };
        let picked = pool.remove(idx);
        let Some(def) = upgrades.iter().find(|x| x.id == picked.item_id) else {
            continue;
        };

        if let Some(ref sid) = picked.storage_id {
            let Some(sbi) = nb.iter().position(|x| x.id == *sid) else {
                continue;
            };
            nb.remove(sbi);
        } else {
            let qty = ns.get(&picked.item_id).copied().unwrap_or(0);
            if qty < 1 {
                continue;
            }
            let next = qty - 1;
            if next <= 0 {
                ns.remove(&picked.item_id);
            } else {
                ns.insert(picked.item_id.clone(), next);
            }
        }

        let rack_batt_id = picked
            .storage_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        out[ri].battery_id = Some(rack_batt_id);
        out[ri].battery_catalog_item_id = Some(picked.item_id.clone());
        out[ri].battery_display_name = def.name.clone();
        out[ri].battery_image_url = def.image.clone();
        out[ri].is_on = true;
        applied += 1;
    }

    BulkRoomBatteryResult {
        ok: true,
        message: None,
        next: Some(BulkBatteryPrev {
            stock: ns,
            stored_batteries: nb,
            placed_racks: out,
        }),
        applied_rigs: Some(applied),
        compatible_rigs: Some(racks_in_room_idx.len()),
        smart_fill: Some(true),
    }
}

fn apply_bulk_room_battery_change(
    prev: &BulkBatteryPrev,
    room_id: &str,
    battery_upgrade_id: &str,
    upgrades: &[UpgradeRow],
    rig_sort: &str,
) -> BulkRoomBatteryResult {
    let room = normalize_placed_rack_room_id(room_id);
    if room.is_empty() {
        return BulkRoomBatteryResult::err("Invalid room.");
    }

    let racks_in_room_idx: Vec<usize> = prev
        .placed_racks
        .iter()
        .enumerate()
        .filter(|(_, r)| normalize_placed_rack_room_id(&r.room_id) == room)
        .map(|(i, _)| i)
        .collect();

    if battery_upgrade_id.is_empty() {
        let mut ns = prev.stock.clone();
        let mut nb = prev.stored_batteries.clone();
        let mut out = prev.placed_racks.clone();
        for &i in &racks_in_room_idx {
            let rack = out[i].clone();
            if rack
                .battery_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                continue;
            }
            unload_rack_battery_to_inventory(&rack, &mut ns, &mut nb, upgrades);
            out[i].battery_id = None;
            out[i].battery_catalog_item_id = None;
            out[i].battery_display_name = None;
            out[i].battery_image_url = None;
            out[i].is_on = false;
        }
        return BulkRoomBatteryResult {
            ok: true,
            message: None,
            next: Some(BulkBatteryPrev {
                stock: ns,
                stored_batteries: nb,
                placed_racks: out,
            }),
            applied_rigs: Some(0),
            compatible_rigs: Some(0),
            smart_fill: Some(false),
        };
    }

    let Some(bat_def) = upgrades
        .iter()
        .find(|u| u.id == battery_upgrade_id && u.type_name.as_deref() == Some("battery"))
    else {
        return BulkRoomBatteryResult::err("Invalid battery.");
    };
    if !is_usable_battery_catalog(bat_def) {
        return BulkRoomBatteryResult::err("Invalid battery.");
    }

    let mut compatible_idx =
        compatible_rack_indices_for_battery(&prev.placed_racks, &room, bat_def);
    if compatible_idx.is_empty() {
        return BulkRoomBatteryResult::err(
            "No rig in this room is compatible with this battery type.",
        );
    }
    compatible_idx =
        sort_rack_indices_for_allocation(&compatible_idx, &prev.placed_racks, upgrades, rig_sort);

    let total_avail =
        total_battery_instances(battery_upgrade_id, &prev.stock, &prev.stored_batteries);
    if total_avail <= 0 {
        let name = bat_def.name.as_deref().unwrap_or(battery_upgrade_id);
        return BulkRoomBatteryResult::err(format!("No units of \"{name}\" in stock."));
    }

    let n_apply = (compatible_idx.len() as i64).min(total_avail) as usize;
    let mut ns = prev.stock.clone();
    let mut nb = prev.stored_batteries.clone();
    let mut out = prev.placed_racks.clone();

    for k in 0..n_apply {
        let i = compatible_idx[k];
        let mut rack = out[i].clone();
        if rack
            .battery_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
        {
            unload_rack_battery_to_inventory(&rack, &mut ns, &mut nb, upgrades);
        }
        let Some(instance_id) = take_one_battery_unit(battery_upgrade_id, &mut ns, &mut nb) else {
            return BulkRoomBatteryResult::err("Failed to remove unit from stock. Try again.");
        };
        let rack_batt_id = if instance_id.trim().is_empty() {
            Uuid::new_v4().to_string()
        } else {
            instance_id
        };
        rack.battery_id = Some(rack_batt_id);
        rack.battery_catalog_item_id = Some(battery_upgrade_id.to_string());
        rack.battery_display_name = bat_def.name.clone();
        rack.battery_image_url = bat_def.image.clone();
        rack.is_on = true;
        out[i] = rack;
    }

    BulkRoomBatteryResult {
        ok: true,
        message: None,
        next: Some(BulkBatteryPrev {
            stock: ns,
            stored_batteries: nb,
            placed_racks: out,
        }),
        applied_rigs: Some(n_apply),
        compatible_rigs: Some(compatible_idx.len()),
        smart_fill: Some(false),
    }
}

/// Node `runBulkRoomBattery`.
pub fn run_bulk_room_battery(
    prev: &BulkBatteryPrev,
    room_norm: &str,
    battery_upgrade_id: &str,
    upgrades: &[UpgradeRow],
    smart_fill: bool,
    rig_sort_raw: &str,
) -> BulkRoomBatteryResult {
    if !is_valid_room_id(room_norm) {
        return BulkRoomBatteryResult::err("Invalid room.");
    }
    let rig_sort = if is_valid_battery_rig_sort(rig_sort_raw) {
        rig_sort_raw
    } else {
        RIG_SORT_SLOT_ASC
    };

    if smart_fill {
        if !battery_upgrade_id.is_empty() {
            return BulkRoomBatteryResult::err(
                "In smart mode you cannot have a battery type selected in the list.",
            );
        }
        return apply_bulk_room_battery_smart_fill(prev, room_norm, upgrades, rig_sort);
    }

    if !battery_upgrade_id.is_empty() && !is_valid_battery_selection_id(battery_upgrade_id) {
        return BulkRoomBatteryResult::err("Invalid battery identifier.");
    }
    apply_bulk_room_battery_change(prev, room_norm, battery_upgrade_id, upgrades, rig_sort)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_id_validation() {
        assert!(is_valid_room_id("room_1"));
        assert!(!is_valid_room_id(""));
        assert!(!is_valid_room_id("a<b"));
    }

    #[test]
    fn uuid_instance_check() {
        assert!(is_rack_battery_instance_uuid(
            "550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!is_rack_battery_instance_uuid("battery_estelar"));
    }

    #[test]
    fn clear_room_ok() {
        let mut stock = HashMap::new();
        stock.insert("battery_estelar".into(), 0);
        let prev = BulkBatteryPrev {
            stock,
            stored_batteries: vec![],
            placed_racks: vec![PlacedRack {
                id: "r1".into(),
                item_id: "rack01".into(),
                room_id: "room_a".into(),
                battery_id: Some("battery_estelar".into()),
                is_on: true,
                ..Default::default()
            }],
        };
        let upgrades = vec![UpgradeRow {
            id: "battery_estelar".into(),
            type_name: Some("battery".into()),
            is_active: Some(1),
            name: Some("Estelar".into()),
            ..Default::default()
        }];
        let out = run_bulk_room_battery(&prev, "room_a", "", &upgrades, false, RIG_SORT_SLOT_ASC);
        assert!(out.ok);
        let next = out.next.unwrap();
        assert!(next.placed_racks[0].battery_id.is_none());
        assert!(!next.placed_racks[0].is_on);
        assert_eq!(next.stock.get("battery_estelar").copied().unwrap_or(0), 1);
    }
}
