//! Lucky-box purchase — USDC debit + unopened box + idem in one TX.
//!
//! Mirrors Node `executeLootBoxBuyInTransaction`.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use serde_json::json;

use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{
    assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH,
    TX_BUY_TIMEOUT_MS,
};
use crate::pg_types::pg_user_id;

use super::errors::{
    LuckyBoxError, ERR_BOX_NOT_FOR_SALE, ERR_BOX_NOT_FOUND, ERR_GAME_STATE_MISSING,
    ERR_IDEMPOTENCY_CORRUPT, ERR_IDEMPOTENCY_IN_FLIGHT, ERR_IDEMPOTENCY_KEY_REQUIRED,
    ERR_IDEMPOTENCY_PAYLOAD_MISMATCH, ERR_INSUFFICIENT_USDC, ERR_INVALID_BOX_PRICE,
    ERR_INVALID_SESSION, ERR_MAX_PER_USER, ERR_NO_PRIZES_CONFIGURED_SALE, ERR_SHOP_ONCE_CLAIMED,
    ERR_SHOP_ONCE_QTY, ERR_STOCK_SOLD_OUT, HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_NOT_FOUND,
    HTTP_OK, HTTP_UNPROCESSABLE_ENTITY,
};

/// Node `DEFAULT_MAX_PER_ORDER`.
pub const DEFAULT_MAX_PER_ORDER: i32 = 20;
/// Node `MAX_ORDER_CEILING`.
pub const MAX_ORDER_CEILING: i32 = 500;
/// Node `MAX_PRICE_CEILING`.
pub const MAX_PRICE_CEILING: f64 = 1e12;
/// Node `USDC_DECIMAL_PLACES`.
pub const USDC_DECIMAL_PLACES: i32 = 6;
/// Node `FINGERPRINT_MAX_LENGTH`.
pub const FINGERPRINT_MAX_LENGTH: usize = 64;
/// Node purchase scope.
pub const PURCHASE_SCOPE: &str = "purchase";
/// Advisory lock label (Node `hashtext('lucky_box_purchase')`).
pub const PURCHASE_LOCK_LABEL: &str = "lucky_box_purchase";

pub const LUCKY_BOX_BUY_PATH: &str = "/v1/lucky-boxes/buy";

const ADVISORY_LOCK_HASHTEXT_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))";
const SELECT_IDEM_SQL: &str = "SELECT http_status, body_json, request_fingerprint
     FROM lucky_box_idempotency
     WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE";
const INSERT_IDEM_SQL: &str = "INSERT INTO lucky_box_idempotency
     (user_id, scope, idempotency_key, http_status, body_json, created_at, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)";
const SELECT_BOX_SQL: &str = "SELECT id, name, trigger, price::double precision AS price,
            is_active, max_per_order, max_per_user, stock
     FROM loot_boxes WHERE id = $1";
const COUNT_ITEMS_SQL: &str = "SELECT COUNT(*)::int AS n FROM loot_box_items WHERE box_id = $1";
const SELECT_OWNED_SQL: &str = "SELECT qty FROM unopened_boxes WHERE user_id = $1 AND box_id = $2";
const INSERT_CLAIMED_SQL: &str =
    "INSERT INTO player_claimed_boxes (user_id, box_id, claimed_at) VALUES ($1, $2, $3)";
const DELETE_CLAIMED_SQL: &str =
    "DELETE FROM player_claimed_boxes WHERE user_id = $1 AND box_id = $2";
const SELECT_USDC_SQL: &str =
    "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
const SELECT_USDC_READONLY_SQL: &str =
    "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1";
const PAY_USDC_SQL: &str = "UPDATE game_states
    SET usdc = usdc - $2, last_updated_at = $3, server_updated_at = $3
    WHERE user_id = $1 AND usdc >= $2
    RETURNING usdc::double precision AS usdc";
const UPSERT_UNOPENED_SQL: &str =
    "INSERT INTO unopened_boxes (user_id, box_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, box_id) DO UPDATE SET qty = unopened_boxes.qty + EXCLUDED.qty";
const DECR_STOCK_SQL: &str =
    "UPDATE loot_boxes SET stock = stock - $2 WHERE id = $1 AND stock >= $2";

#[derive(Debug, Clone)]
pub struct BuyOutcome {
    pub new_usdc: f64,
    pub box_name: String,
    pub trigger: String,
    pub price: f64,
    pub qty_purchased: i32,
    pub cached: bool,
}

fn market_to_lucky(e: MarketError) -> LuckyBoxError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => LuckyBoxError::Domain {
            status,
            error,
            code,
            missing: None,
        },
        MarketError::Transport(err) => LuckyBoxError::Transport(err),
    }
}

fn normalize_idem_key(raw: &str) -> Result<String, LuckyBoxError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(LuckyBoxError::buy(
            HTTP_BAD_REQUEST,
            ERR_IDEMPOTENCY_KEY_REQUIRED,
            None,
        ));
    }
    Ok(key)
}

fn normalize_fingerprint(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let clipped = if s.len() > FINGERPRINT_MAX_LENGTH {
        s[..FINGERPRINT_MAX_LENGTH].to_string()
    } else {
        s.to_string()
    };
    Some(clipped)
}

fn round_usdc(v: f64) -> f64 {
    let factor = 10f64.powi(USDC_DECIMAL_PLACES);
    (v * factor).round() / factor
}

fn is_loot_box_listed_as_active(is_active: Option<i32>) -> bool {
    matches!(is_active, None | Some(1))
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code().map(|c| c.code() == "23505").unwrap_or(false)
}

async fn set_buy_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), LuckyBoxError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(LuckyBoxError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(LuckyBoxError::transport)?;
    Ok(())
}

pub async fn buy(
    pool: &Pool,
    user_id: i64,
    box_id: &str,
    qty: Option<i32>,
    idempotency_key: &str,
    idempotency_fingerprint: Option<&str>,
) -> Result<BuyOutcome, LuckyBoxError> {
    if user_id <= 0 {
        return Err(LuckyBoxError::unauthorized(ERR_INVALID_SESSION));
    }
    let box_id = box_id.trim();
    if box_id.is_empty() {
        return Err(LuckyBoxError::buy(HTTP_NOT_FOUND, ERR_BOX_NOT_FOUND, None));
    }
    let idem_key = normalize_idem_key(idempotency_key)?;
    let idem_fp = normalize_fingerprint(idempotency_fingerprint);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(LuckyBoxError::transport)?;
    set_buy_tx_timeouts(&tx).await?;
    match buy_on_tx(&tx, user_id, box_id, qty, &idem_key, idem_fp.as_deref()).await {
        Ok(v) => {
            tx.commit().await.map_err(LuckyBoxError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn buy_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    box_id: &str,
    qty_arg: Option<i32>,
    idem_key: &str,
    idem_fp: Option<&str>,
) -> Result<BuyOutcome, LuckyBoxError> {
    let uid_pg = pg_user_id(user_id).map_err(LuckyBoxError::transport)?;
    let lock_payload = format!("{user_id}:{idem_key}");
    client
        .execute(
            ADVISORY_LOCK_HASHTEXT_SQL,
            &[&PURCHASE_LOCK_LABEL, &lock_payload],
        )
        .await
        .map_err(LuckyBoxError::transport)?;

    let existing = client
        .query(SELECT_IDEM_SQL, &[&uid_pg, &PURCHASE_SCOPE, &idem_key])
        .await
        .map_err(LuckyBoxError::transport)?;
    if let Some(row) = existing.first() {
        let http_status: i32 = row.get("http_status");
        if http_status >= i32::from(HTTP_OK) && http_status < i32::from(HTTP_BAD_REQUEST) {
            let stored_fp: Option<String> = row.get("request_fingerprint");
            let stored_fp = stored_fp.unwrap_or_default().trim().to_string();
            if !stored_fp.is_empty() {
                if let Some(fp) = idem_fp {
                    if stored_fp != fp {
                        return Err(LuckyBoxError::buy(
                            HTTP_CONFLICT,
                            ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
                            None,
                        ));
                    }
                }
            }
            let body_json: String = row.get("body_json");
            // Fail-closed on corrupt cache — never invent newUsdc=0 with cached:true.
            let v: serde_json::Value = serde_json::from_str(&body_json)
                .map_err(|_| LuckyBoxError::buy(HTTP_CONFLICT, ERR_IDEMPOTENCY_CORRUPT, None))?;
            let qty_purchased = v
                .get("qtyPurchased")
                .and_then(|x| x.as_i64())
                .filter(|n| *n >= 1)
                .unwrap_or(1) as i32;
            let new_usdc = match v
                .get("newUsdc")
                .and_then(|x| x.as_f64())
                .filter(|n| n.is_finite())
            {
                Some(n) => n,
                None => {
                    // Rehydrate from live balance when payload lacks newUsdc.
                    let gs = client
                        .query(SELECT_USDC_READONLY_SQL, &[&uid_pg])
                        .await
                        .map_err(LuckyBoxError::transport)?;
                    gs.first()
                        .map(|r| r.get::<_, f64>("usdc"))
                        .filter(|n| n.is_finite())
                        .ok_or_else(|| {
                            LuckyBoxError::buy(HTTP_CONFLICT, ERR_IDEMPOTENCY_CORRUPT, None)
                        })?
                }
            };
            return Ok(BuyOutcome {
                new_usdc,
                box_name: String::new(),
                trigger: String::new(),
                price: 0.0,
                qty_purchased,
                cached: true,
            });
        }
    }

    let box_rows = client
        .query(SELECT_BOX_SQL, &[&box_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(box_row) = box_rows.first() else {
        return Err(LuckyBoxError::buy(HTTP_NOT_FOUND, ERR_BOX_NOT_FOUND, None));
    };
    let is_active: Option<i32> = box_row.get("is_active");
    if !is_loot_box_listed_as_active(is_active) {
        return Err(LuckyBoxError::buy(HTTP_NOT_FOUND, ERR_BOX_NOT_FOUND, None));
    }

    let trigger: String = box_row.get("trigger");
    let trigger = trigger.trim().to_string();
    if trigger != "shop" && trigger != "shop_once" && trigger != "special" {
        return Err(LuckyBoxError::buy(
            HTTP_BAD_REQUEST,
            ERR_BOX_NOT_FOR_SALE,
            None,
        ));
    }

    let price: f64 = box_row.get("price");
    if !price.is_finite() || price <= 0.0 || price > MAX_PRICE_CEILING {
        return Err(LuckyBoxError::buy(
            HTTP_BAD_REQUEST,
            ERR_INVALID_BOX_PRICE,
            None,
        ));
    }

    let max_order_raw: Option<i32> = box_row.get("max_per_order");
    let max_order = max_order_raw
        .unwrap_or(DEFAULT_MAX_PER_ORDER)
        .max(1)
        .min(MAX_ORDER_CEILING);
    let mut q = qty_arg.unwrap_or(1).max(1);
    q = q.min(max_order);
    if trigger == "shop_once" && q != 1 {
        return Err(LuckyBoxError::buy(
            HTTP_BAD_REQUEST,
            ERR_SHOP_ONCE_QTY,
            None,
        ));
    }

    let item_count = client
        .query(COUNT_ITEMS_SQL, &[&box_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let n: i32 = item_count.first().map(|r| r.get("n")).unwrap_or(0);
    if n < 1 {
        return Err(LuckyBoxError::buy(
            HTTP_BAD_REQUEST,
            ERR_NO_PRIZES_CONFIGURED_SALE,
            None,
        ));
    }

    let owned_rows = client
        .query(SELECT_OWNED_SQL, &[&uid_pg, &box_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let owned: i32 = owned_rows
        .first()
        .map(|r| r.get::<_, i32>("qty"))
        .unwrap_or(0);
    let max_per_user: Option<i32> = box_row.get("max_per_user");
    if let Some(max_u) = max_per_user {
        if max_u >= 0 && owned + q > max_u {
            return Err(LuckyBoxError::buy(
                HTTP_UNPROCESSABLE_ENTITY,
                ERR_MAX_PER_USER,
                None,
            ));
        }
    }

    let now = current_unix_ms();
    if trigger == "shop_once" {
        match client
            .execute(INSERT_CLAIMED_SQL, &[&uid_pg, &box_id, &now])
            .await
        {
            Ok(_) => {}
            Err(e) if is_unique_violation(&e) => {
                return Err(LuckyBoxError::buy(
                    HTTP_CONFLICT,
                    ERR_SHOP_ONCE_CLAIMED,
                    None,
                ));
            }
            Err(e) => return Err(LuckyBoxError::transport(e)),
        }
    }

    let total_price = price * f64::from(q);

    assert_active_user(client, user_id)
        .await
        .map_err(market_to_lucky)?;

    let gs = client
        .query(SELECT_USDC_SQL, &[&uid_pg])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(gs_row) = gs.first() else {
        return Err(LuckyBoxError::buy(
            HTTP_UNPROCESSABLE_ENTITY,
            ERR_GAME_STATE_MISSING,
            None,
        ));
    };
    let cur_usdc: f64 = gs_row.get("usdc");
    if cur_usdc < total_price {
        let missing = round_usdc((total_price - cur_usdc).max(0.0));
        return Err(LuckyBoxError::buy(
            HTTP_UNPROCESSABLE_ENTITY,
            ERR_INSUFFICIENT_USDC,
            Some(missing),
        ));
    }

    let pay = client
        .query(PAY_USDC_SQL, &[&uid_pg, &total_price, &now])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(pay_row) = pay.first() else {
        if trigger == "shop_once" {
            let _ = client
                .execute(DELETE_CLAIMED_SQL, &[&uid_pg, &box_id])
                .await;
        }
        let missing = round_usdc((total_price - cur_usdc).max(0.0));
        return Err(LuckyBoxError::buy(
            HTTP_UNPROCESSABLE_ENTITY,
            ERR_INSUFFICIENT_USDC,
            Some(missing),
        ));
    };
    let new_usdc: f64 = pay_row.get("usdc");

    client
        .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &box_id, &q])
        .await
        .map_err(LuckyBoxError::transport)?;

    let stock: Option<i32> = box_row.get("stock");
    if stock.is_some() {
        let updated = client
            .execute(DECR_STOCK_SQL, &[&box_id, &q])
            .await
            .map_err(LuckyBoxError::transport)?;
        if updated == 0 {
            return Err(LuckyBoxError::buy(HTTP_CONFLICT, ERR_STOCK_SOLD_OUT, None));
        }
    }

    let box_name: String = box_row.get("name");
    // Inventory is rebuilt by Node `buildLuckyBoxesStateV1` on every purchase response
    // (including replay) — do not store a stale/empty inventory snapshot here.
    let payload = json!({
        "ok": true,
        "newUsdc": new_usdc,
        "qtyPurchased": q,
        "boxId": box_id,
        "version": 1,
    });
    let body_json = serde_json::to_string(&payload).map_err(LuckyBoxError::transport)?;
    let http_ok: i32 = i32::from(HTTP_OK);
    let fp_bind: Option<&str> = idem_fp;
    match client
        .execute(
            INSERT_IDEM_SQL,
            &[
                &uid_pg,
                &PURCHASE_SCOPE,
                &idem_key,
                &http_ok,
                &body_json,
                &now,
                &fp_bind,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            return Err(LuckyBoxError::buy(
                HTTP_CONFLICT,
                ERR_IDEMPOTENCY_IN_FLIGHT,
                None,
            ));
        }
        Err(e) => return Err(LuckyBoxError::transport(e)),
    }

    Ok(BuyOutcome {
        new_usdc,
        box_name,
        trigger,
        price,
        qty_purchased: q,
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pay_sql_guard() {
        assert!(PAY_USDC_SQL.contains("usdc >= $2"));
        assert!(INSERT_IDEM_SQL.contains("lucky_box_idempotency"));
    }

    #[test]
    fn idem_body_omits_inventory_node_rebuilds() {
        let src = include_str!("buy.rs");
        let prod = src.split("#[cfg(test)]").next().expect("prod");
        assert!(
            !prod.contains("\"inventory\""),
            "worker body_json must not hardcode inventory; Node rebuilds via buildLuckyBoxesStateV1"
        );
        assert!(prod.contains("ERR_IDEMPOTENCY_CORRUPT"));
        assert!(prod.contains("SELECT_USDC_READONLY_SQL"));
    }

    #[test]
    fn max_order_clamp_constants() {
        assert!(DEFAULT_MAX_PER_ORDER <= MAX_ORDER_CEILING);
        assert!(MAX_PRICE_CEILING > 0.0);
    }
}
