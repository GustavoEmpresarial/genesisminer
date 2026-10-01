//! Admin shop purchase history — `shop_checkout_idempotency` (in-game USDC, not OpenSea).

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

pub const ADMIN_SHOP_CHECKOUTS_PATH: &str = "/v1/admin/shop/checkouts";

/// Same row cap as wallet `PLAYER_HISTORY_MAX_LIMIT` and dormant `LIMIT_DEFAULT`.
pub const SHOP_CHECKOUT_HISTORY_LIMIT: i64 = 500;
/// `item_instances.catalog_item_id` / shop line id (`VarChar(200)`).
pub const SHOP_ITEM_ID_MAX: usize = 200;
/// Admin users `EMAIL_MAX` — search matches username or email.
pub const SHOP_SEARCH_MAX: usize = 254;

const HTTP_BAD_REQUEST: u16 = 400;
const CODE_VALIDATION: &str = "VALIDATION";
const ERR_ITEM_ID: &str = "Invalid item id.";
const ERR_USER_ID: &str = "Invalid user id.";
const ERR_SEARCH: &str = "Search is too long.";

const _: () = assert!(SHOP_CHECKOUT_HISTORY_LIMIT == 500);
const _: () = assert!(SHOP_ITEM_ID_MAX == 200);
const _: () = assert!(SHOP_SEARCH_MAX == 254);
const _: () = assert!(HTTP_BAD_REQUEST == 400);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopCheckoutsRequest {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub q: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopCheckoutFilter {
    pub item_id: String,
    pub user_id: Option<i32>,
    pub search: String,
}

pub fn parse_shop_checkout_filter(
    item_id: &str,
    user_id: &str,
    search: &str,
) -> Result<ShopCheckoutFilter, PlayerReadError> {
    let item_id = item_id.trim().to_string();
    if item_id.len() > SHOP_ITEM_ID_MAX || item_id.chars().any(|c| c.is_control()) {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_ITEM_ID,
            CODE_VALIDATION,
        ));
    }
    let search = search.trim().to_string();
    if search.len() > SHOP_SEARCH_MAX || search.chars().any(|c| c.is_control()) {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_SEARCH,
            CODE_VALIDATION,
        ));
    }
    let user_raw = user_id.trim();
    let user_id = if user_raw.is_empty() {
        None
    } else if !user_raw.bytes().all(|b| b.is_ascii_digit())
        || user_raw.starts_with('0')
        || user_raw.parse::<i32>().ok().filter(|n| *n > 0).is_none()
    {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_USER_ID,
            CODE_VALIDATION,
        ));
    } else {
        Some(user_raw.parse::<i32>().expect("validated digits"))
    };
    Ok(ShopCheckoutFilter {
        item_id,
        user_id,
        search,
    })
}

const LINES_JSONB: &str = r#"
CASE
  WHEN left(btrim(c.lines_json), 1) = '[' THEN c.lines_json::jsonb
  ELSE '[]'::jsonb
END
"#;

pub async fn run_admin_shop_checkouts(
    pool: &Pool,
    req: &ShopCheckoutsRequest,
) -> Result<Value, PlayerReadError> {
    let filter = parse_shop_checkout_filter(&req.item_id, &req.user_id, &req.q)?;
    let conn = pool.get().await?;
    let item = &filter.item_id;
    let search = &filter.search;
    let uid = filter.user_id;

    let totals = conn
        .query_one(
            &format!(
                r#"SELECT COALESCE(SUM(c.total_cost), 0)::float8 AS total_cost,
                          COUNT(*)::bigint AS checkout_count,
                          COALESCE(SUM(line_qty.qty), 0)::bigint AS item_qty
                     FROM shop_checkout_idempotency c
                     JOIN users u ON u.id = c.user_id
                     LEFT JOIN LATERAL (
                       SELECT COALESCE(SUM(
                         CASE
                           WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint
                           ELSE 0
                         END
                       ), 0) AS qty
                       FROM jsonb_array_elements({LINES_JSONB}) el
                       WHERE $1 = '' OR el->>'id' = $1
                     ) line_qty ON TRUE
                    WHERE ($1 = '' OR EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements({LINES_JSONB}) el
                             WHERE el->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )"#
                ,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search],
        )
        .await?;

    let total_cost: f64 = totals.try_get("total_cost").unwrap_or(0.0);
    let checkout_count: i64 = totals.try_get("checkout_count").unwrap_or(0);
    let item_qty: i64 = totals.try_get("item_qty").unwrap_or(0);

    let rows = conn
        .query(
            &format!(
                r#"SELECT c.user_id,
                          c.idempotency_key,
                          COALESCE(u.username, '') AS username,
                          COALESCE(u.email, '') AS email,
                          c.total_cost::float8 AS total_cost,
                          c.new_usdc::float8 AS new_usdc,
                          c.lines_json,
                          c.created_at
                     FROM shop_checkout_idempotency c
                     JOIN users u ON u.id = c.user_id
                    WHERE ($1 = '' OR EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements({LINES_JSONB}) el
                             WHERE el->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )
                    ORDER BY c.created_at DESC
                    LIMIT $4"#
                ,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search, &SHOP_CHECKOUT_HISTORY_LIMIT],
        )
        .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let lines_raw: String = r.try_get("lines_json").unwrap_or_default();
            json!({
                "id": r.get::<_, String>("idempotency_key"),
                "userId": r.get::<_, i32>("user_id"),
                "username": r.get::<_, String>("username"),
                "email": r.get::<_, String>("email"),
                "totalCost": r.get::<_, f64>("total_cost"),
                "newUsdc": r.get::<_, f64>("new_usdc"),
                "createdAt": r.get::<_, i64>("created_at"),
                "lines": parse_lines(&lines_raw),
            })
        })
        .collect();

    let by_item_rows = conn
        .query(
            &format!(
                r#"SELECT el->>'id' AS item_id,
                          (ARRAY_AGG(COALESCE(el->>'name', '') ORDER BY c.created_at DESC))[1] AS item_name,
                          COALESCE(SUM(
                            CASE
                              WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint
                              ELSE 0
                            END
                          ), 0)::bigint AS qty,
                          COUNT(DISTINCT (c.user_id, c.idempotency_key))::bigint AS checkouts,
                          MIN(c.created_at) AS first_at,
                          MAX(c.created_at) AS last_at
                     FROM shop_checkout_idempotency c
                     JOIN users u ON u.id = c.user_id
                     CROSS JOIN LATERAL jsonb_array_elements({LINES_JSONB}) el
                    WHERE COALESCE(el->>'id', '') <> ''
                      AND ($1 = '' OR el->>'id' = $1)
                      AND ($1 = '' OR EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements({LINES_JSONB}) hit
                             WHERE hit->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )
                    GROUP BY el->>'id'
                    ORDER BY qty DESC, item_id ASC"#,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search],
        )
        .await?;

    let by_item: Vec<Value> = by_item_rows
        .iter()
        .filter_map(|r| {
            let id: String = r.try_get("item_id").unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            let name: String = r.try_get("item_name").unwrap_or_default();
            Some(json!({
                "id": id,
                "name": name,
                "qty": r.try_get::<_, i64>("qty").unwrap_or(0),
                "checkouts": r.try_get::<_, i64>("checkouts").unwrap_or(0),
                "firstAt": r.try_get::<_, i64>("first_at").unwrap_or(0),
                "lastAt": r.try_get::<_, i64>("last_at").unwrap_or(0),
            }))
        })
        .collect();

    Ok(json!({
        "rows": items,
        "byItem": by_item,
        "totalCost": total_cost,
        "itemQty": item_qty,
        "checkoutCount": checkout_count,
        "truncated": checkout_count > SHOP_CHECKOUT_HISTORY_LIMIT,
        "limit": SHOP_CHECKOUT_HISTORY_LIMIT,
    }))
}

fn parse_lines(raw: &str) -> Vec<Value> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|line| {
            let obj = line.as_object()?;
            let id = obj.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return None;
            }
            let name = obj.get("name").and_then(Value::as_str).unwrap_or("");
            let qty = obj
                .get("qty")
                .and_then(Value::as_i64)
                .or_else(|| obj.get("qty").and_then(Value::as_f64).map(|n| n as i64))
                .unwrap_or(0)
                .max(0);
            Some(json!({ "id": id, "name": name, "qty": qty }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_filters_are_unscoped() {
        let f = parse_shop_checkout_filter("  ", "", "  ").expect("ok");
        assert_eq!(
            f,
            ShopCheckoutFilter {
                item_id: String::new(),
                user_id: None,
                search: String::new(),
            }
        );
    }

    #[test]
    fn parses_item_user_and_search() {
        let f = parse_shop_checkout_filter("gpu_nft_1", "42", "Fabio").expect("ok");
        assert_eq!(f.item_id, "gpu_nft_1");
        assert_eq!(f.user_id, Some(42));
        assert_eq!(f.search, "Fabio");
    }

    #[test]
    fn rejects_bad_user_id_and_overlong_item() {
        assert!(parse_shop_checkout_filter("", "0", "").is_err());
        assert!(parse_shop_checkout_filter("", "01", "").is_err());
        assert!(parse_shop_checkout_filter(&"x".repeat(SHOP_ITEM_ID_MAX + 1), "", "").is_err());
    }

    #[test]
    fn parse_lines_keeps_id_qty_name() {
        let lines = parse_lines(r#"[{"id":"nft_a","qty":2,"name":"NFT A"},{"id":""}]"#);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["id"], "nft_a");
        assert_eq!(lines[0]["qty"], 2);
        assert_eq!(lines[0]["name"], "NFT A");
    }
}
