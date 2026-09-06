//! Intent postApply + room capacity + NFT sanitize I/O + persist fail-closed validate.
//! Runs in the same TX as apply + persist (before persist).

use std::collections::{HashMap, HashSet};

use deadpool_postgres::GenericClient;
use genesis_core::calculator::constants::ROOM_INITIAL_ID;
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::capacity::{
    count_racks_in_room, is_initial_free_room, is_room_access_allowed_for_user,
    room_access_gate_from_row, room_effective_capacity, sanitize_nft_auto_room_racks,
    strip_selected_coin_from_nft_room_racks, validate_exclusive_coins_on_racks,
    validate_placed_racks_fail_closed, ExclusiveCoinMeta, ERR_ROOM_CAPACITY_EXHAUSTED,
    ERR_ROOM_NOT_AVAILABLE, ERR_ROOM_PURCHASE_ACCESS,
};
use genesis_core::hardware::catalog::normalize_known_1000wh_battery_catalog_id;
use genesis_core::hardware::duration::is_timed_asic_duration;
use genesis_core::hardware::types::{
    HardwareApplyOk, HardwareState, PlacedRack, StoredBattery, UpgradeRow,
};
use tokio_postgres::Row;

use crate::eligibility::{
    record_mining_eligibility_event, EligibilityEvent, EVENT_RACK_BATTERY_CHANGED,
    EVENT_RACK_MULTIPLIER_CHANGED, EVENT_RACK_WIRING_CHANGED, IDENTITY_RACK,
};
use crate::leases::{
    apply_timed_stock_qty_to_snapshot, clear_rack_slot_machine, finalize_timed_miner_equip,
    load_asic_duration_config, record_placement_miner_equipped, record_placement_miner_unequipped,
    release_all_equipped_leases_on_rack, release_equipped_asic_lease,
    release_equipped_asic_lease_by_id, repair_equipped_asic_leases_for_rack,
    resolve_equipped_lease_id_for_slot,
};
use crate::pg_types::pg_user_id;

#[derive(Debug)]
pub enum PostApplyError {
    Domain(String),
    Transport(anyhow::Error),
}

impl From<anyhow::Error> for PostApplyError {
    fn from(e: anyhow::Error) -> Self {
        Self::Transport(e)
    }
}

fn row_is_active(row: &Row) -> bool {
    if let Ok(v) = row.try_get::<_, i32>("is_active") {
        return v != 0;
    }
    if let Ok(v) = row.try_get::<_, bool>("is_active") {
        return v;
    }
    false
}

async fn resolve_user_room_access<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let uid = pg_user_id(user_id)?;
    let mut plan_ids: HashSet<String> = HashSet::new();
    let user_rows = client
        .query("SELECT access_level_id FROM users WHERE id = $1", &[&uid])
        .await?;
    if let Some(row) = user_rows.first() {
        if let Ok(Some(id)) = row.try_get::<_, Option<String>>("access_level_id") {
            if !id.trim().is_empty() {
                plan_ids.insert(id);
            }
        }
    }
    let grants = client
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    for row in grants {
        let id: String = row.try_get("access_level_id").unwrap_or_default();
        if !id.trim().is_empty() {
            plan_ids.insert(id);
        }
    }
    let passes = client
        .query(
            "SELECT pass_id FROM season_purchases WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let pass_ids = passes
        .iter()
        .map(|r| r.try_get::<_, String>("pass_id").unwrap_or_default())
        .filter(|s| !s.is_empty())
        .collect();
    Ok((plan_ids.into_iter().collect(), pass_ids))
}

/// `assertPlaceRackRoomAccessAndCapacity` — fail → domain 400, same English errors.
pub async fn assert_place_rack_room_access_and_capacity<C: GenericClient>(
    client: &C,
    user_id: i64,
    room_id: &str,
    current_rack_count_in_room: i64,
) -> Result<(), PostApplyError> {
    let room_rows = client
        .query(
            "SELECT id, is_active, initial_capacity, max_capacity, allowed_levels, allowed_season_pass_ids
             FROM rig_rooms WHERE id = $1",
            &[&room_id],
        )
        .await
        .map_err(anyhow::Error::from)?;
    let Some(room) = room_rows.first() else {
        return Err(PostApplyError::Domain(ERR_ROOM_NOT_AVAILABLE.to_string()));
    };
    if !row_is_active(room) {
        return Err(PostApplyError::Domain(ERR_ROOM_NOT_AVAILABLE.to_string()));
    }
    let room_row_id: String = room.get("id");
    if room_row_id != ROOM_INITIAL_ID && !is_initial_free_room(&room_row_id) {
        let uid = pg_user_id(user_id).map_err(PostApplyError::Transport)?;
        let owned = client
            .query(
                "SELECT 1 FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2",
                &[&uid, &room_row_id],
            )
            .await
            .map_err(anyhow::Error::from)?;
        if owned.is_empty() {
            let allowed_levels: Option<String> = room.try_get("allowed_levels").ok().flatten();
            let allowed_passes: Option<String> =
                room.try_get("allowed_season_pass_ids").ok().flatten();
            let gate =
                room_access_gate_from_row(allowed_levels.as_deref(), allowed_passes.as_deref());
            let (plan_ids, pass_ids) = resolve_user_room_access(client, user_id).await?;
            if !is_room_access_allowed_for_user(&gate, &plan_ids, &pass_ids) {
                return Err(PostApplyError::Domain(ERR_ROOM_PURCHASE_ACCESS.to_string()));
            }
        }
    }

    let uid = pg_user_id(user_id).map_err(PostApplyError::Transport)?;
    let user_room = client
        .query(
            "SELECT unlocked_slots FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2",
            &[&uid, &room_id],
        )
        .await
        .map_err(anyhow::Error::from)?;
    let unlocked: i32 = user_room
        .first()
        .and_then(|r| r.try_get::<_, Option<i32>>("unlocked_slots").ok().flatten())
        .unwrap_or(0);
    let initial: i32 = room.try_get("initial_capacity").unwrap_or(0);
    let max: i32 = room.try_get("max_capacity").unwrap_or(0);
    let cap = room_effective_capacity(f64::from(initial), f64::from(max), f64::from(unlocked));
    if current_rack_count_in_room > cap {
        return Err(PostApplyError::Domain(
            ERR_ROOM_CAPACITY_EXHAUSTED.to_string(),
        ));
    }
    Ok(())
}

async fn return_rack_battery_on_sanitize<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack: &PlacedRack,
    stock: &mut HashMap<String, i64>,
    stored: &mut Vec<StoredBattery>,
) -> anyhow::Result<()> {
    let Some(bid) = rack
        .battery_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    let uid = pg_user_id(user_id)?;
    let looks_uuid = uuid::Uuid::parse_str(bid).is_ok();
    if looks_uuid {
        let br = client
            .query(
                "SELECT id, item_id, display_name, image_url FROM stored_batteries WHERE id = $1 AND user_id = $2",
                &[&bid, &uid],
            )
            .await?;
        if let Some(row) = br.first() {
            let id: String = row.get("id");
            if !stored.iter().any(|x| x.id == id) {
                let item_id: String = row.try_get("item_id").unwrap_or_default();
                stored.push(StoredBattery {
                    id,
                    item_id: normalize_known_1000wh_battery_catalog_id(Some(&item_id)),
                    display_name: row.try_get("display_name").ok().flatten(),
                    image_url: row.try_get("image_url").ok().flatten(),
                });
            }
            return Ok(());
        }
        let from_rack = rack
            .battery_catalog_item_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| normalize_known_1000wh_battery_catalog_id(Some(s)))
            .unwrap_or_default();
        if from_rack.is_empty() || from_rack == bid {
            tracing::warn!(
                battery_id = bid,
                "sanitize: stock-minted battery UUID without catalog; skip credit"
            );
            return Ok(());
        }
        *stock.entry(from_rack).or_insert(0) += 1;
        return Ok(());
    }
    let catalog_id = normalize_known_1000wh_battery_catalog_id(Some(bid));
    *stock.entry(catalog_id).or_insert(0) += 1;
    Ok(())
}

/// Port of `sanitizePlacedRacksNftAutoRoom` (in-memory dismantle + battery queries).
pub async fn sanitize_placed_racks_nft_auto_room<C: GenericClient>(
    client: &C,
    user_id: i64,
    state: &mut HardwareState,
    nft_ids: &HashSet<String>,
    asic_ids: &HashSet<String>,
    upgrades: &[UpgradeRow],
    now_ms: i64,
) -> anyhow::Result<()> {
    let affinity_by_chassis: HashMap<String, Option<String>> = upgrades
        .iter()
        .map(|u| (u.id.clone(), u.rack_room_affinity.clone()))
        .collect();
    let racks = std::mem::take(&mut state.placed_racks);
    let (kept, dismantled) = sanitize_nft_auto_room_racks(
        &mut state.stock,
        racks,
        nft_ids,
        asic_ids,
        &affinity_by_chassis,
    );
    for rack in &dismantled {
        if let Err(e) = return_rack_battery_on_sanitize(
            client,
            user_id,
            rack,
            &mut state.stock,
            &mut state.stored_batteries,
        )
        .await
        {
            tracing::warn!(err = %e, rack_id = %rack.id, "sanitize: battery return skipped");
        }
        if let Err(e) = release_all_equipped_leases_on_rack(client, user_id, &rack.id, now_ms).await
        {
            tracing::warn!(err = %e, rack_id = %rack.id, "sanitize: lease release skipped");
        }
    }
    state.placed_racks = kept;
    Ok(())
}

pub async fn validate_placed_racks_for_save<C: GenericClient>(
    client: &C,
    racks: &[PlacedRack],
    nft_ids: &HashSet<String>,
    asic_ids: &HashSet<String>,
) -> Result<(), PostApplyError> {
    if let Err(e) = validate_placed_racks_fail_closed(racks, nft_ids, asic_ids) {
        return Err(PostApplyError::Domain(e));
    }
    let coin_ids: Vec<String> = racks
        .iter()
        .filter_map(|r| {
            r.selected_coin_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .collect();
    if coin_ids.is_empty() {
        return Ok(());
    }
    let rows = client
        .query(
            "SELECT id, symbol, nft_room_only FROM mining_coins WHERE id = ANY($1::text[])",
            &[&coin_ids],
        )
        .await
        .map_err(anyhow::Error::from)?;
    if rows.len() != coin_ids.iter().collect::<HashSet<_>>().len() {
        return Err(PostApplyError::Domain(
            genesis_core::hardware::capacity::ERR_INVALID_COIN_ON_RIG.to_string(),
        ));
    }
    let mut coins = HashMap::new();
    for row in rows {
        let id: String = row.get("id");
        let symbol: String = row.try_get("symbol").unwrap_or_default();
        let nft_room_only = match row.try_get::<_, i32>("nft_room_only") {
            Ok(v) => v != 0,
            Err(_) => row.try_get::<_, bool>("nft_room_only").unwrap_or(false),
        };
        coins.insert(
            id.clone(),
            ExclusiveCoinMeta {
                id,
                symbol,
                nft_room_only,
            },
        );
    }
    validate_exclusive_coins_on_racks(racks, nft_ids, &coins).map_err(PostApplyError::Domain)
}

async fn emit_rack_aux_eligibility_events<C: GenericClient>(
    client: &C,
    user_id: i64,
    rack_id: &str,
    prev: &[PlacedRack],
    next: &[PlacedRack],
    now_ms: i64,
) -> anyhow::Result<()> {
    let Some(prev_r) = prev.iter().find(|r| r.id == rack_id) else {
        return Ok(());
    };
    let Some(next_r) = next.iter().find(|r| r.id == rack_id) else {
        return Ok(());
    };

    let prev_wiring = prev_r
        .wiring_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let next_wiring = next_r
        .wiring_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if prev_wiring != next_wiring {
        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_RACK_WIRING_CHANGED,
                at_ms: now_ms,
                identity_kind: IDENTITY_RACK,
                lease_id: None,
                rack_id: Some(rack_id),
                slot_index: None,
                catalog_item_id: if next_wiring.is_empty() {
                    None
                } else {
                    Some(&next_wiring)
                },
                coin_id: None,
                payload: Some(serde_json::json!({
                    "previous": if prev_wiring.is_empty() { serde_json::Value::Null } else { serde_json::json!(prev_wiring) },
                    "next": if next_wiring.is_empty() { serde_json::Value::Null } else { serde_json::json!(next_wiring) }
                })),
            },
        )
        .await?;
    }

    let prev_battery = prev_r
        .battery_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let next_battery = next_r
        .battery_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let prev_bat_cat = prev_r
        .battery_catalog_item_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let next_bat_cat = next_r
        .battery_catalog_item_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if prev_battery != next_battery || prev_bat_cat != next_bat_cat {
        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_RACK_BATTERY_CHANGED,
                at_ms: now_ms,
                identity_kind: IDENTITY_RACK,
                lease_id: None,
                rack_id: Some(rack_id),
                slot_index: None,
                catalog_item_id: if next_bat_cat.is_empty() {
                    None
                } else {
                    Some(&next_bat_cat)
                },
                coin_id: None,
                payload: Some(serde_json::json!({
                    "previous_battery_id": if prev_battery.is_empty() { serde_json::Value::Null } else { serde_json::json!(prev_battery) },
                    "next_battery_id": if next_battery.is_empty() { serde_json::Value::Null } else { serde_json::json!(next_battery) },
                    "previous_catalog_item_id": if prev_bat_cat.is_empty() { serde_json::Value::Null } else { serde_json::json!(prev_bat_cat) },
                    "next_catalog_item_id": if next_bat_cat.is_empty() { serde_json::Value::Null } else { serde_json::json!(next_bat_cat) }
                })),
            },
        )
        .await?;
    }

    let max_mult = prev_r
        .multiplier_slots
        .len()
        .max(next_r.multiplier_slots.len());
    for i in 0..max_mult {
        let a = prev_r
            .multiplier_slots
            .get(i)
            .map(|s| s.trim())
            .unwrap_or("");
        let b = next_r
            .multiplier_slots
            .get(i)
            .map(|s| s.trim())
            .unwrap_or("");
        if a == b {
            continue;
        }
        record_mining_eligibility_event(
            client,
            EligibilityEvent {
                user_id,
                event_type: EVENT_RACK_MULTIPLIER_CHANGED,
                at_ms: now_ms,
                identity_kind: IDENTITY_RACK,
                lease_id: None,
                rack_id: Some(rack_id),
                slot_index: Some(i as i64),
                catalog_item_id: if b.is_empty() { None } else { Some(b) },
                coin_id: None,
                payload: Some(serde_json::json!({
                    "previous": if a.is_empty() { serde_json::Value::Null } else { serde_json::json!(a) },
                    "next": if b.is_empty() { serde_json::Value::Null } else { serde_json::json!(b) }
                })),
            },
        )
        .await?;
    }
    Ok(())
}

pub struct PostApplyInput<'a> {
    pub user_id: i64,
    pub kind: &'a str,
    pub rack_id: Option<&'a str>,
    pub catalog_item_id: Option<&'a str>,
    pub room_id: Option<&'a str>,
    pub slot_index: Option<i64>,
}

pub async fn run_post_apply<C: GenericClient>(
    client: &C,
    body: &PostApplyInput<'_>,
    prev: &HardwareState,
    out: &mut HardwareApplyOk,
    now_ms: i64,
) -> Result<(), PostApplyError> {
    let kind = body.kind.trim().to_ascii_lowercase();
    let user_id = body.user_id;
    match kind.as_str() {
        "place" => {
            let room_id = normalize_placed_rack_room_id(body.room_id.as_deref().unwrap_or(""));
            let count = count_racks_in_room(&out.placed_racks, &room_id);
            let count_i64 = i64::try_from(count).unwrap_or(i64::MAX);
            assert_place_rack_room_access_and_capacity(client, user_id, &room_id, count_i64)
                .await?;
        }
        "remove" => {
            let rack_id = body.rack_id.as_deref().unwrap_or("");
            let rack_prev = prev.placed_racks.iter().find(|r| r.id == rack_id);
            let mut item_ids: HashSet<String> = HashSet::new();
            if let Some(rack_prev) = rack_prev {
                for (si, slot) in rack_prev.slots.iter().enumerate() {
                    let id = slot.trim();
                    if id.is_empty() {
                        continue;
                    }
                    item_ids.insert(id.to_string());
                    let hint_lease = rack_prev
                        .slot_lease_ids
                        .get(si)
                        .map(|s| s.trim())
                        .unwrap_or("");
                    let cfg = load_asic_duration_config(client, id).await?;
                    if !is_timed_asic_duration(&cfg) && hint_lease.is_empty() {
                        record_placement_miner_unequipped(
                            client,
                            user_id,
                            rack_id,
                            i64::try_from(si).unwrap_or(0),
                            id,
                            now_ms,
                        )
                        .await?;
                    }
                }
            }
            release_all_equipped_leases_on_rack(client, user_id, rack_id, now_ms).await?;
            for item_id in item_ids {
                let cfg = load_asic_duration_config(client, &item_id).await?;
                if is_timed_asic_duration(&cfg) {
                    apply_timed_stock_qty_to_snapshot(
                        client,
                        user_id,
                        &mut out.stock,
                        &item_id,
                        now_ms,
                    )
                    .await?;
                }
            }
        }
        "miner_equip" => {
            let rack_id = body.rack_id.as_deref().unwrap_or("");
            let catalog_item_id = body.catalog_item_id.as_deref().unwrap_or("");
            let si = body.slot_index.unwrap_or(0).max(0);
            let cfg = load_asic_duration_config(client, catalog_item_id).await?;
            if !is_timed_asic_duration(&cfg) {
                record_placement_miner_equipped(
                    client,
                    user_id,
                    rack_id,
                    si,
                    catalog_item_id,
                    now_ms,
                )
                .await?;
            } else {
                let fin = finalize_timed_miner_equip(
                    client,
                    user_id,
                    rack_id,
                    si,
                    catalog_item_id,
                    &mut out.placed_racks,
                    &mut out.stock,
                    now_ms,
                )
                .await?;
                if let Err(e) = fin {
                    return Err(PostApplyError::Domain(e));
                }
            }
        }
        "miner_unequip" => {
            let rack_id = body.rack_id.as_deref().unwrap_or("");
            let si = body.slot_index.unwrap_or(0).max(0);
            let si_usize = si as usize;
            let rack_prev = prev.placed_racks.iter().find(|r| r.id == rack_id);
            let item_id = rack_prev
                .and_then(|r| r.slots.get(si_usize))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            if item_id.is_empty() {
                return Ok(());
            }
            let hint_lease = rack_prev
                .and_then(|r| r.slot_lease_ids.get(si_usize))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            repair_equipped_asic_leases_for_rack(client, user_id, rack_id, now_ms).await?;
            let lease_id = resolve_equipped_lease_id_for_slot(
                client,
                user_id,
                rack_id,
                si,
                &hint_lease,
                now_ms,
            )
            .await?;
            let cfg = load_asic_duration_config(client, &item_id).await?;
            let mut released = false;
            if !lease_id.is_empty() {
                released =
                    release_equipped_asic_lease_by_id(client, user_id, &lease_id, &item_id, now_ms)
                        .await?;
            }
            if !released && is_timed_asic_duration(&cfg) {
                release_equipped_asic_lease(client, user_id, rack_id, si, now_ms).await?;
            } else if !released && !is_timed_asic_duration(&cfg) {
                record_placement_miner_unequipped(client, user_id, rack_id, si, &item_id, now_ms)
                    .await?;
                clear_rack_slot_machine(client, rack_id, si).await?;
            }
            if is_timed_asic_duration(&cfg) {
                apply_timed_stock_qty_to_snapshot(
                    client,
                    user_id,
                    &mut out.stock,
                    &item_id,
                    now_ms,
                )
                .await?;
            }
        }
        "aux_equip" | "aux_unequip" => {
            let rack_id = body.rack_id.as_deref().unwrap_or("");
            emit_rack_aux_eligibility_events(
                client,
                user_id,
                rack_id,
                &prev.placed_racks,
                &out.placed_racks,
                now_ms,
            )
            .await?;
        }
        _ => {}
    }
    Ok(())
}

pub fn strip_nft_coins_before_persist(out: &mut HardwareApplyOk, nft_ids: &HashSet<String>) {
    strip_selected_coin_from_nft_room_racks(&mut out.placed_racks, nft_ids);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_errors_match_node_english() {
        assert_eq!(ERR_ROOM_NOT_AVAILABLE, "Room not available.");
        assert_eq!(ERR_ROOM_CAPACITY_EXHAUSTED, "Room capacity exhausted.");
        assert!(ERR_ROOM_PURCHASE_ACCESS.contains("purchase access"));
    }
}
