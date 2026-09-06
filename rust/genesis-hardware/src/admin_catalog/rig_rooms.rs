//! `POST /api/rig-rooms` twin — Node `upsertRigRoomsCatalog`.
//!
//! The panel posts the full catalog; rooms outside it are deleted unless they
//! are still referenced (bought via `user_rig_rooms`, or holding a rig in
//! `placed_racks` — including the legacy rows where `room_initial` shows up as
//! `NULL`/empty/`'main'`).

use deadpool_postgres::Pool;
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;

use crate::player_reads::PlayerReadError;

use super::{js, set_tx_timeout};

/// Node `Math.max(0, Number(x) || 0)` on both capacities.
const MIN_CAPACITY: f64 = 0.0;
/// Node's legacy alias for `room_initial` rows in `placed_racks`.
const LEGACY_MAIN_ROOM_ID: &str = "main";

const DELETE_UNREFERENCED_SQL: &str = "DELETE FROM rig_rooms
     WHERE id NOT IN (SELECT room_id FROM user_rig_rooms)
       AND NOT EXISTS (
         SELECT 1 FROM placed_racks pr
         WHERE pr.room_id = rig_rooms.id
            OR (rig_rooms.id = $1 AND (
                 pr.room_id IS NULL
                 OR BTRIM(COALESCE(pr.room_id, '')) = ''
                 OR pr.room_id = $2
               ))
       )";

const DELETE_MISSING_SQL: &str = "DELETE FROM rig_rooms
     WHERE id NOT IN (SELECT unnest($3::text[]))
       AND id NOT IN (SELECT room_id FROM user_rig_rooms)
       AND NOT EXISTS (
         SELECT 1 FROM placed_racks pr
         WHERE pr.room_id = rig_rooms.id
            OR (rig_rooms.id = $1 AND (
                 pr.room_id IS NULL
                 OR BTRIM(COALESCE(pr.room_id, '')) = ''
                 OR pr.room_id = $2
               ))
       )";

const UPSERT_SQL: &str = "INSERT INTO rig_rooms
       (id, name, initial_capacity, max_capacity, base_slot_price,
        slot_price_increase_percent, allowed_levels, allowed_season_pass_ids,
        is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       initial_capacity = EXCLUDED.initial_capacity,
       max_capacity = EXCLUDED.max_capacity,
       base_slot_price = EXCLUDED.base_slot_price,
       slot_price_increase_percent = EXCLUDED.slot_price_increase_percent,
       allowed_levels = EXCLUDED.allowed_levels,
       allowed_season_pass_ids = EXCLUDED.allowed_season_pass_ids,
       is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order";

#[derive(Debug, Clone, PartialEq)]
pub struct RigRoomRow {
    pub id: Option<String>,
    pub name: String,
    pub initial_capacity: i32,
    pub max_capacity: i32,
    pub base_slot_price: f64,
    pub slot_price_increase_percent: f64,
    pub allowed_levels: String,
    pub allowed_season_pass_ids: String,
    pub is_active: i32,
    pub sort_order: i32,
    /// Node `typeof id === 'string' && id.trim()` — what the prune list keeps.
    pub id_is_prunable: bool,
}

pub fn parse_rig_room_rows(rooms: &[Value]) -> Vec<RigRoomRow> {
    rooms.iter().map(parse_rig_room_row).collect()
}

fn parse_rig_room_row(room: &Value) -> RigRoomRow {
    let obj = room.as_object();
    let field = |key: &str| obj.and_then(|m| m.get(key));
    let raw_id = field("id");
    RigRoomRow {
        id: raw_id.and_then(|v| v.as_str()).map(str::to_string),
        name: js::string_or_nullish(field("name"), ""),
        initial_capacity: to_i32(js::number_or_zero(field("initialCapacity")).max(MIN_CAPACITY)),
        max_capacity: to_i32(js::number_or_zero(field("maxCapacity")).max(MIN_CAPACITY)),
        base_slot_price: js::number_or_zero(field("baseSlotPrice")),
        slot_price_increase_percent: js::number_or_zero(field("slotPriceIncreasePercent")),
        // `allowedPlanIds` is the current name; `allowedLevels` is the legacy one.
        allowed_levels: serialize_id_array(field("allowedPlanIds"), field("allowedLevels")),
        allowed_season_pass_ids: serialize_id_array(field("allowedSeasonPassIds"), None),
        is_active: i32::from(js::truthy(field("isActive"))),
        sort_order: to_i32(js::number_or_zero(field("sortOrder"))),
        id_is_prunable: raw_id
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty()),
    }
}

/// Node `JSON.stringify(Array.isArray(primary) ? primary : Array.isArray(fallback) ? fallback : [])`.
fn serialize_id_array(primary: Option<&Value>, fallback: Option<&Value>) -> String {
    for candidate in [primary, fallback].into_iter().flatten() {
        if let Value::Array(items) = candidate {
            return Value::Array(items.clone()).to_string();
        }
    }
    "[]".to_string()
}

/// The capacity / sort columns are `Int`; Prisma truncates the JS number.
fn to_i32(n: f64) -> i32 {
    if !n.is_finite() {
        return 0;
    }
    let truncated = n.trunc();
    if truncated > f64::from(i32::MAX) {
        i32::MAX
    } else if truncated < f64::from(i32::MIN) {
        i32::MIN
    } else {
        truncated as i32
    }
}

pub async fn run_upsert_rig_rooms(pool: &Pool, rooms: &[Value]) -> Result<Value, PlayerReadError> {
    let rows = parse_rig_room_rows(rooms);
    let new_ids: Vec<String> = rows
        .iter()
        .filter(|r| r.id_is_prunable)
        .filter_map(|r| r.id.clone())
        .collect();

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_tx_timeout(&tx).await?;

    let room_initial = genesis_core::calculator::constants::ROOM_INITIAL_ID;
    if new_ids.is_empty() {
        tx.execute(
            DELETE_UNREFERENCED_SQL,
            &[&room_initial, &LEGACY_MAIN_ROOM_ID],
        )
        .await?;
    } else {
        tx.execute(
            DELETE_MISSING_SQL,
            &[&room_initial, &LEGACY_MAIN_ROOM_ID, &new_ids],
        )
        .await?;
    }

    for row in &rows {
        let params: [&(dyn ToSql + Sync); 10] = [
            &row.id,
            &row.name,
            &row.initial_capacity,
            &row.max_capacity,
            &row.base_slot_price,
            &row.slot_price_increase_percent,
            &row.allowed_levels,
            &row.allowed_season_pass_ids,
            &row.is_active,
            &row.sort_order,
        ];
        tx.execute(UPSERT_SQL, &params).await?;
    }

    tx.commit().await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_node() {
        let rows = parse_rig_room_rows(&[json!({ "id": "room_x" })]);
        let row = &rows[0];
        assert_eq!(row.name, "");
        assert_eq!(row.initial_capacity, 0);
        assert_eq!(row.max_capacity, 0);
        assert_eq!(row.base_slot_price, 0.0);
        assert_eq!(row.slot_price_increase_percent, 0.0);
        assert_eq!(row.allowed_levels, "[]");
        assert_eq!(row.allowed_season_pass_ids, "[]");
        assert_eq!(row.is_active, 0);
        assert_eq!(row.sort_order, 0);
        assert!(row.id_is_prunable);
    }

    #[test]
    fn negative_capacities_floor_at_zero() {
        let rows = parse_rig_room_rows(&[json!({
            "id": "r",
            "initialCapacity": -5,
            "maxCapacity": "12.9",
            "baseSlotPrice": -3.5
        })]);
        assert_eq!(rows[0].initial_capacity, 0);
        assert_eq!(rows[0].max_capacity, 12);
        // Node does not clamp the price, only the capacities.
        assert_eq!(rows[0].base_slot_price, -3.5);
    }

    #[test]
    fn allowed_plan_ids_win_over_legacy_allowed_levels() {
        let rows = parse_rig_room_rows(&[json!({
            "id": "r",
            "allowedPlanIds": ["vip"],
            "allowedLevels": ["free"]
        })]);
        assert_eq!(rows[0].allowed_levels, r#"["vip"]"#);

        let rows = parse_rig_room_rows(&[json!({ "id": "r", "allowedLevels": ["free"] })]);
        assert_eq!(rows[0].allowed_levels, r#"["free"]"#);

        let rows = parse_rig_room_rows(&[json!({ "id": "r", "allowedPlanIds": "vip" })]);
        assert_eq!(rows[0].allowed_levels, "[]");
    }

    #[test]
    fn non_string_ids_are_not_prunable() {
        let rows = parse_rig_room_rows(&[
            json!({ "id": "  " }),
            json!({ "id": 7 }),
            json!({}),
            json!({ "id": "ok" }),
        ]);
        let prunable: Vec<&str> = rows
            .iter()
            .filter(|r| r.id_is_prunable)
            .filter_map(|r| r.id.as_deref())
            .collect();
        assert_eq!(prunable, vec!["ok"]);
    }

    #[test]
    fn is_active_is_js_truthy() {
        for (raw, expected) in [
            (json!(true), 1),
            (json!(1), 1),
            (json!("0"), 1),
            (json!(false), 0),
            (json!(0), 0),
            (json!(null), 0),
        ] {
            let rows = parse_rig_room_rows(&[json!({ "id": "r", "isActive": raw })]);
            assert_eq!(rows[0].is_active, expected, "{raw}");
        }
    }
}
