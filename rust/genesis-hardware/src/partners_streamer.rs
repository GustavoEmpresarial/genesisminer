//! Partner streamer-room deactivation (admin).
//!
//! Ports `deactivateStreamerRoomForUser` from
//! `server/modules/partners/controllers/partners-admin.controller.ts` (Express, deleted).
//! Removes the user's racks placed in the streamer room, re-persists the remaining
//! set through the rack engine (so mounted batteries return to the warehouse),
//! then drops the streamer rig-room grant and streamer access levels.

use deadpool_postgres::GenericClient;

use crate::load::load_user_placed_racks;
use crate::persist::{persist_hardware, PersistInput, StockMode};
use crate::pg_types::pg_user_id;

pub const STREAMER_ROOM_DEACTIVATE_PATH: &str = "/v1/partners/streamer-room/deactivate";

/// `STREAMER_ROOM_ID_CONST` in Node.
pub const STREAMER_ROOM_ID: &str = "room_1766898636697";
/// `STREAMER_LEVEL_IDS` in Node.
const STREAMER_LEVEL_IDS: [&str; 2] = ["creator", "tester"];

pub async fn deactivate_streamer_room<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> anyhow::Result<i64> {
    let current = load_user_placed_racks(client, user_id).await?;
    let before = current.len();
    let next: Vec<_> = current
        .into_iter()
        .filter(|r| r.room_id.trim() != STREAMER_ROOM_ID)
        .collect();
    let removed = before.saturating_sub(next.len()) as i64;

    persist_hardware(
        client,
        PersistInput {
            user_id,
            stock: None,
            stock_mode: StockMode::Partial,
            stored_batteries: None,
            placed_racks: Some(next),
        },
    )
    .await?;

    let uid = pg_user_id(user_id)?;
    let levels: Vec<String> = STREAMER_LEVEL_IDS.iter().map(|s| s.to_string()).collect();

    client
        .execute(
            "DELETE FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2",
            &[&uid, &STREAMER_ROOM_ID],
        )
        .await?;
    client
        .execute(
            "DELETE FROM user_access_levels
              WHERE user_id = $1
                AND LOWER(BTRIM(access_level_id::text)) = ANY($2::text[])",
            &[&uid, &levels],
        )
        .await?;
    client
        .execute(
            "UPDATE users SET access_level_id = 'normal'
              WHERE id = $1
                AND LOWER(BTRIM(access_level_id::text)) = ANY($2::text[])",
            &[&uid, &levels],
        )
        .await?;

    Ok(removed)
}
