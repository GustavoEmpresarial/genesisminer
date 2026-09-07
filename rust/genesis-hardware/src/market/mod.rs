//! Player P2P market — mutations + reads in one worker TX (`/v1/market/*`).
//!
//! In-process [`crate::p2p::p2p_instances_apply`] (no HTTP loopback).
//! Node Express stays JWT / `requireActiveUser` / rate-limit / Kafka / WS.

pub mod buy;
pub mod cancel;
pub mod claim;
pub mod errors;
pub mod http;
pub mod reads;
pub mod reclaim;
pub mod referral;
pub mod reserve;
pub mod sell;

use deadpool_postgres::GenericClient;
use genesis_core::market::MARKET_RESERVE_MS;

use crate::config::HARDWARE_TX_TIMEOUT_MS;
use crate::pg_types::pg_user_id;

use self::errors::{
    MarketError, CODE_FORBIDDEN, CODE_NOT_FOUND, ERR_ACCOUNT_BLOCKED, ERR_USER_NOT_FOUND,
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_OK,
    HTTP_UNPROCESSABLE_ENTITY,
};

/// Node `mutations.ts` `BUY_LOCK_TIMEOUT_MS`.
pub const BUY_LOCK_TIMEOUT_MS: u64 = 45_000;
/// Node `mutations.ts` `TX_BUY_TIMEOUT_MS` — buy `statement_timeout` only.
pub const TX_BUY_TIMEOUT_MS: u64 = 90_000;
/// `max(HARDWARE_TX_TIMEOUT_MS, BUY_LOCK_TIMEOUT_MS)` — no third timeout.
pub const MARKET_TX_TIMEOUT_MS: u64 = if HARDWARE_TX_TIMEOUT_MS > BUY_LOCK_TIMEOUT_MS {
    HARDWARE_TX_TIMEOUT_MS
} else {
    BUY_LOCK_TIMEOUT_MS
};

/// Node `Number.MAX_SAFE_INTEGER` — not `i64::MAX`.
pub const P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS: i64 = 9_007_199_254_740_991;

pub const IDEMPOTENCY_KEY_MIN_LENGTH: usize = 8;
pub const IDEMPOTENCY_KEY_MAX_LEN: usize = 128;
pub const ITEM_ID_MAX_LEN: usize = 200;
pub const MAX_LISTING_PRICE: f64 = 1e12;
pub const MAX_LISTING_QTY: i64 = 9999;
pub const PERCENT_DIVISOR: f64 = 100.0;
pub const BAND_EPSILON: f64 = 1e-9;
pub const PRICE_DECIMALS: usize = 4;
pub const BLOCKED_FLAG: i32 = 1;
pub const ECONOMY_SETTINGS_SINGLETON_ID: i32 = 1;
pub const IS_PLAYER_YES: i32 = 1;
pub const LISTING_STATUS_ACTIVE: &str = "active";
pub const LISTING_STATUS_AWAITING_PICKUP: &str = "awaiting_pickup";
pub const ITEM_INSTANCE_STATUS_LISTED: &str = "listed";
pub const SEARCH_MAX_LENGTH: usize = 120;
pub const CATEGORY_MAX_LENGTH: usize = 120;
pub const TYPE_MAX_LENGTH: usize = 64;
pub const HISTORY_LIMIT: i64 = 80;
pub const HISTORY_LIMIT_MAX: i64 = 200;
pub const RECLAIM_BATCH_SIZE: i64 = 200;
pub const RECLAIM_BATCH_SIZE_MAX: i64 = 500;
pub const RECLAIM_MAX_ROUNDS: i64 = 40;
pub const HISTORY_EMPTY_COUNTERPART: &str = "—";
pub const ACCESS_LEVEL_DEFAULT: &str = "normal";

pub const MARKET_SELL_PATH: &str = "/v1/market/sell";
pub const MARKET_CANCEL_PATH: &str = "/v1/market/cancel";
pub const MARKET_RESERVE_PATH: &str = "/v1/market/reserve";
pub const MARKET_CANCEL_RESERVE_PATH: &str = "/v1/market/cancel-reserve";
pub const MARKET_BUY_PATH: &str = "/v1/market/buy";
pub const MARKET_BUY_CACHED_PATH: &str = "/v1/market/buy-cached";
pub const MARKET_CLAIM_PROCEEDS_PATH: &str = "/v1/market/claim-proceeds";
pub const MARKET_CLAIM_ALL_PATH: &str = "/v1/market/claim-all";
pub const MARKET_CLAIM_ITEM_PATH: &str = "/v1/market/claim-item";
pub const MARKET_RECLAIM_PATH: &str = "/v1/market/reclaim";
pub const MARKET_LISTINGS_PATH: &str = "/v1/market/listings";
pub const MARKET_MY_LISTINGS_PATH: &str = "/v1/market/my-listings";
pub const MARKET_CUSTODY_PATH: &str = "/v1/market/custody";
pub const MARKET_SELLABLE_STOCK_PATH: &str = "/v1/market/sellable-stock";
pub const MARKET_HISTORY_PATH: &str = "/v1/market/history";
pub const MARKET_STATE_PATH: &str = "/v1/market/state";
pub const MARKET_ADMIN_LISTINGS_PATH: &str = "/v1/market/admin/listings";

const ASSERT_ACTIVE_SQL: &str = "SELECT is_blocked FROM users WHERE id = $1 FOR UPDATE";
const LOCK_GAME_STATE_SQL: &str = "SELECT 1 FROM game_states WHERE user_id = $1 FOR UPDATE";
const LOCK_GAME_STATE_STAR_SQL: &str = "SELECT * FROM game_states WHERE user_id = $1 FOR UPDATE";
const BUMP_GAME_STATE_SQL: &str =
    "UPDATE game_states SET server_updated_at = $2, last_updated_at = $2 WHERE user_id = $1";
const SELECT_JOIN_IDS_SQL: &str = "SELECT instance_id FROM player_listing_instances
    WHERE listing_id = $1
    ORDER BY instance_id
    FOR UPDATE";
const INSERT_JOIN_SQL: &str =
    "INSERT INTO player_listing_instances (listing_id, instance_id) VALUES ($1, $2)";
const DELETE_JOIN_SQL: &str = "DELETE FROM player_listing_instances WHERE listing_id = $1";
const DELETE_LISTING_SQL: &str = "DELETE FROM player_listings WHERE id = $1";

pub async fn set_market_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), MarketError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {MARKET_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MarketError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {MARKET_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

/// Buy only: Node `TX_BUY_TIMEOUT_MS` on statements, `BUY_LOCK_TIMEOUT_MS` on locks.
pub async fn set_buy_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), MarketError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MarketError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub async fn finish_tx<T>(
    tx: deadpool_postgres::Transaction<'_>,
    result: Result<T, MarketError>,
) -> Result<T, MarketError> {
    match result {
        Ok(v) => {
            tx.commit().await.map_err(MarketError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

pub async fn assert_active_user<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<(), MarketError> {
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let rows = client
        .query(ASSERT_ACTIVE_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    let Some(row) = rows.first() else {
        return Err(MarketError::not_found(
            ERR_USER_NOT_FOUND,
            Some(CODE_NOT_FOUND),
        ));
    };
    let blocked: Option<i32> = row.get("is_blocked");
    if blocked.unwrap_or(0) == BLOCKED_FLAG {
        return Err(MarketError::forbidden(
            ERR_ACCOUNT_BLOCKED,
            Some(CODE_FORBIDDEN),
        ));
    }
    Ok(())
}

pub async fn lock_game_state<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<(), MarketError> {
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    client
        .query(LOCK_GAME_STATE_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub async fn lock_game_state_star<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<(), MarketError> {
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    client
        .query(LOCK_GAME_STATE_STAR_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub async fn bump_game_state<C: GenericClient>(
    client: &C,
    user_id: i64,
    now_ms: i64,
) -> Result<(), MarketError> {
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    client
        .execute(BUMP_GAME_STATE_SQL, &[&uid, &now_ms])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub async fn select_listing_instance_ids<C: GenericClient>(
    client: &C,
    listing_id: &str,
) -> Result<Vec<String>, MarketError> {
    let rows = client
        .query(SELECT_JOIN_IDS_SQL, &[&listing_id])
        .await
        .map_err(MarketError::transport)?;
    Ok(rows
        .iter()
        .map(|r| {
            let id: uuid::Uuid = r.get("instance_id");
            id.to_string()
        })
        .collect())
}

pub async fn insert_listing_instances<C: GenericClient>(
    client: &C,
    listing_id: &str,
    instance_ids: &[String],
) -> Result<(), MarketError> {
    for raw in instance_ids {
        let id = uuid::Uuid::parse_str(raw.trim()).map_err(MarketError::transport)?;
        client
            .execute(INSERT_JOIN_SQL, &[&listing_id, &id])
            .await
            .map_err(MarketError::transport)?;
    }
    Ok(())
}

pub async fn delete_listing_instances<C: GenericClient>(
    client: &C,
    listing_id: &str,
) -> Result<(), MarketError> {
    client
        .execute(DELETE_JOIN_SQL, &[&listing_id])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub async fn delete_listing<C: GenericClient>(
    client: &C,
    listing_id: &str,
) -> Result<(), MarketError> {
    client
        .execute(DELETE_LISTING_SQL, &[&listing_id])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

pub fn random_listing_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn listing_qty_from_row(qty: Option<i32>) -> i32 {
    let n = qty.unwrap_or(1);
    if n >= 1 {
        n
    } else {
        1
    }
}

pub fn item_id_ok(item_id: &str) -> bool {
    !item_id.is_empty()
        && item_id.len() <= ITEM_ID_MAX_LEN
        && item_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

pub fn validate_sell_input(item_id: &str, price: f64, qty: i64) -> Result<(), MarketError> {
    if !item_id_ok(item_id) {
        return Err(MarketError::bad(errors::ERR_INVALID_ITEM));
    }
    if !price.is_finite() || price <= 0.0 || price > MAX_LISTING_PRICE {
        return Err(MarketError::bad(errors::ERR_INVALID_PRICE));
    }
    if qty < 1 || qty > MAX_LISTING_QTY {
        return Err(MarketError::bad(errors::ERR_INVALID_QTY));
    }
    Ok(())
}

pub fn normalize_idempotency_key(raw: &str) -> String {
    let s = raw.trim();
    if s.len() > IDEMPOTENCY_KEY_MAX_LEN {
        s[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        s.to_string()
    }
}

pub fn format_price_decimals(v: f64) -> String {
    format!("{v:.PRICE_DECIMALS$}")
}

pub fn current_now_ms() -> i64 {
    crate::config::current_unix_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p2p::P2P_INSTANCES_PATH;

    #[test]
    fn paths_match_node() {
        assert_eq!(MARKET_SELL_PATH, "/v1/market/sell");
        assert_eq!(MARKET_CANCEL_PATH, "/v1/market/cancel");
        assert_eq!(MARKET_RESERVE_PATH, "/v1/market/reserve");
        assert_eq!(MARKET_CANCEL_RESERVE_PATH, "/v1/market/cancel-reserve");
        assert_eq!(MARKET_BUY_PATH, "/v1/market/buy");
        assert_eq!(MARKET_BUY_CACHED_PATH, "/v1/market/buy-cached");
        assert_eq!(MARKET_CLAIM_PROCEEDS_PATH, "/v1/market/claim-proceeds");
        assert_eq!(MARKET_CLAIM_ALL_PATH, "/v1/market/claim-all");
        assert_eq!(MARKET_CLAIM_ITEM_PATH, "/v1/market/claim-item");
        assert_eq!(MARKET_RECLAIM_PATH, "/v1/market/reclaim");
        assert_eq!(MARKET_LISTINGS_PATH, "/v1/market/listings");
        assert_eq!(MARKET_MY_LISTINGS_PATH, "/v1/market/my-listings");
        assert_eq!(MARKET_CUSTODY_PATH, "/v1/market/custody");
        assert_eq!(MARKET_SELLABLE_STOCK_PATH, "/v1/market/sellable-stock");
        assert_eq!(MARKET_HISTORY_PATH, "/v1/market/history");
        assert_eq!(MARKET_STATE_PATH, "/v1/market/state");
    }

    #[test]
    fn sentinel_is_max_safe_integer_not_i64_max() {
        assert_eq!(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS, 9_007_199_254_740_991);
        assert_ne!(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS, i64::MAX);
    }

    #[test]
    fn market_timeout_is_named_max() {
        assert_eq!(MARKET_TX_TIMEOUT_MS, BUY_LOCK_TIMEOUT_MS);
        assert!(MARKET_TX_TIMEOUT_MS >= HARDWARE_TX_TIMEOUT_MS);
        assert_eq!(BUY_LOCK_TIMEOUT_MS, 45_000);
        assert_eq!(TX_BUY_TIMEOUT_MS, 90_000);
        assert!(TX_BUY_TIMEOUT_MS > BUY_LOCK_TIMEOUT_MS);
        assert_eq!(MARKET_RESERVE_MS, 3 * 60 * 1000);
    }

    #[test]
    fn http_status_match_node() {
        assert_eq!(HTTP_OK, 200);
        assert_eq!(HTTP_BAD_REQUEST, 400);
        assert_eq!(HTTP_FORBIDDEN, 403);
        assert_eq!(HTTP_NOT_FOUND, 404);
        assert_eq!(HTTP_CONFLICT, 409);
        assert_eq!(HTTP_UNPROCESSABLE_ENTITY, 422);
    }

    #[test]
    fn market_modules_do_not_http_loopback_p2p() {
        let sources = [
            include_str!("sell.rs"),
            include_str!("buy.rs"),
            include_str!("cancel.rs"),
            include_str!("reserve.rs"),
            include_str!("claim.rs"),
            include_str!("reclaim.rs"),
            include_str!("reads.rs"),
            include_str!("http.rs"),
        ]
        .join("\n");
        assert!(!sources.contains("/v1/hardware/p2p-instances"));
        assert!(!sources.contains("http://127.0.0.1"));
        assert!(!sources.contains("GENESIS_HARDWARE_URL"));
        let _ = P2P_INSTANCES_PATH;
    }

    #[test]
    fn item_id_pattern_matches_node() {
        assert!(item_id_ok("ok_id"));
        assert!(item_id_ok("a.b-c_1"));
        assert!(!item_id_ok("bad id!"));
        assert!(!item_id_ok(""));
    }
}
