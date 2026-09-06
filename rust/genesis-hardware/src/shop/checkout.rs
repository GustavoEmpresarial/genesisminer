//! Shop checkout — USDC debit + stock credit + limited sold + cart + idem in one TX.
//!
//! Mirrors Node `server/modules/shop/services/checkout.ts` without the split
//! HTTP credit hop.

use std::collections::BTreeMap;

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{
    assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH,
    TX_BUY_TIMEOUT_MS,
};
use crate::persist::credit_stock;
use crate::pg_types::pg_user_id;

use super::errors::{
    ShopError, CODE_IDEMPOTENCY_KEY_REQUIRED, CODE_IDEMPOTENCY_PAYLOAD_MISMATCH,
    ERR_CART_EMPTY_OR_INVALID, ERR_CART_IS_EMPTY, ERR_CART_ITEMS_MISSING, ERR_CART_NOT_FOUND,
    ERR_HARDWARE_MARKET_PAUSED, ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
    ERR_INSUFFICIENT_BALANCE, ERR_INVALID_ITEM_PRICE, ERR_INVALID_PURCHASE_AMOUNT,
    ERR_INVALID_SESSION, ERR_SOLD_OUT_RACE, HTTP_BAD_REQUEST, HTTP_CONFLICT,
};

/// Node `CHECKOUT_LOCK_SCOPE`.
pub const CHECKOUT_LOCK_SCOPE: &str = "shop_checkout";
/// Node `shop_checkout_user` advisory scope.
pub const CHECKOUT_USER_LOCK_SCOPE: &str = "shop_checkout_user";
/// Node `MAX_LINE_QTY`.
pub const MAX_LINE_QTY: i64 = 50_000;
/// Node `MAX_CART_LINES`.
pub const MAX_CART_LINES: usize = 100;
/// Node `MAX_UNIT_PRICE`.
pub const MAX_UNIT_PRICE: f64 = 1e12;
/// Node `MAX_LINE_COST`.
pub const MAX_LINE_COST: f64 = 1e15;
/// Node item id regex length bound.
pub const ITEM_ID_MAX_LEN: usize = 160;
/// Node `FINGERPRINT_LENGTH` in `stable-fingerprint.ts`.
pub const FINGERPRINT_HEX_LEN: usize = 32;
/// Node `FNV_OFFSET_BASIS`.
const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
/// Node `FNV_PRIME`.
const FNV_PRIME: u32 = 16_777_619;
const USER_ID_MASK_16BIT: u64 = 0xffff;
const USER_ID_SHIFT_BITS: u32 = 32;
const INT63_MASK: u64 = (1u64 << 63) - 1;

const SETTING_HARDWARE_MARKET_ENABLED: &str = "hardware_market_enabled";
const SETTING_ENABLED_VALUE: &str = "1";
const UPGRADE_STATUS_LIMITED: &str = "limited";
const FINGERPRINT_OP: &str = "shop_checkout";

const SELECT_IDEM_SQL: &str = "SELECT new_usdc, total_cost, request_fingerprint FROM shop_checkout_idempotency WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE";
const ADVISORY_LOCK_BIGINT_SQL: &str = "SELECT pg_advisory_xact_lock($1::bigint)";
const ADVISORY_LOCK_HASHTEXT_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))";
const SELECT_CART_OWN_SQL: &str =
    "SELECT id FROM shop_carts WHERE id = $1 AND user_id = $2 FOR UPDATE";
const SELECT_CART_LINES_SQL: &str =
    "SELECT product_id, qty FROM shop_cart_lines WHERE cart_id = $1 FOR UPDATE";
const SELECT_SETTING_SQL: &str = "SELECT value FROM settings WHERE key = $1";
const SELECT_UPGRADES_SQL: &str = "SELECT id, base_cost::double precision AS base_cost, name, sell_in_hardware_market, status, max_global_stock, total_sold,
              COALESCE(is_active, 1) AS ia, COALESCE(is_nft, 0) AS is_nft,
              type, category, COALESCE(asic_duration_kind, 'none') AS asic_duration_kind,
              COALESCE(asic_duration_amount, 0) AS asic_duration_amount, asic_duration_unit
       FROM upgrades WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE";
const COUNT_EXPLICIT_HARDWARE_SQL: &str = "SELECT COUNT(*)::int AS n
        FROM upgrades
       WHERE COALESCE(is_active, 1) <> 0
         AND COALESCE(sell_in_hardware_market, 1) <> 0
         AND status NOT IN ('legacy', 'exclusive', 'retired')
         AND id NOT LIKE 'temp_legacy\\_%' ESCAPE '\\'
         AND COALESCE(category, '') <> 'legacy-temp'
         AND COALESCE(type, '') <> 'legacy-temp'";
const SELECT_USDC_SQL: &str = "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
const PAY_USDC_SQL: &str =
    "UPDATE game_states SET usdc = usdc - $2, last_updated_at = $3, server_updated_at = $3
      WHERE user_id = $1 AND usdc >= $2 RETURNING usdc";
const BUMP_TOTAL_SOLD_SQL: &str =
    "UPDATE upgrades SET total_sold = total_sold + $1 WHERE id = $2 AND (max_global_stock - total_sold) >= $1";
const DELETE_CART_LINES_SQL: &str = "DELETE FROM shop_cart_lines WHERE cart_id = $1";
const BUMP_CART_UPDATED_SQL: &str = "UPDATE shop_carts SET updated_at = $1 WHERE id = $2";
const INSERT_IDEM_SQL: &str = "INSERT INTO shop_checkout_idempotency (user_id, idempotency_key, new_usdc, total_cost, lines_json, created_at, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, idempotency_key) DO NOTHING";

pub const SHOP_CHECKOUT_PATH: &str = "/v1/shop/checkout";

#[derive(Debug, Clone)]
pub struct CheckoutOutcome {
    pub new_usdc: f64,
    pub total_cost: f64,
    pub cached: bool,
}

struct LineBuy {
    id: String,
    qty: i64,
    name: String,
}

/// Node `computeAdvisoryLockKey64` (FNV-1a + userId high bits, 63-bit mask).
pub fn compute_advisory_lock_key64(user_id: i64, scope: &str, idempotency_key: &str) -> i64 {
    let composite = format!("{user_id}\0{scope}\0{idempotency_key}");
    let mut hash: u32 = FNV_OFFSET_BASIS;
    for ch in composite.chars() {
        // Node `charCodeAt` — composite is ASCII (`userId\0scope\0key`).
        hash ^= u32::from(ch as u8);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    let low_bits = u64::from(hash);
    let high_bits = (user_id as u64 & USER_ID_MASK_16BIT) << USER_ID_SHIFT_BITS;
    let key = (high_bits | low_bits) & INT63_MASK;
    i64::try_from(key).unwrap_or(i64::MAX)
}

/// Node `shopCheckoutCartFingerprint` / `stableIntentFingerprint`.
pub fn shop_checkout_cart_fingerprint(cart: &BTreeMap<String, i64>) -> String {
    let mut map = serde_json::Map::new();
    map.insert("op".to_string(), json!(FINGERPRINT_OP));
    for (id, qty) in cart {
        map.insert(format!("line:{id}"), json!(*qty));
    }
    // Keys sorted to match Node `Object.keys(parts).sort()`.
    let keys: Vec<String> = {
        let mut k: Vec<_> = map.keys().cloned().collect();
        k.sort();
        k
    };
    let mut ordered = serde_json::Map::new();
    for k in keys {
        if let Some(v) = map.get(&k) {
            ordered.insert(k, v.clone());
        }
    }
    let payload = serde_json::Value::Object(ordered).to_string();
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
        .chars()
        .take(FINGERPRINT_HEX_LEN)
        .collect()
}

fn is_valid_item_id(id: &str) -> bool {
    if id.is_empty() || id.len() > ITEM_ID_MAX_LEN {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

fn normalize_idem_key(raw: &str) -> Result<String, ShopError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(ShopError::domain_code(
            HTTP_BAD_REQUEST,
            ERR_IDEMPOTENCY_KEY_REQUIRED,
            CODE_IDEMPOTENCY_KEY_REQUIRED,
        ));
    }
    Ok(key)
}

fn parse_cart(
    raw: &serde_json::Map<String, serde_json::Value>,
) -> Result<BTreeMap<String, i64>, ShopError> {
    if raw.is_empty() || raw.len() > MAX_CART_LINES {
        return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
    }
    let mut out = BTreeMap::new();
    for (id, qty_val) in raw {
        if !is_valid_item_id(id) {
            return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
        }
        let qty = match qty_val {
            serde_json::Value::Number(n) => n.as_i64().or_else(|| {
                n.as_f64()
                    .filter(|f| f.is_finite())
                    .map(|f| f.floor() as i64)
            }),
            serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        };
        let Some(q) = qty else {
            return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
        };
        if q < 1 || q > MAX_LINE_QTY {
            return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
        }
        out.insert(id.clone(), q);
    }
    if out.is_empty() {
        return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
    }
    Ok(out)
}

async fn set_shop_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), ShopError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(ShopError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(ShopError::transport)?;
    Ok(())
}

fn market_assert_to_shop(e: MarketError) -> ShopError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            missing,
        } => ShopError::Domain {
            status,
            error,
            code,
            missing,
        },
        MarketError::Transport(err) => ShopError::Transport(err),
    }
}

pub async fn checkout(
    pool: &Pool,
    user_id: i64,
    cart_raw: serde_json::Map<String, serde_json::Value>,
    idempotency_key: &str,
    clear_cart_id: Option<&str>,
    _request_fingerprint: Option<&str>,
) -> Result<CheckoutOutcome, ShopError> {
    if user_id <= 0 {
        return Err(ShopError::unauthorized(ERR_INVALID_SESSION));
    }
    let idem_key = normalize_idem_key(idempotency_key)?;
    let clear_id = clear_cart_id.map(str::trim).filter(|s| !s.is_empty());
    let request_cart = match parse_cart(&cart_raw) {
        Ok(c) => c,
        // An empty body cart is fine: `checkout_on_tx` reloads the lines under
        // lock from `clearCartId` or, failing that, the user's own DB cart
        // (genesis-api forwards just `{idempotencyKey}`).
        Err(_) if cart_raw.is_empty() => BTreeMap::new(),
        Err(e) => return Err(e),
    };

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(ShopError::transport)?;
    set_shop_tx_timeouts(&tx).await?;
    match checkout_on_tx(&tx, user_id, &request_cart, &idem_key, clear_id).await {
        Ok(v) => {
            tx.commit().await.map_err(ShopError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn checkout_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    request_cart: &BTreeMap<String, i64>,
    idem_key: &str,
    clear_cart_id: Option<&str>,
) -> Result<CheckoutOutcome, ShopError> {
    assert_active_user(client, user_id)
        .await
        .map_err(market_assert_to_shop)?;
    let uid_pg = pg_user_id(user_id).map_err(ShopError::transport)?;

    let lock_key = compute_advisory_lock_key64(user_id, CHECKOUT_LOCK_SCOPE, idem_key);
    client
        .execute(ADVISORY_LOCK_BIGINT_SQL, &[&lock_key])
        .await
        .map_err(ShopError::transport)?;

    let idem_rows = client
        .query(SELECT_IDEM_SQL, &[&uid_pg, &idem_key])
        .await
        .map_err(ShopError::transport)?;
    if let Some(id_row) = idem_rows.first() {
        // clearCartId: charged cart came from DB under lock; body cart may differ —
        // skip mismatch (idem key already binds the prior success).
        if clear_cart_id.is_none() {
            let cart_empty = request_cart.is_empty();
            let cur_fp = shop_checkout_cart_fingerprint(request_cart);
            let st_fp: Option<String> = id_row.get("request_fingerprint");
            let st_fp = st_fp.unwrap_or_default().trim().to_string();
            if !cart_empty && !st_fp.is_empty() && cur_fp != st_fp {
                return Err(ShopError::conflict_code(
                    ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
                    CODE_IDEMPOTENCY_PAYLOAD_MISMATCH,
                ));
            }
        }
        let new_usdc: f64 = id_row.get("new_usdc");
        let total_cost: f64 = id_row.get("total_cost");
        return Ok(CheckoutOutcome {
            new_usdc,
            total_cost,
            cached: true,
        });
    }

    let mut idem_fingerprint = shop_checkout_cart_fingerprint(request_cart);

    client
        .execute(
            ADVISORY_LOCK_HASHTEXT_SQL,
            &[&CHECKOUT_USER_LOCK_SCOPE, &uid_pg.to_string()],
        )
        .await
        .map_err(ShopError::transport)?;

    // Resolve the cart to charge: an explicit `clearCartId`, or — when the caller
    // sent neither a cart nor an id (genesis-api forwards just `{idempotencyKey}`)
    // — the user's own cart from the DB.
    let effective_cart_id: Option<Uuid> = match clear_cart_id {
        Some(c) => Some(
            Uuid::parse_str(c.trim()).map_err(|_| ShopError::bad(ERR_CART_NOT_FOUND))?,
        ),
        None if request_cart.is_empty() => client
            .query_opt(
                "SELECT id FROM shop_carts WHERE user_id = $1",
                &[&uid_pg],
            )
            .await
            .map_err(ShopError::transport)?
            .map(|r| r.get::<_, Uuid>("id")),
        None => None,
    };

    let mut working_cart = request_cart.clone();
    if let Some(cart_uuid) = effective_cart_id {
        let own = client
            .query(SELECT_CART_OWN_SQL, &[&cart_uuid, &uid_pg])
            .await
            .map_err(ShopError::transport)?;
        if own.is_empty() {
            return Err(ShopError::bad(ERR_CART_NOT_FOUND));
        }
        let lines = client
            .query(SELECT_CART_LINES_SQL, &[&cart_uuid])
            .await
            .map_err(ShopError::transport)?;
        working_cart.clear();
        for ln in &lines {
            let id: String = ln.get("product_id");
            let id = id.trim().to_string();
            let qty: i32 = ln.get("qty");
            let q = i64::from(qty);
            if id.is_empty() || q < 1 {
                continue;
            }
            *working_cart.entry(id).or_insert(0) += q;
        }
        if working_cart.is_empty() {
            return Err(ShopError::unprocessable(ERR_CART_IS_EMPTY, None));
        }
        idem_fingerprint = shop_checkout_cart_fingerprint(&working_cart);
    }

    let setting_rows = client
        .query(SELECT_SETTING_SQL, &[&SETTING_HARDWARE_MARKET_ENABLED])
        .await
        .map_err(ShopError::transport)?;
    if let Some(row) = setting_rows.first() {
        let val: Option<String> = row.get("value");
        if let Some(v) = val {
            if v != SETTING_ENABLED_VALUE {
                return Err(ShopError::forbidden(ERR_HARDWARE_MARKET_PAUSED));
            }
        }
    }

    let upgrade_ids: Vec<String> = working_cart.keys().cloned().collect();
    if upgrade_ids.is_empty() {
        return Err(ShopError::bad(ERR_CART_EMPTY_OR_INVALID));
    }

    let upgrades = client
        .query(SELECT_UPGRADES_SQL, &[&upgrade_ids])
        .await
        .map_err(ShopError::transport)?;
    if upgrades.len() != upgrade_ids.len() {
        return Err(ShopError::bad(ERR_CART_ITEMS_MISSING));
    }

    let explicit_rows = client
        .query(COUNT_EXPLICIT_HARDWARE_SQL, &[])
        .await
        .map_err(ShopError::transport)?;
    let has_explicit = explicit_rows
        .first()
        .map(|r| r.get::<_, i32>("n"))
        .unwrap_or(0)
        > 0;

    let mut total_cost = 0.0_f64;
    let mut items_to_buy: Vec<LineBuy> = Vec::new();
    let mut limited_to_update: Vec<(String, i64)> = Vec::new();

    for (id, qty) in &working_cart {
        let Some(u) = upgrades.iter().find(|r| {
            let rid: String = r.get("id");
            rid == *id
        }) else {
            return Err(ShopError::bad(format!("Invalid item: {id}")));
        };
        let name: String = u.get("name");
        let ia: i32 = u.get("ia");
        if ia == 0 {
            return Err(ShopError::bad(format!("Item unavailable: {name}")));
        }
        let sell: Option<i32> = u.get("sell_in_hardware_market");
        if has_explicit && sell.unwrap_or(1) == 0 {
            return Err(ShopError::bad(format!(
                "Item not available for sale: {name}"
            )));
        }
        let status: String = u.get("status");
        if status == UPGRADE_STATUS_LIMITED {
            let max_stock: Option<i32> = u.get("max_global_stock");
            let total_sold: i32 = u.get("total_sold");
            let available = i64::from(max_stock.unwrap_or(0)) - i64::from(total_sold);
            if available < *qty {
                return Err(ShopError::unprocessable(
                    format!("Insufficient stock for {name}. {available} left."),
                    None,
                ));
            }
            limited_to_update.push((id.clone(), *qty));
        }
        let unit: f64 = u.get("base_cost");
        if !unit.is_finite() || unit < 0.0 || unit > MAX_UNIT_PRICE {
            return Err(ShopError::bad(ERR_INVALID_ITEM_PRICE));
        }
        let cost = unit * (*qty as f64);
        if !cost.is_finite() || cost < 0.0 || cost > MAX_LINE_COST {
            return Err(ShopError::bad(ERR_INVALID_PURCHASE_AMOUNT));
        }
        total_cost += cost;
        items_to_buy.push(LineBuy {
            id: id.clone(),
            qty: *qty,
            name,
        });
    }

    let gs_rows = client
        .query(SELECT_USDC_SQL, &[&uid_pg])
        .await
        .map_err(ShopError::transport)?;
    let current_usdc: f64 = gs_rows
        .first()
        .map(|r| r.get::<_, f64>("usdc"))
        .unwrap_or(0.0);
    if current_usdc < total_cost {
        return Err(ShopError::unprocessable(
            ERR_INSUFFICIENT_BALANCE,
            Some(total_cost - current_usdc),
        ));
    }

    let now = current_unix_ms();
    let pay_rows = client
        .query(PAY_USDC_SQL, &[&uid_pg, &total_cost, &now])
        .await
        .map_err(ShopError::transport)?;
    let Some(pay) = pay_rows.first() else {
        return Err(ShopError::unprocessable(ERR_INSUFFICIENT_BALANCE, None));
    };
    let new_usdc: f64 = pay.get("usdc");

    for (id, qty) in &limited_to_update {
        let qty_i32 = i32::try_from(*qty).map_err(ShopError::transport)?;
        let updated = client
            .execute(BUMP_TOTAL_SOLD_SQL, &[&qty_i32, id])
            .await
            .map_err(ShopError::transport)?;
        if updated == 0 {
            return Err(ShopError::domain(HTTP_CONFLICT, ERR_SOLD_OUT_RACE));
        }
    }

    for item in &items_to_buy {
        credit_stock(client, user_id, &item.id, item.qty, None, None)
            .await
            .map_err(ShopError::transport)?;
    }

    if let Some(cart_uuid) = effective_cart_id {
        client
            .execute(DELETE_CART_LINES_SQL, &[&cart_uuid])
            .await
            .map_err(ShopError::transport)?;
        client
            .execute(BUMP_CART_UPDATED_SQL, &[&now, &cart_uuid])
            .await
            .map_err(ShopError::transport)?;
    }

    let lines_json = serde_json::to_string(
        &items_to_buy
            .iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "qty": i.qty,
                    "name": i.name,
                })
            })
            .collect::<Vec<_>>(),
    )
    .map_err(ShopError::transport)?;

    client
        .execute(
            INSERT_IDEM_SQL,
            &[
                &uid_pg,
                &idem_key,
                &new_usdc,
                &total_cost,
                &lines_json,
                &now,
                &idem_fingerprint,
            ],
        )
        .await
        .map_err(ShopError::transport)?;

    Ok(CheckoutOutcome {
        new_usdc,
        total_cost,
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisory_lock_key_stable_for_same_inputs() {
        let a = compute_advisory_lock_key64(1, CHECKOUT_LOCK_SCOPE, "shopkey12345678");
        let b = compute_advisory_lock_key64(1, CHECKOUT_LOCK_SCOPE, "shopkey12345678");
        assert_eq!(a, b);
        assert!(a >= 0);
        let c = compute_advisory_lock_key64(2, CHECKOUT_LOCK_SCOPE, "shopkey12345678");
        assert_ne!(a, c);
    }

    #[test]
    fn fingerprint_stable_and_order_independent_via_btree() {
        let mut a = BTreeMap::new();
        a.insert("gpu_1".to_string(), 2);
        a.insert("gpu_2".to_string(), 1);
        let mut b = BTreeMap::new();
        b.insert("gpu_2".to_string(), 1);
        b.insert("gpu_1".to_string(), 2);
        assert_eq!(
            shop_checkout_cart_fingerprint(&a),
            shop_checkout_cart_fingerprint(&b)
        );
        assert_eq!(
            shop_checkout_cart_fingerprint(&a).len(),
            FINGERPRINT_HEX_LEN
        );
    }

    #[test]
    fn checkout_sql_paths_cover_usdc_credit_idem_cart() {
        let sql = [
            SELECT_IDEM_SQL,
            PAY_USDC_SQL,
            BUMP_TOTAL_SOLD_SQL,
            INSERT_IDEM_SQL,
            DELETE_CART_LINES_SQL,
            SELECT_UPGRADES_SQL,
            ADVISORY_LOCK_HASHTEXT_SQL,
        ]
        .join("\n");
        assert!(PAY_USDC_SQL.contains("usdc >= $2"));
        assert!(SELECT_IDEM_SQL.contains("shop_checkout_idempotency"));
        assert!(sql.contains("FOR UPDATE"));
        assert!(ADVISORY_LOCK_HASHTEXT_SQL.contains("shop_checkout_user") == false);
        assert!(CHECKOUT_USER_LOCK_SCOPE == "shop_checkout_user");
    }

    #[test]
    fn parse_cart_rejects_empty_and_bad_qty() {
        let empty = serde_json::Map::new();
        assert!(parse_cart(&empty).is_err());
        let mut bad = serde_json::Map::new();
        bad.insert("gpu_1".into(), json!(0));
        assert!(parse_cart(&bad).is_err());
        let mut ok = serde_json::Map::new();
        ok.insert("gpu_1".into(), json!(2));
        assert_eq!(parse_cart(&ok).unwrap().get("gpu_1"), Some(&2));
    }

    #[test]
    fn idem_replay_skips_fingerprint_when_clear_cart_id() {
        let src = include_str!("checkout.rs");
        let prod = src.split("#[cfg(test)]").next().expect("prod");
        assert!(
            prod.contains("if clear_cart_id.is_none()"),
            "replay must skip body fp mismatch when clearCartId is set"
        );
        assert!(prod.contains("shop_checkout_cart_fingerprint(&working_cart)"));
    }
}
