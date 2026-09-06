//! Shop state + products + cart CRUD — Node `shop/services/{snapshot,cart,catalog}.ts`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::catalog::is_valid_shop_product_id;
use genesis_core::catalog::TEMP_LEGACY_ID_PREFIX;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

/// Parse a cart / line id string into a `Uuid` for binding. Postgres resolves a
/// `$1::uuid` param in a `VALUES` list to the `uuid` type, so a `String` bind
/// there fails with "error serializing parameter 0" — bind a real `Uuid`.
fn parse_uuid(raw: &str, err: &str) -> Result<Uuid, PlayerReadError> {
    Uuid::parse_str(raw.trim()).map_err(|_| PlayerReadError {
        http_status: HTTP_NOT_FOUND,
        error: err.to_string(),
        code: None,
    })
}

use crate::config::current_unix_ms;
use crate::pg_types::pg_user_id;
use crate::shop::checkout::MAX_LINE_QTY;

use super::{
    f64_cell, i32_cell, i64_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError,
    HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE,
};

const SETTING_HARDWARE_MARKET: &str = "hardware_market_enabled";
const SETTING_ON: &str = "1";
const CAT_LEGACY_TEMP: &str = "legacy-temp";
const MERGE_PREFIX: &str = "merge_";
const STATE_VERSION: i32 = 1;
const STATUS_LEGACY: &str = "legacy";
const STATUS_EXCLUSIVE: &str = "exclusive";
const STATUS_RETIRED: &str = "retired";
const STATUS_LIMITED: &str = "limited";
const ERR_INVALID_PRODUCT: &str = "Invalid product.";
const ERR_INVALID_QTY: &str = "Invalid quantity.";
const ERR_MARKET_PAUSED: &str = "Hardware market paused.";
const ERR_CART_NOT_FOUND: &str = "Cart not found.";
const ERR_LINE_NOT_FOUND: &str = "Line not found.";
const ERR_INVALID_LINE: &str = "Invalid line.";
const ERR_NOT_FOR_SALE: &str = "This item is not for sale in the Shop.";
const ERR_PRODUCT_UNAVAILABLE: &str = "Product unavailable.";
const ERR_ITEM_NOT_AVAILABLE: &str = "Item not available for purchase.";
const ERR_PRODUCT_NOT_FOUND: &str = "Product not found.";

const _: () = assert!(MAX_LINE_QTY == 50_000);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopCartSetRequest {
    pub user_id: i64,
    pub product_id: String,
    /// Client sends `quantity`; accept both.
    #[serde(alias = "quantity")]
    pub qty: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopCartSetLineRequest {
    pub user_id: i64,
    pub line_id: String,
    /// Client sends `quantity`; accept both.
    #[serde(alias = "quantity")]
    pub qty: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopCartLineRequest {
    pub user_id: i64,
    pub line_id: String,
}

/// Node `ORDER_ID_MAX_LENGTH` in shop.controller.ts.
const ORDER_ID_MAX_LENGTH: usize = 128;

const _: () = assert!(ORDER_ID_MAX_LENGTH == 128);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopOrderRequest {
    pub user_id: i64,
    pub order_id: String,
}

pub async fn run_shop_state(
    pool: &Pool,
    user_id: i64,
    is_admin: bool,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    build_shop_state(&conn, user_id, is_admin).await
}

async fn build_shop_state<C: GenericClient>(
    client: &C,
    user_id: i64,
    is_admin: bool,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let products = load_filtered_products(client, is_admin).await?;
    let gs = client
        .query_opt("SELECT usdc FROM game_states WHERE user_id = $1", &[&uid])
        .await?;
    let usdc = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);
    let hw = client
        .query_opt(
            "SELECT value FROM settings WHERE key = $1",
            &[&SETTING_HARDWARE_MARKET],
        )
        .await?;
    let hardware_market_enabled = match hw.as_ref().and_then(|r| opt_string_cell(r, "value")) {
        None => true,
        Some(v) => v == SETTING_ON,
    };

    let (cart_id, raw_lines) = match load_cart_lines(client, uid).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(err = %e.error, uid, "shop state: cart lines load failed");
            (String::new(), Vec::new())
        }
    };

    let mut price_by_id = std::collections::HashMap::new();
    for p in &products {
        if let Some(id) = p.get("id").and_then(|x| x.as_str()) {
            if let Some(cost) = p.get("baseCost").and_then(|x| x.as_f64()) {
                price_by_id.insert(id.to_string(), cost);
            }
        }
    }

    let mut lines = Vec::new();
    let mut total_usdc = 0.0;
    for (line_id, product_id, qty) in raw_lines {
        let Some(&unit) = price_by_id.get(&product_id) else {
            continue;
        };
        let line_total = unit * f64::from(qty);
        if !line_total.is_finite() || line_total < 0.0 {
            continue;
        }
        total_usdc += line_total;
        lines.push(json!({
            "lineId": line_id,
            "productId": product_id,
            "qty": qty,
            "unitPrice": unit,
            "lineTotal": line_total,
        }));
    }

    Ok(json!({
        "version": STATE_VERSION,
        "hardwareMarketEnabled": hardware_market_enabled,
        "usdc": usdc,
        "products": products,
        "cart": {
            "cartId": cart_id,
            "lines": lines,
            "totalUsdc": total_usdc,
        }
    }))
}

async fn load_cart_lines<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<(String, Vec<(String, String, i32)>), PlayerReadError> {
    let cart = client
        .query_opt(
            "SELECT id::text AS id FROM shop_carts WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(cart) = cart else {
        return Ok((String::new(), Vec::new()));
    };
    let cart_id = string_cell(&cart, "id");
    let cart_uuid = parse_uuid(&cart_id, "cart id not a uuid")?;
    let rows = client
        .query(
            "SELECT id::text AS id, product_id, qty FROM shop_cart_lines WHERE cart_id = $1 AND qty > 0",
            &[&cart_uuid],
        )
        .await?;
    let lines = rows
        .iter()
        .map(|r| {
            (
                string_cell(r, "id"),
                string_cell(r, "product_id"),
                i32_cell(r, "qty"),
            )
        })
        .collect();
    Ok((cart_id, lines))
}

async fn load_filtered_products<C: GenericClient>(
    client: &C,
    is_admin: bool,
) -> Result<Vec<Value>, PlayerReadError> {
    let sql = if is_admin {
        "SELECT * FROM upgrades
          WHERE id NOT LIKE 'temp_legacy\\_%' ESCAPE '\\'
            AND id NOT LIKE 'merge\\_%' ESCAPE '\\'
            AND COALESCE(category, '') <> 'legacy-temp'
            AND COALESCE(type, '') <> 'legacy-temp'"
    } else {
        "SELECT * FROM upgrades
          WHERE id NOT LIKE 'temp_legacy\\_%' ESCAPE '\\'
            AND id NOT LIKE 'merge\\_%' ESCAPE '\\'
            AND COALESCE(category, '') <> 'legacy-temp'
            AND COALESCE(type, '') <> 'legacy-temp'
            AND (is_active IS NULL OR is_active <> 0)
            AND status NOT IN ('legacy', 'exclusive', 'retired')"
    };
    let rows = client.query(sql, &[]).await?;
    let compat = client
        .query("SELECT upgrade_id, rack_id FROM upgrade_compat_racks", &[])
        .await?;
    let mut compat_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &compat {
        let uid = string_cell(r, "upgrade_id");
        let rid = string_cell(r, "rack_id");
        if !uid.is_empty() && !rid.is_empty() {
            compat_map.entry(uid).or_default().push(rid);
        }
    }
    let mut products: Vec<Value> = rows
        .iter()
        .map(|r| {
            map_shop_product(
                r,
                compat_map
                    .get(&string_cell(r, "id"))
                    .cloned()
                    .unwrap_or_default(),
            )
        })
        .collect();
    products = filter_miner_shop(products);
    Ok(products)
}

fn map_shop_product(r: &tokio_postgres::Row, compatible_racks: Vec<String>) -> Value {
    let image = opt_string_cell(r, "image").and_then(|s| normalize_public_asset_url(&s));
    json!({
        "id": string_cell(r, "id"),
        "name": string_cell(r, "name"),
        "category": string_cell(r, "category"),
        "type": string_cell(r, "type"),
        "baseCost": f64_cell(r, "base_cost"),
        "baseProduction": f64_cell(r, "base_production"),
        "powerConsumption": opt_f64_or_omit(r, "power_consumption"),
        "powerCapacity": opt_f64_or_omit(r, "power_capacity"),
        "multiplier": opt_f64_or_omit(r, "multiplier"),
        "slotsCapacity": opt_i32_cell(r, "slots_capacity"),
        "aiSlotsCapacity": opt_i32_cell(r, "ai_slots_capacity"),
        "description": string_cell(r, "description"),
        "icon": string_cell(r, "icon"),
        "status": string_cell(r, "status"),
        "isNft": i32_cell(r, "is_nft") != 0,
        "maxGlobalStock": opt_i32_cell(r, "max_global_stock"),
        "totalSold": f64_cell(r, "total_sold"),
        "image": image,
        "compatibleRacks": compatible_racks,
        "rewardWh": opt_i32_cell(r, "reward_wh").unwrap_or(0),
        "sellInHardwareMarket": i32_cell(r, "sell_in_hardware_market") != 0,
        "isActive": i32_cell(r, "is_active") != 0,
    })
}

fn opt_f64_or_omit(row: &tokio_postgres::Row, col: &str) -> Option<f64> {
    let v = f64_cell(row, col);
    if v == 0.0 {
        if row.try_get::<_, Option<f64>>(col).ok().flatten().is_none()
            && row.try_get::<_, f64>(col).is_err()
        {
            return None;
        }
    }
    Some(v)
}

fn is_non_operational_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        STATUS_LEGACY | STATUS_EXCLUSIVE | STATUS_RETIRED
    )
}

fn filter_miner_shop(products: Vec<Value>) -> Vec<Value> {
    let base: Vec<Value> = products
        .into_iter()
        .filter(|p| {
            let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("");
            if id.starts_with(MERGE_PREFIX) {
                return false;
            }
            let status = p.get("status").and_then(|x| x.as_str()).unwrap_or("");
            if is_non_operational_status(status) {
                return false;
            }
            p.get("isActive").and_then(|x| x.as_bool()).unwrap_or(false)
        })
        .collect();
    let explicit: Vec<Value> = base
        .iter()
        .filter(|p| {
            p.get("sellInHardwareMarket")
                .and_then(|x| x.as_bool())
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let core = if explicit.is_empty() { base } else { explicit };
    let mut by_id = std::collections::BTreeMap::new();
    for p in core {
        if let Some(id) = p.get("id").and_then(|x| x.as_str()) {
            by_id.insert(id.to_string(), p);
        }
    }
    by_id.into_values().collect()
}

fn normalize_public_asset_url(src: &str) -> Option<String> {
    let s = src.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.to_string())
}

async fn get_or_create_cart_id<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<String, PlayerReadError> {
    if let Some(row) = client
        .query_opt(
            "SELECT id::text AS id FROM shop_carts WHERE user_id = $1",
            &[&uid],
        )
        .await?
    {
        return Ok(string_cell(&row, "id"));
    }
    let now = current_unix_ms();
    let row = client
        .query_one(
            "INSERT INTO shop_carts (user_id, updated_at) VALUES ($1, $2) RETURNING id::text AS id",
            &[&uid, &now],
        )
        .await?;
    Ok(string_cell(&row, "id"))
}

async fn assert_product_qty<C: GenericClient>(
    client: &C,
    product_id: &str,
    qty: i64,
) -> Result<(), PlayerReadError> {
    if qty < 1 {
        return Err(PlayerReadError {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_INVALID_QTY.into(),
            code: None,
        });
    }
    if product_id.starts_with(MERGE_PREFIX) {
        return Err(PlayerReadError {
            http_status: HTTP_UNPROCESSABLE,
            error: ERR_ITEM_NOT_AVAILABLE.into(),
            code: None,
        });
    }
    let row = client
        .query_opt(
            "SELECT id, name, category, type, status, is_nft, sell_in_hardware_market, is_active,
                    max_global_stock, total_sold
               FROM upgrades WHERE id = $1",
            &[&product_id],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError {
            http_status: HTTP_NOT_FOUND,
            error: ERR_PRODUCT_NOT_FOUND.into(),
            code: None,
        });
    };
    let category = string_cell(&row, "category");
    let row_type = string_cell(&row, "type");
    if product_id.starts_with(TEMP_LEGACY_ID_PREFIX)
        || category == CAT_LEGACY_TEMP
        || row_type == CAT_LEGACY_TEMP
    {
        return Err(PlayerReadError {
            http_status: HTTP_UNPROCESSABLE,
            error: ERR_ITEM_NOT_AVAILABLE.into(),
            code: None,
        });
    }
    if i32_cell(&row, "is_active") == 0 {
        return Err(PlayerReadError {
            http_status: HTTP_UNPROCESSABLE,
            error: ERR_PRODUCT_UNAVAILABLE.into(),
            code: None,
        });
    }
    let explicit = client
        .query_one(
            "SELECT COUNT(*)::int AS n FROM upgrades
              WHERE (is_active IS NULL OR is_active <> 0)
                AND sell_in_hardware_market <> 0
                AND status NOT IN ('legacy', 'exclusive', 'retired')
                AND COALESCE(category, '') <> 'legacy-temp'
                AND COALESCE(type, '') <> 'legacy-temp'
                AND id NOT LIKE 'temp_legacy\\_%' ESCAPE '\\'",
            &[],
        )
        .await?;
    if i32_cell(&explicit, "n") > 0 && i32_cell(&row, "sell_in_hardware_market") == 0 {
        return Err(PlayerReadError {
            http_status: HTTP_UNPROCESSABLE,
            error: ERR_NOT_FOR_SALE.into(),
            code: None,
        });
    }
    let status = string_cell(&row, "status");
    if is_non_operational_status(&status) {
        return Err(PlayerReadError {
            http_status: HTTP_UNPROCESSABLE,
            error: ERR_ITEM_NOT_AVAILABLE.into(),
            code: None,
        });
    }
    if status == STATUS_LIMITED {
        let max = i32_cell(&row, "max_global_stock");
        let sold = i32_cell(&row, "total_sold");
        let available = (max - sold).max(0);
        if qty > i64::from(available) {
            let name = string_cell(&row, "name");
            return Err(PlayerReadError {
                http_status: HTTP_UNPROCESSABLE,
                error: format!("Insufficient stock for \"{name}\". Available: {available}."),
                code: None,
            });
        }
    }
    Ok(())
}

pub async fn run_cart_set(
    pool: &Pool,
    user_id: i64,
    product_id: &str,
    qty: i64,
) -> Result<Value, PlayerReadError> {
    let pid = product_id.trim();
    if !is_valid_shop_product_id(pid) {
        return Err(PlayerReadError {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_INVALID_PRODUCT.into(),
            code: None,
        });
    }
    if qty < 0 || qty > MAX_LINE_QTY {
        return Err(PlayerReadError {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_INVALID_QTY.into(),
            code: None,
        });
    }
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let hw = tx
        .query_opt(
            "SELECT value FROM settings WHERE key = $1",
            &[&SETTING_HARDWARE_MARKET],
        )
        .await?;
    if let Some(row) = hw {
        if let Some(v) = opt_string_cell(&row, "value") {
            if v != SETTING_ON {
                return Err(PlayerReadError {
                    http_status: HTTP_FORBIDDEN,
                    error: ERR_MARKET_PAUSED.into(),
                    code: None,
                });
            }
        }
    }
    let uid = pg_user_id(user_id)?;
    let cart_id = get_or_create_cart_id(&tx, uid).await?;
    let cart_uuid = parse_uuid(&cart_id, ERR_CART_NOT_FOUND)?;
    let now = current_unix_ms();
    if qty == 0 {
        tx.execute(
            "DELETE FROM shop_cart_lines WHERE cart_id = $1 AND product_id = $2",
            &[&cart_uuid, &pid],
        )
        .await?;
    } else {
        assert_product_qty(&tx, pid, qty).await?;
        let q = i32::try_from(qty).map_err(|_| PlayerReadError::bad(ERR_INVALID_QTY))?;
        tx.execute(
            "INSERT INTO shop_cart_lines (cart_id, product_id, qty, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = EXCLUDED.updated_at",
            &[&cart_uuid, &pid, &q, &now],
        )
        .await?;
    }
    tx.execute(
        "UPDATE shop_carts SET updated_at = $2 WHERE id = $1",
        &[&cart_uuid, &now],
    )
    .await?;
    let state = build_shop_state(&tx, user_id, false).await?;
    tx.commit().await?;
    Ok(json!({ "shop": state }))
}

pub async fn run_cart_set_line(
    pool: &Pool,
    user_id: i64,
    line_id: &str,
    qty: i64,
) -> Result<Value, PlayerReadError> {
    let lid = line_id.trim();
    if lid.is_empty() {
        return Err(PlayerReadError {
            http_status: HTTP_BAD_REQUEST,
            error: ERR_INVALID_LINE.into(),
            code: None,
        });
    }
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let cart = conn
        .query_opt(
            "SELECT id::text AS id FROM shop_carts WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(cart) = cart else {
        return Err(PlayerReadError {
            http_status: HTTP_NOT_FOUND,
            error: ERR_CART_NOT_FOUND.into(),
            code: None,
        });
    };
    let cart_id = string_cell(&cart, "id");
    let cart_uuid = parse_uuid(&cart_id, ERR_CART_NOT_FOUND)?;
    let line_uuid = parse_uuid(lid, ERR_LINE_NOT_FOUND)?;
    let line = conn
        .query_opt(
            "SELECT product_id FROM shop_cart_lines WHERE id = $1 AND cart_id = $2",
            &[&line_uuid, &cart_uuid],
        )
        .await?;
    let Some(line) = line else {
        return Err(PlayerReadError {
            http_status: HTTP_NOT_FOUND,
            error: ERR_LINE_NOT_FOUND.into(),
            code: None,
        });
    };
    drop(conn);
    run_cart_set(pool, user_id, &string_cell(&line, "product_id"), qty).await
}

pub async fn run_cart_delete_line(
    pool: &Pool,
    user_id: i64,
    line_id: &str,
) -> Result<Value, PlayerReadError> {
    let lid = line_id.trim();
    if lid.is_empty() {
        return Err(PlayerReadError::not_found(ERR_LINE_NOT_FOUND));
    }
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let uid = pg_user_id(user_id)?;
    let cart = tx
        .query_opt(
            "SELECT id::text AS id FROM shop_carts WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(cart) = cart else {
        return Err(PlayerReadError::not_found(ERR_LINE_NOT_FOUND));
    };
    let cart_id = string_cell(&cart, "id");
    let cart_uuid = parse_uuid(&cart_id, ERR_LINE_NOT_FOUND)?;
    let line_uuid = parse_uuid(lid, ERR_LINE_NOT_FOUND)?;
    let n = tx
        .execute(
            "DELETE FROM shop_cart_lines WHERE id = $1 AND cart_id = $2",
            &[&line_uuid, &cart_uuid],
        )
        .await?;
    if n == 0 {
        return Err(PlayerReadError::not_found(ERR_LINE_NOT_FOUND));
    }
    let state = build_shop_state(&tx, user_id, false).await?;
    tx.commit().await?;
    Ok(json!({ "deleted": true, "shop": state }))
}

pub async fn run_cart_clear(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let uid = pg_user_id(user_id)?;
    let cart = tx
        .query_opt(
            "SELECT id::text AS id FROM shop_carts WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    if let Some(cart) = cart {
        let cart_id = string_cell(&cart, "id");
        if let Ok(cart_uuid) = Uuid::parse_str(cart_id.trim()) {
            let now = current_unix_ms();
            tx.execute(
                "DELETE FROM shop_cart_lines WHERE cart_id = $1",
                &[&cart_uuid],
            )
            .await?;
            tx.execute(
                "UPDATE shop_carts SET updated_at = $2 WHERE id = $1",
                &[&cart_uuid, &now],
            )
            .await?;
        }
    }
    let state = build_shop_state(&tx, user_id, false).await?;
    tx.commit().await?;
    Ok(json!({ "shop": state }))
}

pub async fn run_shop_order(
    pool: &Pool,
    user_id: i64,
    order_id: &str,
) -> Result<Value, PlayerReadError> {
    let id = order_id.trim();
    let id = if id.len() > ORDER_ID_MAX_LENGTH {
        &id[..ORDER_ID_MAX_LENGTH]
    } else {
        id
    };
    if id.is_empty() {
        return Err(PlayerReadError::bad("Invalid request."));
    }
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let row = conn
        .query_opt(
            "SELECT idempotency_key, new_usdc::double precision AS new_usdc,
                    total_cost::double precision AS total_cost, lines_json, created_at
               FROM shop_checkout_idempotency
              WHERE user_id = $1 AND idempotency_key = $2",
            &[&uid, &id],
        )
        .await?;
    let Some(r) = row else {
        return Err(PlayerReadError::not_found("Order not found."));
    };
    let lines = opt_string_cell(&r, "lines_json")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!([]));
    Ok(json!({
        "orderId": string_cell(&r, "idempotency_key"),
        "newUsdc": f64_cell(&r, "new_usdc"),
        "totalUsdc": f64_cell(&r, "total_cost"),
        "lines": lines,
        "createdAt": i64_cell(&r, "created_at"),
    }))
}
