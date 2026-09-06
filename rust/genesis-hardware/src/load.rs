//! Load stock / stored batteries / placed racks / upgrades for intent + persist.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::GenericClient;
use genesis_core::calculator::constants::{ASIC_ROOM_ID, NFT_AUTO_ROOM_ID};
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;
use genesis_core::hardware::types::{HardwareState, PlacedRack, StoredBattery, UpgradeRow};

use crate::leases::row_uuid_string;
use crate::pg_types::pg_user_id;

/// Policy name keys — same as `NFT_AUTO_POLICY_ROOM_NAME_KEYS` in nft-room-mining.ts.
const NFT_AUTO_POLICY_ROOM_NAME_KEYS: &[&str] = &[
    "sala nfts",
    "nfts auto",
    "nft auto",
    "nfts arbam",
    "sala dolar/nfts",
    "sala dolar / nfts",
];

/// Policy name keys — same as `ASIC_POLICY_ROOM_NAME_KEYS` in room-kind.ts.
const ASIC_POLICY_ROOM_NAME_KEYS: &[&str] = &["sala das asics"];

pub async fn load_user_stock<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<HashMap<String, i64>> {
    let uid = pg_user_id(uid)?;
    let rows = client
        .query("SELECT item_id, qty FROM stock WHERE user_id = $1", &[&uid])
        .await?;
    let mut stock = HashMap::new();
    for row in rows {
        let raw: String = row.get("item_id");
        let item_id = normalize_known_1000wh_battery_catalog_id(Some(&raw));
        if item_id.is_empty() {
            continue;
        }
        let qty: i32 = row.get("qty");
        *stock.entry(item_id).or_insert(0) += i64::from(qty);
    }
    Ok(stock)
}

pub async fn load_user_stored_batteries<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<Vec<StoredBattery>> {
    let uid = pg_user_id(uid)?;
    let rows = client
        .query(
            "SELECT id, item_id FROM stored_batteries WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| StoredBattery {
            id: r.get("id"),
            item_id: r.get("item_id"),
            display_name: None,
            image_url: None,
        })
        .collect())
}

pub async fn load_user_placed_racks<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<Vec<PlacedRack>> {
    let uid = pg_user_id(uid)?;
    let rack_rows = client
        .query("SELECT * FROM placed_racks WHERE user_id = $1", &[&uid])
        .await?;
    if rack_rows.is_empty() {
        return Ok(vec![]);
    }
    let rack_ids: Vec<String> = rack_rows.iter().map(|r| r.get::<_, String>("id")).collect();
    let slots_rows = client
        .query(
            "SELECT rack_id, slot_index, machine_item_id, machine_lease_id FROM rack_slots WHERE rack_id = ANY($1) ORDER BY slot_index",
            &[&rack_ids],
        )
        .await?;
    let multi_rows = client
        .query(
            "SELECT rack_id, slot_index, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1) ORDER BY slot_index",
            &[&rack_ids],
        )
        .await?;

    let mut slots_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut lease_map: HashMap<String, Vec<String>> = HashMap::new();
    for s in &slots_rows {
        let rid: String = s.get("rack_id");
        let idx: i32 = s.get("slot_index");
        let mid: Option<String> = s.get("machine_item_id");
        let lid = row_uuid_string(s, "machine_lease_id");
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

pub async fn load_upgrades_with_compat<C: GenericClient>(
    client: &C,
) -> anyhow::Result<Vec<UpgradeRow>> {
    let rows = client.query("SELECT * FROM upgrades", &[]).await?;
    let compat_rows = client
        .query("SELECT upgrade_id, rack_id FROM upgrade_compat_racks", &[])
        .await?;
    let mut compat: HashMap<String, Vec<String>> = HashMap::new();
    for c in compat_rows {
        let uid: String = c.get("upgrade_id");
        let rid: String = c.get("rack_id");
        compat.entry(uid).or_default().push(rid);
    }
    Ok(rows
        .iter()
        .map(|r| {
            let id: String = r.get("id");
            UpgradeRow {
                id: id.clone(),
                type_name: r.try_get("type").ok(),
                category: r.try_get("category").ok(),
                nft_mining_coin_id: r.try_get("nft_mining_coin_id").ok().flatten(),
                power_capacity: r.try_get::<_, f64>("power_capacity").ok(),
                name: r.try_get("name").ok(),
                image: r.try_get("image").ok(),
                slots_capacity: r.try_get::<_, i32>("slots_capacity").ok().map(i64::from),
                ai_slots_capacity: r.try_get::<_, i32>("ai_slots_capacity").ok().map(i64::from),
                is_active: r.try_get::<_, i32>("is_active").ok().map(i64::from),
                compatible_racks: Some(compat.remove(&id).unwrap_or_default()),
                asic_duration_amount: r
                    .try_get::<_, i32>("asic_duration_amount")
                    .ok()
                    .map(i64::from),
                asic_duration_unit: r.try_get("asic_duration_unit").ok().flatten(),
                asic_duration_kind: r.try_get("asic_duration_kind").ok().flatten(),
                rack_room_affinity: r.try_get("rack_room_affinity").ok().flatten(),
                status: r.try_get("status").ok().flatten(),
                is_nft: r.try_get::<_, i32>("is_nft").ok().map(|v| v != 0),
                base_production: r.try_get::<_, f64>("base_production").ok(),
                multiplier: r.try_get::<_, f64>("multiplier").ok(),
            }
        })
        .collect())
}

pub async fn load_hardware_state<C: GenericClient>(
    client: &C,
    uid: i64,
) -> anyhow::Result<HardwareState> {
    Ok(HardwareState {
        stock: load_user_stock(client, uid).await?,
        stored_batteries: load_user_stored_batteries(client, uid).await?,
        placed_racks: load_user_placed_racks(client, uid).await?,
    })
}

pub async fn resolve_nft_room_ids<C: GenericClient>(client: &C) -> anyhow::Result<HashSet<String>> {
    resolve_policy_room_ids(client, NFT_AUTO_ROOM_ID, NFT_AUTO_POLICY_ROOM_NAME_KEYS).await
}

pub async fn resolve_asic_room_ids<C: GenericClient>(
    client: &C,
) -> anyhow::Result<HashSet<String>> {
    resolve_policy_room_ids(client, ASIC_ROOM_ID, ASIC_POLICY_ROOM_NAME_KEYS).await
}

async fn resolve_policy_room_ids<C: GenericClient>(
    client: &C,
    canonical: &str,
    names: &[&str],
) -> anyhow::Result<HashSet<String>> {
    let name_vec: Vec<String> = names.iter().map(|s| (*s).to_string()).collect();
    let rows = client
        .query(
            "SELECT id FROM rig_rooms
             WHERE id = $1
                OR lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = ANY($2::text[])",
            &[&canonical, &name_vec],
        )
        .await
        .unwrap_or_default();
    let mut ids = HashSet::new();
    for row in rows {
        let id: String = row.get("id");
        let t = id.trim();
        if !t.is_empty() {
            ids.insert(normalize_placed_rack_room_id(t));
        }
    }
    ids.insert(normalize_placed_rack_room_id(canonical));
    Ok(ids)
}
