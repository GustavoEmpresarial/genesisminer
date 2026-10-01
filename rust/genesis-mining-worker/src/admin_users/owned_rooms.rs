//! Admin grant/revoke of `user_rig_rooms` — Node `owned-rooms.ts` + `owned-rooms-diff.ts`.
//!
//! genesis-api orchestrates hardware persist between prepare and finalize when
//! rooms are revoked (Node `callHardwarePersist` with keep racks, no stock →
//! recovery).

use std::collections::HashSet;

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::constants::{ASIC_ROOM_ID, EXTRA_ROOM_ID, ROOM_INITIAL_ID};
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::hardware::types::PlacedRack;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::{now_ms, pg_user_id, PlayerReadError};

use super::{CODE_NOT_FOUND, CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_NOT_FOUND};

pub const ADMIN_OWNED_ROOMS_PREPARE_PATH: &str = "/v1/admin/users/owned-rooms-prepare";
pub const ADMIN_OWNED_ROOMS_FINALIZE_PATH: &str = "/v1/admin/users/owned-rooms-finalize";

/// Node `RIG_ROOM_ACTIVE`.
const RIG_ROOM_ACTIVE: i32 = 1;
/// Node `ADMIN_GRANT_UNLOCKED_SLOTS`.
const ADMIN_GRANT_UNLOCKED_SLOTS: i32 = 0;

const ERR_INVALID_USER: &str = "Invalid user id.";
const ERR_USER_NOT_FOUND: &str = "Utilizador não encontrado.";

const DEFAULT_PLAYER_GRANT_ROOM_IDS: &[&str] = &[ASIC_ROOM_ID, EXTRA_ROOM_ID];
const ALWAYS_OWNED_ROOM_IDS: &[&str] = &[ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID];

const _: () = assert!(RIG_ROOM_ACTIVE == 1);
const _: () = assert!(ADMIN_GRANT_UNLOCKED_SLOTS == 0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRoomsPrepareRequest {
    pub user_id: i64,
    #[serde(default)]
    pub room_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRoomsFinalizeRequest {
    pub user_id: i64,
    #[serde(default)]
    pub to_add: Vec<String>,
    #[serde(default)]
    pub to_remove: Vec<String>,
    #[serde(default)]
    pub removed_rack_count: i64,
}

pub async fn run_owned_rooms_prepare(
    pool: &Pool,
    req: &OwnedRoomsPrepareRequest,
) -> Result<Value, PlayerReadError> {
    if req.user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_USER,
            CODE_VALIDATION,
        ));
    }
    let uid = pg_user_id(req.user_id)?;
    let conn = pool.get().await?;

    let exists = conn
        .query_opt("SELECT 1 FROM users WHERE id = $1", &[&uid])
        .await?;
    if exists.is_none() {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    }

    let active_ids = load_active_room_ids(&conn).await?;
    let urr_ids = load_owned_room_ids(&conn, uid).await?;
    let rack_room_ids = load_placed_rack_room_ids(&conn, uid).await?;
    let mut current_ids = urr_ids.clone();
    current_ids.extend(rack_room_ids);

    let desired: Vec<String> = req
        .room_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let (mut to_add, to_remove) = compute_owned_room_diff(&current_ids, &desired, &active_ids);

    let urr_set: HashSet<String> = urr_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    for id in DEFAULT_PLAYER_GRANT_ROOM_IDS {
        let id = (*id).to_string();
        if active_ids.contains(&id) && !urr_set.contains(&id) && !to_add.contains(&id) {
            to_add.push(id);
        }
    }

    if to_add.is_empty() && to_remove.is_empty() {
        return Ok(json!({
            "noop": true,
            "ownedRoomIds": ensure_owned_room_ids(&current_ids),
            "removedRackCount": 0,
            "toAdd": [],
            "toRemove": [],
            "keepPlacedRacks": Value::Null,
        }));
    }

    let (keep_racks, removed_count) = if to_remove.is_empty() {
        (Value::Null, 0_i64)
    } else {
        let racks = crate::admin_users::save_game_override::load_user_placed_racks_for_admin(
            &conn, uid,
        )
        .await?;
        let (keep, removed) = partition_racks_for_room_revoke(&racks, &to_remove);
        (
            serde_json::to_value(&keep).unwrap_or(json!([])),
            removed.len() as i64,
        )
    };

    Ok(json!({
        "noop": false,
        "toAdd": to_add,
        "toRemove": to_remove,
        "keepPlacedRacks": keep_racks,
        "removedRackCount": removed_count,
    }))
}

pub async fn run_owned_rooms_finalize(
    pool: &Pool,
    req: &OwnedRoomsFinalizeRequest,
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

    let exists = tx
        .query_opt("SELECT 1 FROM users WHERE id = $1", &[&uid])
        .await?;
    if exists.is_none() {
        let _ = tx.rollback().await;
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    }

    if !req.to_add.is_empty() {
        let purchased_at = now_ms();
        for room_id in &req.to_add {
            let rid = room_id.trim();
            if rid.is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, room_id) DO NOTHING",
                &[&uid, &rid, &purchased_at, &ADMIN_GRANT_UNLOCKED_SLOTS],
            )
            .await?;
        }
    }

    if !req.to_remove.is_empty() {
        let remove: Vec<&str> = req
            .to_remove
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if !remove.is_empty() {
            tx.execute(
                "DELETE FROM user_rig_rooms WHERE user_id = $1 AND room_id = ANY($2::text[])",
                &[&uid, &remove],
            )
            .await?;
        }
    }

    let owned = load_owned_room_ids(&tx, uid).await?;
    tx.commit().await?;

    Ok(json!({
        "ok": true,
        "ownedRoomIds": ensure_owned_room_ids(&owned),
        "removedRackCount": req.removed_rack_count.max(0),
    }))
}

async fn load_active_room_ids<C: GenericClient>(
    client: &C,
) -> Result<HashSet<String>, PlayerReadError> {
    let rows = client
        .query(
            "SELECT id FROM rig_rooms WHERE is_active = $1",
            &[&RIG_ROOM_ACTIVE],
        )
        .await?;
    let mut out = HashSet::new();
    for row in rows {
        let id: String = row.get("id");
        let t = id.trim();
        if !t.is_empty() {
            out.insert(t.to_string());
        }
    }
    Ok(out)
}

async fn load_owned_room_ids<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<Vec<String>, PlayerReadError> {
    let rows = client
        .query(
            "SELECT room_id FROM user_rig_rooms WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| r.get::<_, String>("room_id"))
        .collect())
}

async fn load_placed_rack_room_ids<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<Vec<String>, PlayerReadError> {
    let rows = client
        .query(
            "SELECT room_id FROM placed_racks WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let raw: Option<String> = row.try_get("room_id").ok().flatten();
        let id = normalize_placed_rack_room_id(raw.as_deref().unwrap_or(""));
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(id);
    }
    Ok(out)
}

fn trim_room_id(raw: &str) -> String {
    raw.trim().to_string()
}

fn to_trimmed_set(ids: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for raw in ids {
        let id = trim_room_id(raw);
        if !id.is_empty() {
            out.insert(id);
        }
    }
    out
}

/// Node `ensureOwnedRoomIds`.
fn ensure_owned_room_ids(ids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |raw: &str| {
        let id = trim_room_id(raw);
        if id.is_empty() || !seen.insert(id.clone()) {
            return;
        }
        out.push(id);
    };
    for id in ALWAYS_OWNED_ROOM_IDS {
        add(id);
    }
    for raw in ids {
        add(raw);
    }
    out
}

/// Node `computeOwnedRoomDiff`.
fn compute_owned_room_diff(
    current_ids: &[String],
    desired_ids: &[String],
    active_ids: &HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let always: HashSet<&str> = ALWAYS_OWNED_ROOM_IDS.iter().copied().collect();
    let mut current = HashSet::new();
    for raw in current_ids {
        let id = trim_room_id(raw);
        if !id.is_empty() && active_ids.contains(&id) {
            current.insert(id);
        }
    }
    let mut desired = HashSet::new();
    for raw in desired_ids {
        let id = trim_room_id(raw);
        if !id.is_empty() && active_ids.contains(&id) {
            desired.insert(id);
        }
    }

    let mut to_add = Vec::new();
    for id in &desired {
        if !current.contains(id) {
            to_add.push(id.clone());
        }
    }
    let mut to_remove = Vec::new();
    for id in &current {
        if !desired.contains(id) && !always.contains(id.as_str()) {
            to_remove.push(id.clone());
        }
    }
    (to_add, to_remove)
}

/// Node `partitionRacksForRoomRevoke`.
fn partition_racks_for_room_revoke(
    racks: &[PlacedRack],
    revoke_room_ids: &[String],
) -> (Vec<PlacedRack>, Vec<PlacedRack>) {
    let revoke = to_trimmed_set(revoke_room_ids);
    let mut keep = Vec::new();
    let mut removed = Vec::new();
    for rack in racks {
        let room_id = normalize_placed_rack_room_id(&rack.room_id);
        if revoke.contains(&room_id) {
            removed.push(rack.clone());
        } else {
            keep.push(rack.clone());
        }
    }
    (keep, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(
            ADMIN_OWNED_ROOMS_PREPARE_PATH,
            "/v1/admin/users/owned-rooms-prepare"
        );
        assert_eq!(
            ADMIN_OWNED_ROOMS_FINALIZE_PATH,
            "/v1/admin/users/owned-rooms-finalize"
        );
    }

    #[test]
    fn ensure_leads_with_defaults() {
        assert_eq!(
            ensure_owned_room_ids(&[]),
            vec![
                ROOM_INITIAL_ID.to_string(),
                ASIC_ROOM_ID.to_string(),
                EXTRA_ROOM_ID.to_string()
            ]
        );
    }

    #[test]
    fn diff_never_revokes_defaults() {
        let active: HashSet<String> = [
            ROOM_INITIAL_ID,
            ASIC_ROOM_ID,
            EXTRA_ROOM_ID,
            "room_custom",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let current = vec![
            ROOM_INITIAL_ID.to_string(),
            "room_custom".to_string(),
        ];
        let desired = vec![ROOM_INITIAL_ID.to_string()];
        let (to_add, to_remove) = compute_owned_room_diff(&current, &desired, &active);
        assert!(to_add.is_empty());
        assert_eq!(to_remove, vec!["room_custom".to_string()]);
    }

    #[test]
    fn partition_revokes_matching_rooms() {
        let racks = vec![
            PlacedRack {
                id: "a".into(),
                room_id: "room_custom".into(),
                ..Default::default()
            },
            PlacedRack {
                id: "b".into(),
                room_id: ROOM_INITIAL_ID.into(),
                ..Default::default()
            },
        ];
        let (keep, removed) =
            partition_racks_for_room_revoke(&racks, &["room_custom".to_string()]);
        assert_eq!(keep.len(), 1);
        assert_eq!(keep[0].id, "b");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "a");
    }
}
