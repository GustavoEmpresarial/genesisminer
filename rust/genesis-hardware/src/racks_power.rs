//! Rack power + selected coin — port of Node `save-servers` / `room-coins`.
//!
//! Node holds `game_states` FOR UPDATE around the HTTP call (intent pattern).
//! This worker mutates `placed_racks` + eligibility events only — locking
//! `game_states` here would deadlock with the Node TX.

use std::collections::HashMap;

use deadpool_postgres::GenericClient;
use genesis_core::calculator::constants::{NFT_AUTO_ROOM_ID, ROOM_INITIAL_ID};
use genesis_core::calculator::nft::is_nft_room_exclusive_mining_coin_ref;
use genesis_core::calculator::room_id::normalize_placed_rack_room_id;
use genesis_core::calculator::types::MiningCoinInput;
use genesis_core::hardware::capacity::{
    ASIC_ROOM_COIN_LOCKED_ERROR, ERR_COIN_DISABLED, ERR_INVALID_COIN, ERR_UNKNOWN_COIN,
    NFT_ROOM_COIN_LOCKED_ERROR, NFT_ROOM_EXCLUSIVE_COIN_ERROR,
};
use genesis_core::hardware::item_id::{is_valid_coin_id, is_valid_rack_id};
use genesis_core::hardware::room::{
    is_asic_mining_room_id, is_nft_mining_room_id, rack_power_is_on,
};
use serde::Deserialize;
use tokio_postgres::Row;

use crate::config::{current_unix_ms, HARDWARE_TX_TIMEOUT_MS};
use crate::eligibility::{
    record_mining_eligibility_event, EligibilityEvent, EVENT_RACK_COIN_CHANGED,
    EVENT_RACK_POWER_CHANGED, IDENTITY_RACK,
};
use crate::load::{resolve_asic_room_ids, resolve_nft_room_ids};
use crate::pg_types::pg_user_id;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RackPowerItem {
    pub id: Option<serde_json::Value>,
    pub is_on: Option<serde_json::Value>,
    pub selected_coin_id: Option<serde_json::Value>,
    pub room_id: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RacksPowerRequest {
    pub user_id: i64,
    pub racks: Option<Vec<RackPowerItem>>,
    pub room_id: Option<String>,
    pub coin_id: Option<serde_json::Value>,
}

#[derive(Debug)]
pub enum RacksPowerError {
    Domain(String),
    Transport(anyhow::Error),
}

impl From<anyhow::Error> for RacksPowerError {
    fn from(e: anyhow::Error) -> Self {
        Self::Transport(e)
    }
}

impl From<tokio_postgres::Error> for RacksPowerError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}

struct OwnedRack {
    room_id: Option<String>,
    is_on: i32,
    selected_coin_id: Option<String>,
}

struct CoinMeta {
    symbol: String,
    is_active: i32,
    nft_room_only: i32,
}

fn json_string(v: Option<&serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

fn want_on(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Bool(true)) => true,
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(1) || n.as_u64() == Some(1),
        Some(serde_json::Value::String(s)) => s == "1",
        _ => false,
    }
}

fn row_is_on(row: &Row) -> i32 {
    if let Ok(v) = row.try_get::<_, i32>("is_on") {
        return if v == 1 { 1 } else { 0 };
    }
    if let Ok(v) = row.try_get::<_, bool>("is_on") {
        return if v { 1 } else { 0 };
    }
    0
}

fn row_flag_i32(row: &Row, col: &str) -> i32 {
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i32>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i16>(col) {
        return i32::from(v);
    }
    if let Ok(v) = row.try_get::<_, bool>(col) {
        return if v { 1 } else { 0 };
    }
    0
}

fn exclusive_coin_ref(id: &str, symbol: &str, nft_room_only: bool) -> bool {
    is_nft_room_exclusive_mining_coin_ref(&MiningCoinInput {
        id: id.to_string(),
        symbol: symbol.to_string(),
        name: String::new(),
        network_hashrate: 0.0,
        block_reward: 0.0,
        block_time: 0.0,
        price_usd: 0.0,
        usdc_rate: 0.0,
        nft_room_only,
    })
}

async fn set_hardware_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), RacksPowerError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    Ok(())
}

async fn load_coin<C: GenericClient>(
    client: &C,
    coin_id: &str,
    cache: &mut HashMap<String, CoinMeta>,
) -> Result<CoinMeta, RacksPowerError> {
    if let Some(c) = cache.get(coin_id) {
        return Ok(CoinMeta {
            symbol: c.symbol.clone(),
            is_active: c.is_active,
            nft_room_only: c.nft_room_only,
        });
    }
    let rows = client
        .query(
            "SELECT id, symbol, is_active, nft_room_only FROM mining_coins WHERE id = $1",
            &[&coin_id],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Err(RacksPowerError::Domain(ERR_UNKNOWN_COIN.to_string()));
    };
    let meta = CoinMeta {
        symbol: row.try_get::<_, String>("symbol").unwrap_or_default(),
        is_active: row_flag_i32(row, "is_active"),
        nft_room_only: row_flag_i32(row, "nft_room_only"),
    };
    cache.insert(
        coin_id.to_string(),
        CoinMeta {
            symbol: meta.symbol.clone(),
            is_active: meta.is_active,
            nft_room_only: meta.nft_room_only,
        },
    );
    Ok(meta)
}

fn validate_selected_coin(
    coin_id: &str,
    meta: &CoinMeta,
    is_nft_room: bool,
) -> Result<(), RacksPowerError> {
    if meta.is_active == 0 {
        return Err(RacksPowerError::Domain(ERR_COIN_DISABLED.to_string()));
    }
    if exclusive_coin_ref(coin_id, &meta.symbol, meta.nft_room_only != 0) && !is_nft_room {
        return Err(RacksPowerError::Domain(
            NFT_ROOM_EXCLUSIVE_COIN_ERROR.to_string(),
        ));
    }
    Ok(())
}

async fn apply_racks_list<C: GenericClient>(
    client: &C,
    uid: i64,
    racks: &[RackPowerItem],
) -> Result<(), RacksPowerError> {
    let uid_pg = pg_user_id(uid).map_err(RacksPowerError::Transport)?;
    let owned_rows = client
        .query(
            "SELECT id, room_id, is_on, selected_coin_id FROM placed_racks WHERE user_id = $1",
            &[&uid_pg],
        )
        .await?;
    let mut owned: HashMap<String, OwnedRack> = HashMap::new();
    for row in &owned_rows {
        let id: String = row.get("id");
        owned.insert(
            id,
            OwnedRack {
                room_id: row.try_get("room_id").ok().flatten(),
                is_on: row_is_on(row),
                selected_coin_id: row.try_get("selected_coin_id").ok().flatten(),
            },
        );
    }
    let nft_ids = resolve_nft_room_ids(client)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_nft_room_ids());
    let asic_ids = resolve_asic_room_ids(client)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_asic_room_ids());
    let mut coin_cache: HashMap<String, CoinMeta> = HashMap::new();
    let at_ms = current_unix_ms();

    for r in racks {
        let id = json_string(r.id.as_ref()).unwrap_or_default();
        if id.is_empty() || !is_valid_rack_id(&id) {
            continue;
        }
        let Some(row) = owned.get(&id) else {
            continue;
        };
        let room_fallback = json_string(r.room_id.as_ref()).unwrap_or_default();
        let room_raw = row
            .room_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(room_fallback.as_str());
        let room_norm = normalize_placed_rack_room_id(room_raw);
        let is_nft_room = is_nft_mining_room_id(&room_norm, &nft_ids);
        let is_asic_room = is_asic_mining_room_id(&room_norm, Some(&asic_ids));
        let coin_comes_from_machine = is_nft_room || is_asic_room;

        let mut selected_coin_id: Option<String> = None;
        if !coin_comes_from_machine {
            if let Some(raw) = json_string(r.selected_coin_id.as_ref()) {
                if !is_valid_coin_id(&raw) {
                    return Err(RacksPowerError::Domain(ERR_INVALID_COIN.to_string()));
                }
                let meta = load_coin(client, &raw, &mut coin_cache).await?;
                validate_selected_coin(&raw, &meta, is_nft_room)?;
                selected_coin_id = Some(raw);
            }
        }

        let want = want_on(r.is_on.as_ref());
        let is_on = if rack_power_is_on(want, coin_comes_from_machine, selected_coin_id.is_some()) {
            1
        } else {
            0
        };
        let prev_on = if row.is_on == 1 { 1 } else { 0 };
        let prev_coin = row
            .selected_coin_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        client
            .execute(
                "UPDATE placed_racks SET selected_coin_id = $1::text, is_on = $2 WHERE id = $3 AND user_id = $4",
                &[&selected_coin_id, &is_on, &id, &uid_pg],
            )
            .await?;

        if prev_on != is_on {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id: uid,
                    event_type: EVENT_RACK_POWER_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(&id),
                    slot_index: None,
                    catalog_item_id: None,
                    coin_id: None,
                    payload: Some(serde_json::json!({
                        "is_on": is_on == 1,
                        "previous": prev_on == 1
                    })),
                },
            )
            .await
            .map_err(RacksPowerError::Transport)?;
        }
        if !coin_comes_from_machine && prev_coin.as_deref() != selected_coin_id.as_deref() {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id: uid,
                    event_type: EVENT_RACK_COIN_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(&id),
                    slot_index: None,
                    catalog_item_id: None,
                    coin_id: selected_coin_id.as_deref(),
                    payload: Some(serde_json::json!({
                        "previous": prev_coin,
                        "next": selected_coin_id
                    })),
                },
            )
            .await
            .map_err(RacksPowerError::Transport)?;
        }
    }
    Ok(())
}

async fn apply_room_coins<C: GenericClient>(
    client: &C,
    uid: i64,
    room_id: &str,
    coin_id: Option<&serde_json::Value>,
) -> Result<(), RacksPowerError> {
    let uid_pg = pg_user_id(uid).map_err(RacksPowerError::Transport)?;
    let room_norm = normalize_placed_rack_room_id(room_id);
    if room_norm == NFT_AUTO_ROOM_ID {
        return Err(RacksPowerError::Domain(
            NFT_ROOM_COIN_LOCKED_ERROR.to_string(),
        ));
    }
    let asic_ids = resolve_asic_room_ids(client)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_asic_room_ids());
    if is_asic_mining_room_id(&room_norm, Some(&asic_ids)) {
        return Err(RacksPowerError::Domain(
            ASIC_ROOM_COIN_LOCKED_ERROR.to_string(),
        ));
    }

    let mut selected_coin_id: Option<String> = None;
    if let Some(raw) = json_string(coin_id) {
        if !is_valid_coin_id(&raw) {
            return Err(RacksPowerError::Domain(ERR_INVALID_COIN.to_string()));
        }
        let mut cache = HashMap::new();
        let meta = load_coin(client, &raw, &mut cache).await?;
        if meta.is_active == 0 {
            return Err(RacksPowerError::Domain(ERR_COIN_DISABLED.to_string()));
        }
        if exclusive_coin_ref(&raw, &meta.symbol, meta.nft_room_only != 0) {
            return Err(RacksPowerError::Domain(
                NFT_ROOM_EXCLUSIVE_COIN_ERROR.to_string(),
            ));
        }
        selected_coin_id = Some(raw);
    }

    let room_sql = format!("COALESCE(NULLIF(BTRIM(room_id::text), ''), '{ROOM_INITIAL_ID}')");
    let before = client
        .query(
            &format!(
                "SELECT id, selected_coin_id, is_on FROM placed_racks WHERE user_id = $1 AND {room_sql} = $2::text"
            ),
            &[&uid_pg, &room_norm],
        )
        .await?;
    let at_ms = current_unix_ms();

    client
        .execute(
            &format!(
                "UPDATE placed_racks SET
                  selected_coin_id = $1::text,
                  is_on = CASE WHEN $1::text IS NULL THEN 0 ELSE is_on END
                WHERE user_id = $2 AND {room_sql} = $3::text"
            ),
            &[&selected_coin_id, &uid_pg, &room_norm],
        )
        .await?;

    for row in &before {
        let rack_id: String = row.get("id");
        let prev_coin = row
            .try_get::<_, Option<String>>("selected_coin_id")
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let prev_on = row_is_on(row);
        let next_on = if selected_coin_id.is_none() {
            0
        } else {
            prev_on
        };

        if prev_coin.as_deref() != selected_coin_id.as_deref() {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id: uid,
                    event_type: EVENT_RACK_COIN_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(&rack_id),
                    slot_index: None,
                    catalog_item_id: None,
                    coin_id: selected_coin_id.as_deref(),
                    payload: Some(serde_json::json!({
                        "previous": prev_coin,
                        "next": selected_coin_id
                    })),
                },
            )
            .await
            .map_err(RacksPowerError::Transport)?;
        }
        if prev_on != next_on {
            record_mining_eligibility_event(
                client,
                EligibilityEvent {
                    user_id: uid,
                    event_type: EVENT_RACK_POWER_CHANGED,
                    at_ms,
                    identity_kind: IDENTITY_RACK,
                    lease_id: None,
                    rack_id: Some(&rack_id),
                    slot_index: None,
                    catalog_item_id: None,
                    coin_id: None,
                    payload: Some(serde_json::json!({
                        "is_on": next_on == 1,
                        "previous": prev_on == 1,
                        "reason": "room_coins"
                    })),
                },
            )
            .await
            .map_err(RacksPowerError::Transport)?;
        }
    }
    Ok(())
}

pub async fn apply_racks_power<C: GenericClient>(
    client: &C,
    body: &RacksPowerRequest,
) -> Result<(), RacksPowerError> {
    set_hardware_tx_timeouts(client).await?;
    if let Some(racks) = &body.racks {
        return apply_racks_list(client, body.user_id, racks).await;
    }
    if let Some(room_id) = &body.room_id {
        return apply_room_coins(client, body.user_id, room_id, body.coin_id.as_ref()).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_strings_match_node() {
        assert_eq!(ERR_INVALID_COIN, "Invalid coin.");
        assert_eq!(ERR_UNKNOWN_COIN, "Unknown coin.");
        assert_eq!(ERR_COIN_DISABLED, "This coin is disabled.");
        assert_eq!(
            NFT_ROOM_COIN_LOCKED_ERROR,
            "In the NFT Room each ASIC uses the coin set in the admin panel (per model). Bulk coin change is not allowed here."
        );
        assert_eq!(
            ASIC_ROOM_COIN_LOCKED_ERROR,
            "In the ASIC Room each machine uses the coin set in the admin panel (per model). Bulk coin change is not allowed here."
        );
        assert_eq!(EVENT_RACK_POWER_CHANGED, "RACK_POWER_CHANGED");
        assert_eq!(EVENT_RACK_COIN_CHANGED, "RACK_COIN_CHANGED");
    }

    #[test]
    fn want_on_matches_node() {
        assert!(want_on(Some(&serde_json::json!(true))));
        assert!(want_on(Some(&serde_json::json!(1))));
        assert!(want_on(Some(&serde_json::json!("1"))));
        assert!(!want_on(Some(&serde_json::json!(false))));
        assert!(!want_on(Some(&serde_json::json!(0))));
        assert!(!want_on(None));
    }

    #[test]
    fn json_string_trims() {
        assert_eq!(
            json_string(Some(&serde_json::json!(" btc "))).as_deref(),
            Some("btc")
        );
        assert_eq!(json_string(Some(&serde_json::json!(""))), None);
        assert_eq!(json_string(Some(&serde_json::json!(1))), None);
    }
}
