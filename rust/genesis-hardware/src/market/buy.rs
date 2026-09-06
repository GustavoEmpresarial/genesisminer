//! P2P buy — listing + USDC + tax + referral + history + idempotency in one TX.
//! Does **not** transfer instances (claim does). No `consume` / mint.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use genesis_core::market::{
    clamp_tax_percent, compute_p2p_band_reference_usd, is_reservation_active,
};
use serde_json::json;

use crate::pg_types::pg_user_id;

use super::errors::{
    MarketError, CODE_IDEMPOTENCY_CONFLICT, CODE_IDEMPOTENCY_KEY_REQUIRED,
    ERR_IDEMPOTENCY_CONFLICT, ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_INSUFFICIENT_USDC,
    ERR_INVALID_LISTING_PRICE, ERR_INVALID_QTY, ERR_LISTING_ALREADY_SOLD, ERR_LISTING_EXPIRED,
    ERR_LISTING_INSTANCES_UNAVAILABLE, ERR_LISTING_INSTANCE_COUNT, ERR_LISTING_NOT_AVAILABLE,
    ERR_LISTING_NOT_FOUND, ERR_LISTING_NO_ITEM, ERR_LISTING_QTY_MISMATCH,
    ERR_PRICE_OUTSIDE_SHOP_BOUNDS, ERR_QTY_REQUIRED_MULTI, ERR_RESERVED_BY_OTHER, ERR_SELF_TRADE,
    HTTP_OK,
};
use super::referral::run_referral_commission_on_tx;
use super::sell::price_band_percent;
use super::{
    assert_active_user, current_now_ms, finish_tx, lock_game_state_star, normalize_idempotency_key,
    random_listing_id, select_listing_instance_ids, set_buy_tx_timeouts, BAND_EPSILON,
    ECONOMY_SETTINGS_SINGLETON_ID, IDEMPOTENCY_KEY_MIN_LENGTH, IS_PLAYER_YES,
    ITEM_INSTANCE_STATUS_LISTED, LISTING_STATUS_ACTIVE, LISTING_STATUS_AWAITING_PICKUP,
    PERCENT_DIVISOR,
};

const SELECT_LISTING_FOR_BUY_SQL: &str =
    "SELECT l.*, (COALESCE(NULLIF(l.qty, 0), 1))::int AS qty_effective FROM player_listings l WHERE l.id = $1 FOR UPDATE";
const SELECT_REFERRER_PROBE_SQL: &str = "SELECT r.user_id AS referrer_id
      FROM referrals r
      WHERE r.referred_username = (SELECT username FROM users WHERE id = $1 LIMIT 1)
      LIMIT 1";
const SELECT_BUYER_USDC_SQL: &str = "SELECT usdc FROM game_states WHERE user_id = $1";
const SELECT_BASE_COST_SQL: &str =
    "SELECT base_cost::double precision AS base_cost FROM upgrades WHERE id = $1 AND COALESCE(is_active, 1) = 1";
const LOCK_INSTANCES_SQL: &str =
    "SELECT id, status FROM item_instances WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE";
const SELECT_TAX_SQL: &str = "SELECT market_tax_percent FROM economy_settings WHERE id = $1";
const PAY_BUYER_SQL: &str =
    "UPDATE game_states SET usdc = usdc - $2, last_updated_at = $3, server_updated_at = $3
      WHERE user_id = $1 AND usdc >= $2 RETURNING usdc";
const CREDIT_SELLER_SQL: &str = "UPDATE game_states SET black_market_balance = COALESCE(black_market_balance, 0) + $2, last_updated_at = $3, server_updated_at = $3
      WHERE user_id = $1";
const FULL_SALE_SQL: &str = "UPDATE player_listings
        SET status = $2, reserved_by = $3, reserved_until = NULL, buyer_paid_usdc = $4
        WHERE id = $1 AND status = 'active' AND (COALESCE(NULLIF(qty, 0), 1))::int = $5
        RETURNING id";
const SHRINK_SQL: &str = "UPDATE player_listings
        SET qty = (COALESCE(NULLIF(qty, 0), 1) - $2)::int, reserved_by = NULL, reserved_until = NULL
        WHERE id = $1 AND status = 'active' AND (COALESCE(NULLIF(qty, 0), 1))::int >= $2
        RETURNING id";
const INSERT_CUSTODY_SQL: &str = "INSERT INTO player_listings (id, user_id, item_id, price, expires_at, is_player, qty, status, reserved_by, reserved_until, buyer_paid_usdc)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10)";
const MOVE_JOIN_SQL: &str =
    "UPDATE player_listing_instances SET listing_id = $1 WHERE instance_id = ANY($2::uuid[])";
const INSERT_HISTORY_SQL: &str = "INSERT INTO p2p_market_trade_history (created_at, buyer_id, seller_id, item_id, qty, unit_price, buyer_paid_usdc, seller_received_usdc, tax_usdc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)";
const INSERT_IDEM_SQL: &str = "INSERT INTO p2p_market_buy_idempotency (buyer_id, idempotency_key, http_status, body_json, created_at)
      VALUES ($1, $2, $3, $4, $5)";
const SELECT_IDEM_SQL: &str = "SELECT http_status, body_json FROM p2p_market_buy_idempotency
      WHERE buyer_id = $1 AND idempotency_key = $2";

const BUY_CACHE_MESSAGE: &str = "Purchase completed. Collect the item from the vault (P2P).";

pub struct BuyOutcome {
    pub buy_qty: i32,
    pub total_price: f64,
    pub unit_price: f64,
    pub seller_id: i32,
    pub item_id: String,
    pub listing_id: String,
    pub message: String,
    pub purchased_qty: i32,
    pub total_usdc: f64,
    pub cached: bool,
}

pub struct CachedBuy {
    pub status: i32,
    pub body: serde_json::Value,
}

fn parse_requested_buy_qty(raw: Option<&serde_json::Value>) -> Option<i32> {
    let Some(v) = raw else {
        return None;
    };
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            if let Ok(n) = t.parse::<f64>() {
                if n.is_finite() {
                    let f = n.floor() as i32;
                    return if f >= 1 { Some(f) } else { None };
                }
            }
            t.parse::<i32>().ok().filter(|p| *p >= 1)
        }
        serde_json::Value::Number(n) => n.as_f64().and_then(|x| {
            if !x.is_finite() {
                return None;
            }
            let f = x.floor() as i32;
            if f >= 1 {
                Some(f)
            } else {
                None
            }
        }),
        _ => None,
    }
}

fn validate_idem_key(raw: &str) -> Result<String, MarketError> {
    let key = normalize_idempotency_key(raw);
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(MarketError::domain_code(
            super::errors::HTTP_BAD_REQUEST,
            ERR_IDEMPOTENCY_KEY_REQUIRED,
            CODE_IDEMPOTENCY_KEY_REQUIRED,
        ));
    }
    Ok(key)
}

async fn lookup_idem<C: GenericClient>(
    client: &C,
    buyer_id: i32,
    key: &str,
) -> Result<Option<CachedBuy>, MarketError> {
    let rows = client
        .query(SELECT_IDEM_SQL, &[&buyer_id, &key])
        .await
        .map_err(MarketError::transport)?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let status: i32 = row.get("http_status");
    if status < i32::from(HTTP_OK) {
        return Ok(None);
    }
    let body_json: String = row.get("body_json");
    let body = serde_json::from_str(&body_json).unwrap_or_else(|_| json!({ "ok": true }));
    Ok(Some(CachedBuy { status, body }))
}

pub async fn buy_cached(
    pool: &Pool,
    buyer_id: i64,
    idempotency_key: &str,
) -> Result<Option<CachedBuy>, MarketError> {
    let key = normalize_idempotency_key(idempotency_key);
    if key.is_empty() {
        return Ok(None);
    }
    let uid = pg_user_id(buyer_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    lookup_idem(&conn, uid, &key).await
}

pub async fn buy(
    pool: &Pool,
    buyer_id: i64,
    listing_id: &str,
    qty_raw: Option<serde_json::Value>,
    idempotency_key: &str,
) -> Result<BuyOutcome, MarketError> {
    let key = validate_idem_key(idempotency_key)?;
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_buy_tx_timeouts(&tx).await?;
    let result = buy_on_tx(&tx, buyer_id, listing_id, qty_raw.as_ref(), &key).await;
    finish_tx(tx, result).await
}

async fn buy_on_tx<C: GenericClient>(
    client: &C,
    buyer_id: i64,
    listing_id: &str,
    qty_raw: Option<&serde_json::Value>,
    idem_key: &str,
) -> Result<BuyOutcome, MarketError> {
    let buyer_pg = pg_user_id(buyer_id).map_err(MarketError::transport)?;
    if lookup_idem(client, buyer_pg, idem_key).await?.is_some() {
        return Err(MarketError::conflict_code(
            ERR_IDEMPOTENCY_CONFLICT,
            CODE_IDEMPOTENCY_CONFLICT,
        ));
    }
    let l_rows = client
        .query(SELECT_LISTING_FOR_BUY_SQL, &[&listing_id])
        .await
        .map_err(MarketError::transport)?;
    let Some(listing) = l_rows.first() else {
        return Err(MarketError::bad(ERR_LISTING_NOT_FOUND));
    };
    assert_active_user(client, buyer_id).await?;
    let now = current_now_ms();
    let status: Option<String> = listing.get("status");
    if status.as_deref() != Some(LISTING_STATUS_ACTIVE) {
        return Err(MarketError::bad(ERR_LISTING_NOT_AVAILABLE));
    }
    let expires_at: i64 = listing.get("expires_at");
    if expires_at < now {
        return Err(MarketError::bad(ERR_LISTING_EXPIRED));
    }
    let seller_id: i32 = listing.get("user_id");
    if i64::from(seller_id) == buyer_id {
        return Err(MarketError::bad(ERR_SELF_TRADE));
    }
    let reserved_by: Option<i32> = listing.get("reserved_by");
    let reserved_until: Option<i64> = listing.get("reserved_until");
    if reserved_by.is_some()
        && is_reservation_active(reserved_until, now)
        && reserved_by != Some(buyer_pg)
    {
        return Err(MarketError::bad(ERR_RESERVED_BY_OTHER));
    }
    let mut referrer_user_id: Option<i32> = None;
    let ref_probe = client
        .query(SELECT_REFERRER_PROBE_SQL, &[&buyer_pg])
        .await
        .map_err(MarketError::transport)?;
    if let Some(row) = ref_probe.first() {
        let ref_n: Option<i32> = row.get("referrer_id");
        if let Some(n) = ref_n {
            if n > 0 && i64::from(n) != buyer_id {
                referrer_user_id = Some(n);
            }
        }
    }
    let mut lock_ids: Vec<i32> = vec![buyer_pg, seller_id];
    if let Some(r) = referrer_user_id {
        lock_ids.push(r);
    }
    lock_ids.sort_unstable();
    lock_ids.dedup();
    for uid in lock_ids {
        lock_game_state_star(client, i64::from(uid)).await?;
    }
    let buyer_usdc_rows = client
        .query(SELECT_BUYER_USDC_SQL, &[&buyer_pg])
        .await
        .map_err(MarketError::transport)?;
    let buyer_usdc: f64 = buyer_usdc_rows
        .first()
        .map(|r| r.get::<_, f64>("usdc"))
        .unwrap_or(0.0);
    let unit_price: f64 = listing.get("price");
    let qty_effective: i32 = listing.get("qty_effective");
    let line_qty = if qty_effective >= 1 { qty_effective } else { 1 };
    let parsed_req = parse_requested_buy_qty(qty_raw);
    let buy_qty = if line_qty > 1 {
        let Some(parsed) = parsed_req else {
            return Err(MarketError::bad(ERR_QTY_REQUIRED_MULTI));
        };
        line_qty.min(parsed)
    } else {
        match parsed_req {
            Some(p) => 1.min(p),
            None => 1,
        }
    };
    if buy_qty < 1 {
        return Err(MarketError::bad(ERR_INVALID_QTY));
    }
    let total_price = unit_price * f64::from(buy_qty);
    if !unit_price.is_finite()
        || unit_price <= 0.0
        || !total_price.is_finite()
        || total_price <= 0.0
    {
        return Err(MarketError::bad(ERR_INVALID_LISTING_PRICE));
    }
    let item_id_raw: String = listing.get("item_id");
    let item_id_for_band = item_id_raw.trim().to_string();
    if !item_id_for_band.is_empty() {
        let up_rows = client
            .query(SELECT_BASE_COST_SQL, &[&item_id_for_band])
            .await
            .map_err(MarketError::transport)?;
        let bc = up_rows
            .first()
            .and_then(|r| r.get::<_, Option<f64>>("base_cost"))
            .unwrap_or(f64::NAN);
        let ref_buy = compute_p2p_band_reference_usd(bc, None);
        if ref_buy > 0.0 {
            let band_buy = price_band_percent(client).await?;
            let lo_b = ref_buy * (1.0 - band_buy / PERCENT_DIVISOR);
            let hi_b = ref_buy * (1.0 + band_buy / PERCENT_DIVISOR);
            if unit_price < lo_b - BAND_EPSILON || unit_price > hi_b + BAND_EPSILON {
                return Err(MarketError::bad(ERR_PRICE_OUTSIDE_SHOP_BOUNDS));
            }
        }
    }
    if buyer_usdc < total_price {
        return Err(MarketError::unprocessable(
            ERR_INSUFFICIENT_USDC,
            Some(total_price - buyer_usdc),
        ));
    }
    let item_id = item_id_raw.trim().to_string();
    if item_id.is_empty() {
        return Err(MarketError::bad(ERR_LISTING_NO_ITEM));
    }
    let locked_join_ids = lock_listed_instances_for_buy(client, listing_id, line_qty).await?;
    let tax_rows = client
        .query(SELECT_TAX_SQL, &[&ECONOMY_SETTINGS_SINGLETON_ID])
        .await
        .map_err(MarketError::transport)?;
    let tax_raw: f64 = tax_rows
        .first()
        .and_then(|r| r.get::<_, Option<f64>>("market_tax_percent"))
        .unwrap_or(0.0);
    let tax_percent = clamp_tax_percent(tax_raw);
    let tax_amount = (total_price * tax_percent) / PERCENT_DIVISOR;
    let seller_receive = total_price - tax_amount;
    let pay_rows = client
        .query(PAY_BUYER_SQL, &[&buyer_pg, &total_price, &now])
        .await
        .map_err(MarketError::transport)?;
    if pay_rows.is_empty() {
        return Err(MarketError::unprocessable(
            ERR_INSUFFICIENT_USDC,
            Some((total_price - buyer_usdc).max(0.0)),
        ));
    }
    client
        .execute(CREDIT_SELLER_SQL, &[&seller_id, &seller_receive, &now])
        .await
        .map_err(MarketError::transport)?;
    let is_player: i32 = listing
        .get::<_, Option<i32>>("is_player")
        .map(|v| if v != 0 { 1 } else { 0 })
        .unwrap_or(IS_PLAYER_YES);
    if buy_qty >= line_qty {
        let st = client
            .query(
                FULL_SALE_SQL,
                &[
                    &listing_id,
                    &LISTING_STATUS_AWAITING_PICKUP,
                    &buyer_pg,
                    &total_price,
                    &line_qty,
                ],
            )
            .await
            .map_err(MarketError::transport)?;
        if st.is_empty() {
            return Err(MarketError::bad(ERR_LISTING_QTY_MISMATCH));
        }
    } else {
        let shrink = client
            .query(SHRINK_SQL, &[&listing_id, &buy_qty])
            .await
            .map_err(MarketError::transport)?;
        if shrink.is_empty() {
            return Err(MarketError::bad(ERR_LISTING_ALREADY_SOLD));
        }
        let custody_id = random_listing_id();
        let buy_qty_i32 = buy_qty;
        client
            .execute(
                INSERT_CUSTODY_SQL,
                &[
                    &custody_id,
                    &seller_id,
                    &item_id,
                    &unit_price,
                    &expires_at,
                    &is_player,
                    &buy_qty_i32,
                    &LISTING_STATUS_AWAITING_PICKUP,
                    &buyer_pg,
                    &total_price,
                ],
            )
            .await
            .map_err(MarketError::transport)?;
        let move_n = usize::try_from(buy_qty).unwrap_or(0);
        let move_ids: Vec<uuid::Uuid> = locked_join_ids
            .iter()
            .take(move_n)
            .filter_map(|s| uuid::Uuid::parse_str(s).ok())
            .collect();
        if move_ids.len() != move_n {
            return Err(MarketError::conflict(ERR_LISTING_INSTANCE_COUNT));
        }
        client
            .execute(MOVE_JOIN_SQL, &[&custody_id, &move_ids])
            .await
            .map_err(MarketError::transport)?;
    }
    run_referral_commission_on_tx(client, buyer_id, total_price).await?;
    client
        .execute(
            INSERT_HISTORY_SQL,
            &[
                &now,
                &buyer_pg,
                &seller_id,
                &item_id,
                &buy_qty,
                &unit_price,
                &total_price,
                &seller_receive,
                &tax_amount,
            ],
        )
        .await
        .map_err(MarketError::transport)?;
    let response_body = json!({
        "ok": true,
        "message": BUY_CACHE_MESSAGE,
        "purchasedQty": buy_qty,
        "totalUsdc": total_price,
        "unitPrice": unit_price
    });
    let body_json = serde_json::to_string(&response_body).map_err(MarketError::transport)?;
    let http_ok = i32::from(HTTP_OK);
    if let Err(e) = client
        .execute(
            INSERT_IDEM_SQL,
            &[&buyer_pg, &idem_key, &http_ok, &body_json, &now],
        )
        .await
    {
        return Err(MarketError::from_unique(e));
    }
    Ok(BuyOutcome {
        buy_qty,
        total_price,
        unit_price,
        seller_id,
        item_id,
        listing_id: listing_id.to_string(),
        message: BUY_CACHE_MESSAGE.to_string(),
        purchased_qty: buy_qty,
        total_usdc: total_price,
        cached: false,
    })
}

async fn lock_listed_instances_for_buy<C: GenericClient>(
    client: &C,
    listing_id: &str,
    line_qty: i32,
) -> Result<Vec<String>, MarketError> {
    let join_ids = select_listing_instance_ids(client, listing_id).await?;
    if join_ids.len() != usize::try_from(line_qty).unwrap_or(0) {
        return Err(MarketError::conflict(ERR_LISTING_INSTANCE_COUNT));
    }
    let uuids: Vec<uuid::Uuid> = join_ids
        .iter()
        .map(|s| uuid::Uuid::parse_str(s).map_err(MarketError::transport))
        .collect::<Result<Vec<_>, _>>()?;
    let rows = client
        .query(LOCK_INSTANCES_SQL, &[&uuids])
        .await
        .map_err(MarketError::transport)?;
    if rows.len() != join_ids.len() {
        return Err(MarketError::conflict(ERR_LISTING_INSTANCES_UNAVAILABLE));
    }
    for row in &rows {
        let status: String = row.get("status");
        if status != ITEM_INSTANCE_STATUS_LISTED {
            return Err(MarketError::conflict(ERR_LISTING_INSTANCES_UNAVAILABLE));
        }
    }
    Ok(join_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_sql() -> String {
        [
            SELECT_LISTING_FOR_BUY_SQL,
            SELECT_REFERRER_PROBE_SQL,
            SELECT_BUYER_USDC_SQL,
            SELECT_BASE_COST_SQL,
            LOCK_INSTANCES_SQL,
            SELECT_TAX_SQL,
            PAY_BUYER_SQL,
            CREDIT_SELLER_SQL,
            FULL_SALE_SQL,
            SHRINK_SQL,
            INSERT_CUSTODY_SQL,
            MOVE_JOIN_SQL,
            INSERT_HISTORY_SQL,
            INSERT_IDEM_SQL,
            SELECT_IDEM_SQL,
        ]
        .join("\n")
    }

    #[test]
    fn buy_sql_no_mint_no_consume_no_transfer() {
        let sql = all_sql();
        let lower = sql.to_ascii_lowercase();
        assert!(!lower.contains("gen_random_uuid"));
        assert!(!lower.contains("consume"));
        assert!(!lower.contains("mint"));
        assert!(!PAY_BUYER_SQL.contains("item_instances"));
        assert!(!CREDIT_SELLER_SQL.contains("item_instances"));
        assert!(!INSERT_HISTORY_SQL.contains("item_instances"));
        assert!(!FULL_SALE_SQL.contains("transfer"));
        assert!(SELECT_IDEM_SQL.contains("p2p_market_buy_idempotency"));
        assert!(LOCK_INSTANCES_SQL.contains("FOR UPDATE"));
        assert!(LOCK_INSTANCES_SQL.contains("ORDER BY id"));
    }

    #[test]
    fn parse_qty_matches_node() {
        assert_eq!(parse_requested_buy_qty(None), None);
        assert_eq!(parse_requested_buy_qty(Some(&json!(2))), Some(2));
        assert_eq!(parse_requested_buy_qty(Some(&json!("3"))), Some(3));
        assert_eq!(parse_requested_buy_qty(Some(&json!(""))), None);
        assert_eq!(parse_requested_buy_qty(Some(&json!(0))), None);
    }

    #[test]
    fn buy_uses_named_buy_timeouts_and_conflict_on_cached_key() {
        let src = include_str!("buy.rs");
        let prod = src.split("#[cfg(test)]").next().expect("prod");
        assert!(prod.contains("set_buy_tx_timeouts"));
        assert!(!prod.contains("set_market_tx_timeouts"));
        assert!(prod.contains("ERR_IDEMPOTENCY_CONFLICT"));
        assert!(prod.contains("CODE_IDEMPOTENCY_CONFLICT"));
        assert!(!prod.contains("outcome_from_cached"));
        assert!(prod.contains("move_ids.len() != move_n"));
        assert!(prod.contains("ERR_LISTING_INSTANCE_COUNT"));
    }
}
