//! Player-game header — balances + calculator hash mapping.

use deadpool_postgres::Pool;
use genesis_core::mining_last_completed_ten_min_grid;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::calculator::run_calculator_snapshot;
use crate::config::MINED_COIN_AMOUNT_DECIMALS;

use super::{f64_cell, i64_cell, now_ms, pg_user_id, string_cell, PlayerReadError};

/// Node `MS_PER_DAY` seconds in a day for coins/sec estimate.
const SECONDS_PER_DAY: f64 = 86_400.0;

const _: () = assert!(SECONDS_PER_DAY as i64 == 86_400);
const _: () = assert!(MINED_COIN_AMOUNT_DECIMALS == 8);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderHighlightRequest {
    pub user_id: i64,
    #[serde(default)]
    pub coin_id: String,
}

/// Cap for the stored coin id (uuid / `coin_<ts>` — well under this).
const HIGHLIGHT_COIN_ID_MAX: usize = 64;

/// `PATCH /api/player-game/header/highlight` — persist the header's highlighted
/// mined coin to `game_states.header_highlight_coin_id`. Empty string clears it.
/// Client mirror: `client/src/shared/api/player-game.ts` `patchHeaderHighlightCoin`.
pub async fn run_header_highlight(
    pool: &Pool,
    user_id: i64,
    coin_id: &str,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let coin_id: String = coin_id.trim().chars().take(HIGHLIGHT_COIN_ID_MAX).collect();
    let conn = pool.get().await?;
    if !coin_id.is_empty() {
        let known = conn
            .query_opt(
                "SELECT 1 FROM mining_coins WHERE id = $1 AND is_active = 1",
                &[&coin_id],
            )
            .await?
            .is_some();
        if !known {
            return Err(PlayerReadError::bad("unknown or inactive coin"));
        }
    }
    let stored: Option<&str> = if coin_id.is_empty() {
        None
    } else {
        Some(coin_id.as_str())
    };
    conn.execute(
        "UPDATE game_states SET header_highlight_coin_id = $2 WHERE user_id = $1",
        &[&uid, &stored],
    )
    .await?;
    Ok(json!({ "headerHighlightCoinId": coin_id }))
}

pub async fn run_header(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let now = now_ms();
    let conn = pool.get().await?;
    let uid = match pg_user_id(user_id) {
        Ok(v) => v,
        Err(_) => return Ok(empty_header(now)),
    };
    let gs = conn
        .query_opt(
            "SELECT usdc::double precision AS usdc, server_updated_at,
                    COALESCE(header_highlight_coin_id, '') AS header_highlight_coin_id
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(gs) = gs else {
        return Ok(empty_header(now));
    };
    let usdc = f64_cell(&gs, "usdc");
    let header_highlight_coin_id = string_cell(&gs, "header_highlight_coin_id");
    let server_updated_at = {
        let v = i64_cell(&gs, "server_updated_at");
        if v > 0 {
            v
        } else {
            now
        }
    };
    let bals = conn
        .query(
            "SELECT coin_id, amount::double precision AS amount FROM coin_balances WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    // Active mined-coin catalog for the header token strip / highlight picker
    // (Node `dashboard-stats.ts` miningCoins + client `PlayerGameMiningCoin`).
    let coin_rows = conn
        .query(
            "SELECT id, name FROM mining_coins WHERE is_active = 1 ORDER BY name ASC, id ASC",
            &[],
        )
        .await?;
    let mining_coins: Vec<Value> = coin_rows
        .iter()
        .map(|r| {
            let id = string_cell(r, "id");
            let name = string_cell(r, "name");
            let name = if name.is_empty() { id.clone() } else { name };
            json!({ "id": id, "name": name })
        })
        .collect();
    let scale = 10f64.powi(MINED_COIN_AMOUNT_DECIMALS);
    let mut coin_balances = serde_json::Map::new();
    for r in &bals {
        let amt = f64_cell(r, "amount");
        let rounded = if amt.is_finite() {
            (amt * scale).round() / scale
        } else {
            0.0
        };
        coin_balances.insert(string_cell(r, "coin_id"), json!(rounded));
    }
    drop(conn);
    let snap = run_calculator_snapshot(pool, user_id, None).await.ok();
    let mut hash_by = serde_json::Map::new();
    let mut est = serde_json::Map::new();
    let mut total_hash = 0.0;
    let mut rigs_total = 0i64;
    let mut rigs_online = 0i64;
    if let Some(s) = snap {
        total_hash = s.snapshot.general_power_hps;
        for c in &s.snapshot.coins {
            hash_by.insert(c.id.clone(), json!(c.user_power_hps));
            est.insert(c.id.clone(), json!(c.daily_coins / SECONDS_PER_DAY));
        }
        rigs_total = s.snapshot.coins.len() as i64;
        rigs_online = s
            .snapshot
            .coins
            .iter()
            .filter(|c| c.user_power_hps > 0.0)
            .count() as i64;
    }
    Ok(json!({
        "coinBalances": coin_balances,
        "usdc": usdc,
        "hashByCoinId": hash_by,
        "totalHash": total_hash,
        "serverUpdatedAt": server_updated_at,
        "rigsTotal": rigs_total,
        "rigsOnline": rigs_online,
        "estCoinsPerSecByCoinId": est,
        "liveAccrualAnchorMs": mining_last_completed_ten_min_grid(now),
        "miningCoins": mining_coins,
        "headerHighlightCoinId": header_highlight_coin_id,
    }))
}

fn empty_header(now: i64) -> Value {
    json!({
        "coinBalances": {},
        "usdc": 0,
        "hashByCoinId": {},
        "totalHash": 0,
        "serverUpdatedAt": now,
        "rigsTotal": 0,
        "rigsOnline": 0,
        "estCoinsPerSecByCoinId": {},
        "liveAccrualAnchorMs": mining_last_completed_ten_min_grid(now),
        "miningCoins": [],
        "headerHighlightCoinId": "",
    })
}
