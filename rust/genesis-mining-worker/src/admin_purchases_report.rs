//! Admin general purchases report — shop checkouts + P2P buys, by item and source.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_shop_checkouts::{
    parse_shop_checkout_filter, SHOP_CHECKOUT_HISTORY_LIMIT,
};
use crate::player_reads::PlayerReadError;

pub const ADMIN_PURCHASES_REPORT_PATH: &str = "/v1/admin/purchases/report";

const TOP_BUYERS_LIMIT: i64 = 50;
const LINES_JSONB: &str = r#"
CASE
  WHEN left(btrim(c.lines_json), 1) = '[' THEN c.lines_json::jsonb
  ELSE '[]'::jsonb
END
"#;

const LINES_JSONB_FILTERED: &str = r#"
CASE
  WHEN left(btrim(f.lines_json), 1) = '[' THEN f.lines_json::jsonb
  ELSE '[]'::jsonb
END
"#;

const _: () = assert!(TOP_BUYERS_LIMIT == 50);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasesReportRequest {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub from_ms: String,
    #[serde(default)]
    pub to_ms: String,
}

fn parse_optional_ms(raw: &str) -> Result<Option<i64>, PlayerReadError> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if !t.bytes().all(|b| b.is_ascii_digit()) || t.starts_with('0') {
        return Err(PlayerReadError::controlled(400, "Invalid time range.", "VALIDATION"));
    }
    let n: i64 = t.parse().map_err(|_| {
        PlayerReadError::controlled(400, "Invalid time range.", "VALIDATION")
    })?;
    if n <= 0 {
        return Err(PlayerReadError::controlled(400, "Invalid time range.", "VALIDATION"));
    }
    Ok(Some(n))
}

pub async fn run_admin_purchases_report(
    pool: &Pool,
    req: &PurchasesReportRequest,
) -> Result<Value, PlayerReadError> {
    let filter = parse_shop_checkout_filter(&req.item_id, &req.user_id, &req.q)?;
    let from_ms = parse_optional_ms(&req.from_ms)?;
    let to_ms = parse_optional_ms(&req.to_ms)?;
    let conn = pool.get().await?;
    let item = &filter.item_id;
    let search = &filter.search;
    let uid = filter.user_id;

    let shop_totals = conn
        .query_one(
            &format!(
                r#"SELECT COALESCE(SUM(c.total_cost), 0)::float8 AS total_cost,
                          COUNT(*)::bigint AS checkout_count,
                          COALESCE(SUM(line_qty.qty), 0)::bigint AS item_qty,
                          COUNT(DISTINCT c.user_id)::bigint AS buyers
                     FROM shop_checkout_idempotency c
                     JOIN users u ON u.id = c.user_id
                     LEFT JOIN LATERAL (
                       SELECT COALESCE(SUM(
                         CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint ELSE 0 END
                       ), 0) AS qty
                         FROM jsonb_array_elements({LINES_JSONB}) el
                        WHERE $1 = '' OR el->>'id' = $1
                     ) line_qty ON TRUE
                    WHERE ($1 = '' OR EXISTS (
                            SELECT 1 FROM jsonb_array_elements({LINES_JSONB}) el WHERE el->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND ($4::bigint IS NULL OR c.created_at >= $4)
                      AND ($5::bigint IS NULL OR c.created_at <= $5)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )"#,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let shop_by_item = conn
        .query(
            &format!(
                r#"WITH filtered AS (
                     SELECT c.user_id, c.idempotency_key, c.total_cost, c.created_at, c.lines_json
                       FROM shop_checkout_idempotency c
                       JOIN users u ON u.id = c.user_id
                      WHERE ($2::int IS NULL OR c.user_id = $2)
                        AND ($4::bigint IS NULL OR c.created_at >= $4)
                        AND ($5::bigint IS NULL OR c.created_at <= $5)
                        AND (
                          $3 = ''
                          OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                          OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                        )
                        AND ($1 = '' OR EXISTS (
                              SELECT 1 FROM jsonb_array_elements({LINES_JSONB}) hit WHERE hit->>'id' = $1
                            ))
                   ),
                   weighted AS (
                     SELECT f.user_id,
                            f.idempotency_key,
                            f.created_at,
                            el->>'id' AS item_id,
                            COALESCE(el->>'name', '') AS item_name,
                            CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint ELSE 0 END AS qty,
                            CASE
                              WHEN SUM(CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint ELSE 0 END)
                                     OVER (PARTITION BY f.user_id, f.idempotency_key) > 0
                              THEN f.total_cost * (
                                     CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::float8 ELSE 0 END
                                   ) / NULLIF(
                                     SUM(CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::float8 ELSE 0 END)
                                       OVER (PARTITION BY f.user_id, f.idempotency_key),
                                     0
                                   )
                              ELSE 0
                            END AS usdc_share
                       FROM filtered f
                       CROSS JOIN LATERAL jsonb_array_elements({LINES_JSONB_FILTERED}) el
                      WHERE COALESCE(el->>'id', '') <> ''
                        AND ($1 = '' OR el->>'id' = $1)
                   )
                   SELECT item_id,
                          (ARRAY_AGG(item_name ORDER BY created_at DESC))[1] AS item_name,
                          COALESCE(SUM(qty), 0)::bigint AS qty,
                          COUNT(DISTINCT (user_id, idempotency_key))::bigint AS checkouts,
                          COUNT(DISTINCT user_id)::bigint AS buyers,
                          COALESCE(SUM(usdc_share), 0)::float8 AS usdc,
                          MIN(created_at) AS first_at,
                          MAX(created_at) AS last_at
                     FROM weighted
                    GROUP BY item_id
                    ORDER BY qty DESC, item_id ASC"#,
                LINES_JSONB = LINES_JSONB,
                LINES_JSONB_FILTERED = LINES_JSONB_FILTERED,
            ),
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let shop_buyers = conn
        .query(
            &format!(
                r#"SELECT c.user_id,
                          COALESCE(u.username, '') AS username,
                          COALESCE(u.email, '') AS email,
                          COALESCE(SUM(c.total_cost), 0)::float8 AS total_cost,
                          COUNT(*)::bigint AS checkouts,
                          COALESCE(SUM(line_qty.qty), 0)::bigint AS item_qty
                     FROM shop_checkout_idempotency c
                     JOIN users u ON u.id = c.user_id
                     LEFT JOIN LATERAL (
                       SELECT COALESCE(SUM(
                         CASE WHEN (el->>'qty') ~ '^[0-9]+$' THEN (el->>'qty')::bigint ELSE 0 END
                       ), 0) AS qty
                         FROM jsonb_array_elements({LINES_JSONB}) el
                        WHERE $1 = '' OR el->>'id' = $1
                     ) line_qty ON TRUE
                    WHERE ($1 = '' OR EXISTS (
                            SELECT 1 FROM jsonb_array_elements({LINES_JSONB}) el WHERE el->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND ($4::bigint IS NULL OR c.created_at >= $4)
                      AND ($5::bigint IS NULL OR c.created_at <= $5)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )
                    GROUP BY c.user_id, u.username, u.email
                    ORDER BY total_cost DESC, checkouts DESC
                    LIMIT $6"#,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search, &from_ms, &to_ms, &TOP_BUYERS_LIMIT],
        )
        .await?;

    let p2p_totals = conn
        .query_one(
            r#"SELECT COALESCE(SUM(t.buyer_paid_usdc), 0)::float8 AS total_usdc,
                      COUNT(*)::bigint AS trade_count,
                      COALESCE(SUM(t.qty), 0)::bigint AS item_qty,
                      COUNT(DISTINCT t.buyer_id)::bigint AS buyers
                 FROM p2p_market_trade_history t
                 JOIN users u ON u.id = t.buyer_id
                WHERE ($1 = '' OR t.item_id = $1)
                  AND ($2::int IS NULL OR t.buyer_id = $2)
                  AND ($4::bigint IS NULL OR t.created_at >= $4)
                  AND ($5::bigint IS NULL OR t.created_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )"#,
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let p2p_by_item = conn
        .query(
            r#"SELECT t.item_id,
                      COALESCE(MAX(up.name), t.item_id) AS item_name,
                      COALESCE(SUM(t.qty), 0)::bigint AS qty,
                      COUNT(*)::bigint AS trades,
                      COUNT(DISTINCT t.buyer_id)::bigint AS buyers,
                      COALESCE(SUM(t.buyer_paid_usdc), 0)::float8 AS usdc,
                      MIN(t.created_at) AS first_at,
                      MAX(t.created_at) AS last_at
                 FROM p2p_market_trade_history t
                 JOIN users u ON u.id = t.buyer_id
                 LEFT JOIN upgrades up ON up.id = t.item_id
                WHERE ($1 = '' OR t.item_id = $1)
                  AND ($2::int IS NULL OR t.buyer_id = $2)
                  AND ($4::bigint IS NULL OR t.created_at >= $4)
                  AND ($5::bigint IS NULL OR t.created_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )
                GROUP BY t.item_id
                ORDER BY qty DESC, t.item_id ASC"#,
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let p2p_buyers = conn
        .query(
            r#"SELECT t.buyer_id AS user_id,
                      COALESCE(u.username, '') AS username,
                      COALESCE(u.email, '') AS email,
                      COALESCE(SUM(t.buyer_paid_usdc), 0)::float8 AS total_usdc,
                      COUNT(*)::bigint AS trades,
                      COALESCE(SUM(t.qty), 0)::bigint AS item_qty
                 FROM p2p_market_trade_history t
                 JOIN users u ON u.id = t.buyer_id
                WHERE ($1 = '' OR t.item_id = $1)
                  AND ($2::int IS NULL OR t.buyer_id = $2)
                  AND ($4::bigint IS NULL OR t.created_at >= $4)
                  AND ($5::bigint IS NULL OR t.created_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )
                GROUP BY t.buyer_id, u.username, u.email
                ORDER BY total_usdc DESC, trades DESC
                LIMIT $6"#,
            &[item, &uid, search, &from_ms, &to_ms, &TOP_BUYERS_LIMIT],
        )
        .await?;

    let p2p_sales_totals = conn
        .query_one(
            r#"SELECT COALESCE(SUM(t.seller_received_usdc), 0)::float8 AS total_received_usdc,
                      COALESCE(SUM(t.tax_usdc), 0)::float8 AS total_tax_usdc,
                      COUNT(*)::bigint AS trade_count,
                      COALESCE(SUM(t.qty), 0)::bigint AS item_qty
                 FROM p2p_market_trade_history t
                 JOIN users u ON u.id = t.seller_id
                WHERE ($1 = '' OR t.item_id = $1)
                  AND ($2::int IS NULL OR t.seller_id = $2)
                  AND ($4::bigint IS NULL OR t.created_at >= $4)
                  AND ($5::bigint IS NULL OR t.created_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )"#,
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let p2p_trade_rows = conn
        .query(
            r#"SELECT t.id,
                      t.created_at,
                      t.buyer_id,
                      COALESCE(ub.username, '') AS buyer_username,
                      COALESCE(ub.email, '') AS buyer_email,
                      t.seller_id,
                      COALESCE(us.username, '') AS seller_username,
                      COALESCE(us.email, '') AS seller_email,
                      t.item_id,
                      COALESCE(up.name, t.item_id) AS item_name,
                      t.qty,
                      t.unit_price::float8,
                      t.buyer_paid_usdc::float8,
                      t.seller_received_usdc::float8,
                      t.tax_usdc::float8
                 FROM p2p_market_trade_history t
                 JOIN users ub ON ub.id = t.buyer_id
                 JOIN users us ON us.id = t.seller_id
                 LEFT JOIN upgrades up ON up.id = t.item_id
                WHERE ($1 = '' OR t.item_id = $1)
                  AND ($2::int IS NULL OR t.buyer_id = $2 OR t.seller_id = $2)
                  AND ($4::bigint IS NULL OR t.created_at >= $4)
                  AND ($5::bigint IS NULL OR t.created_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(ub.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(ub.email, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(us.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(us.email, '')), lower($3)) > 0
                  )
                ORDER BY t.created_at DESC
                LIMIT $6"#,
            &[item, &uid, search, &from_ms, &to_ms, &SHOP_CHECKOUT_HISTORY_LIMIT],
        )
        .await?;

    let season_totals = conn
        .query_one(
            r#"SELECT COALESCE(SUM(p.price_usdc), 0)::float8 AS total_usdc,
                      COUNT(*)::bigint AS pass_count,
                      COUNT(DISTINCT sp.user_id)::bigint AS buyers
                 FROM season_purchases sp
                 LEFT JOIN season_passes p ON p.id = sp.pass_id
                 JOIN users u ON u.id = sp.user_id
                WHERE ($1 = '' OR sp.pass_id = $1)
                  AND ($2::int IS NULL OR sp.user_id = $2)
                  AND ($4::bigint IS NULL OR sp.purchased_at >= $4)
                  AND ($5::bigint IS NULL OR sp.purchased_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )"#,
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let season_by_item = conn
        .query(
            r#"SELECT sp.pass_id AS item_id,
                      COALESCE(MAX(p.name), sp.pass_id) AS item_name,
                      COUNT(*)::bigint AS qty,
                      COUNT(*)::bigint AS events,
                      COUNT(DISTINCT sp.user_id)::bigint AS buyers,
                      COALESCE(SUM(p.price_usdc), 0)::float8 AS usdc,
                      MIN(sp.purchased_at) AS first_at,
                      MAX(sp.purchased_at) AS last_at
                 FROM season_purchases sp
                 LEFT JOIN season_passes p ON p.id = sp.pass_id
                 JOIN users u ON u.id = sp.user_id
                WHERE ($1 = '' OR sp.pass_id = $1)
                  AND ($2::int IS NULL OR sp.user_id = $2)
                  AND ($4::bigint IS NULL OR sp.purchased_at >= $4)
                  AND ($5::bigint IS NULL OR sp.purchased_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )
                GROUP BY sp.pass_id
                ORDER BY qty DESC, sp.pass_id ASC"#,
            &[item, &uid, search, &from_ms, &to_ms],
        )
        .await?;

    let season_rows = conn
        .query(
            r#"SELECT sp.pass_id,
                      sp.season_id,
                      sp.purchased_at,
                      sp.user_id,
                      COALESCE(p.name, sp.pass_id) AS pass_name,
                      COALESCE(p.price_usdc, 0)::float8 AS price_usdc,
                      COALESCE(u.username, '') AS username,
                      COALESCE(u.email, '') AS email
                 FROM season_purchases sp
                 LEFT JOIN season_passes p ON p.id = sp.pass_id
                 JOIN users u ON u.id = sp.user_id
                WHERE ($1 = '' OR sp.pass_id = $1)
                  AND ($2::int IS NULL OR sp.user_id = $2)
                  AND ($4::bigint IS NULL OR sp.purchased_at >= $4)
                  AND ($5::bigint IS NULL OR sp.purchased_at <= $5)
                  AND (
                    $3 = ''
                    OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                    OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                  )
                ORDER BY sp.purchased_at DESC
                LIMIT $6"#,
            &[item, &uid, search, &from_ms, &to_ms, &SHOP_CHECKOUT_HISTORY_LIMIT],
        )
        .await?;

    let shop_rows = conn
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
                            SELECT 1 FROM jsonb_array_elements({LINES_JSONB}) el WHERE el->>'id' = $1
                          ))
                      AND ($2::int IS NULL OR c.user_id = $2)
                      AND ($4::bigint IS NULL OR c.created_at >= $4)
                      AND ($5::bigint IS NULL OR c.created_at <= $5)
                      AND (
                        $3 = ''
                        OR strpos(lower(COALESCE(u.username, '')), lower($3)) > 0
                        OR strpos(lower(COALESCE(u.email, '')), lower($3)) > 0
                      )
                    ORDER BY c.created_at DESC
                    LIMIT $6"#,
                LINES_JSONB = LINES_JSONB,
            ),
            &[item, &uid, search, &from_ms, &to_ms, &SHOP_CHECKOUT_HISTORY_LIMIT],
        )
        .await?;

    let shop_checkout_count: i64 = shop_totals.try_get("checkout_count").unwrap_or(0);
    let shop_total_cost: f64 = shop_totals.try_get("total_cost").unwrap_or(0.0);
    let shop_item_qty: i64 = shop_totals.try_get("item_qty").unwrap_or(0);
    let shop_buyers_n: i64 = shop_totals.try_get("buyers").unwrap_or(0);

    let season_total_usdc: f64 = season_totals.try_get("total_usdc").unwrap_or(0.0);
    let season_pass_count: i64 = season_totals.try_get("pass_count").unwrap_or(0);
    let season_buyers_n: i64 = season_totals.try_get("buyers").unwrap_or(0);

    let p2p_total_usdc: f64 = p2p_totals.try_get("total_usdc").unwrap_or(0.0);
    let p2p_trade_count: i64 = p2p_totals.try_get("trade_count").unwrap_or(0);
    let p2p_item_qty: i64 = p2p_totals.try_get("item_qty").unwrap_or(0);
    let p2p_buyers_n: i64 = p2p_totals.try_get("buyers").unwrap_or(0);

    let p2p_sales_total_usdc: f64 = p2p_sales_totals.try_get("total_received_usdc").unwrap_or(0.0);
    let p2p_sales_total_tax: f64 = p2p_sales_totals.try_get("total_tax_usdc").unwrap_or(0.0);
    let p2p_sales_trade_count: i64 = p2p_sales_totals.try_get("trade_count").unwrap_or(0);
    let p2p_sales_item_qty: i64 = p2p_sales_totals.try_get("item_qty").unwrap_or(0);

    let by_item_shop: Vec<Value> = shop_by_item
        .iter()
        .filter_map(|r| {
            let id: String = r.try_get("item_id").unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "name": r.try_get::<_, String>("item_name").unwrap_or_default(),
                "source": "shop",
                "sourceLabel": "Loja Oficial",
                "qty": r.try_get::<_, i64>("qty").unwrap_or(0),
                "events": r.try_get::<_, i64>("checkouts").unwrap_or(0),
                "buyers": r.try_get::<_, i64>("buyers").unwrap_or(0),
                "usdc": r.try_get::<_, f64>("usdc").unwrap_or(0.0),
                "firstAt": r.try_get::<_, i64>("first_at").unwrap_or(0),
                "lastAt": r.try_get::<_, i64>("last_at").unwrap_or(0),
            }))
        })
        .collect();

    let by_item_season: Vec<Value> = season_by_item
        .iter()
        .filter_map(|r| {
            let id: String = r.try_get("item_id").unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "name": r.try_get::<_, String>("item_name").unwrap_or_default(),
                "source": "season",
                "sourceLabel": "Passe de Temporada",
                "qty": r.try_get::<_, i64>("qty").unwrap_or(0),
                "events": r.try_get::<_, i64>("events").unwrap_or(0),
                "buyers": r.try_get::<_, i64>("buyers").unwrap_or(0),
                "usdc": r.try_get::<_, f64>("usdc").unwrap_or(0.0),
                "firstAt": r.try_get::<_, i64>("first_at").unwrap_or(0),
                "lastAt": r.try_get::<_, i64>("last_at").unwrap_or(0),
            }))
        })
        .collect();

    let by_item_p2p: Vec<Value> = p2p_by_item
        .iter()
        .filter_map(|r| {
            let id: String = r.try_get("item_id").unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "name": r.try_get::<_, String>("item_name").unwrap_or_default(),
                "source": "p2p",
                "sourceLabel": "Mercado P2P",
                "qty": r.try_get::<_, i64>("qty").unwrap_or(0),
                "events": r.try_get::<_, i64>("trades").unwrap_or(0),
                "buyers": r.try_get::<_, i64>("buyers").unwrap_or(0),
                "usdc": r.try_get::<_, f64>("usdc").unwrap_or(0.0),
                "firstAt": r.try_get::<_, i64>("first_at").unwrap_or(0),
                "lastAt": r.try_get::<_, i64>("last_at").unwrap_or(0),
            }))
        })
        .collect();

    let mut by_item = by_item_shop;
    by_item.extend(by_item_season);
    by_item.extend(by_item_p2p);
    by_item.sort_by(|a, b| {
        let ua = a.get("usdc").and_then(Value::as_f64).unwrap_or(0.0);
        let ub = b.get("usdc").and_then(Value::as_f64).unwrap_or(0.0);
        ub.partial_cmp(&ua).unwrap_or(std::cmp::Ordering::Equal)
    });

    let recent_shop: Vec<Value> = shop_rows
        .iter()
        .map(|r| {
            let lines_raw: String = r.try_get("lines_json").unwrap_or_default();
            json!({
                "id": r.try_get::<_, String>("idempotency_key").unwrap_or_default(),
                "userId": r.try_get::<_, i32>("user_id").unwrap_or(0),
                "username": r.try_get::<_, String>("username").unwrap_or_default(),
                "email": r.try_get::<_, String>("email").unwrap_or_default(),
                "totalCost": r.try_get::<_, f64>("total_cost").unwrap_or(0.0),
                "newUsdc": r.try_get::<_, f64>("new_usdc").unwrap_or(0.0),
                "createdAt": r.try_get::<_, i64>("created_at").unwrap_or(0),
                "lines": parse_shop_lines(&lines_raw),
                "source": "shop",
                "sourceLabel": "Loja Oficial",
            })
        })
        .collect();

    let recent_season: Vec<Value> = season_rows
        .iter()
        .map(|r| {
            let row_uid: i32 = r.try_get("user_id").unwrap_or(0);
            let pass_id: String = r.try_get("pass_id").unwrap_or_default();
            let purchased_at: i64 = r.try_get("purchased_at").unwrap_or(0);
            json!({
                "id": format!("season:{}:{}:{}", row_uid, pass_id, purchased_at),
                "passId": pass_id,
                "passName": r.try_get::<_, String>("pass_name").unwrap_or_default(),
                "seasonId": r.try_get::<_, String>("season_id").unwrap_or_default(),
                "priceUsdc": r.try_get::<_, f64>("price_usdc").unwrap_or(0.0),
                "purchasedAt": purchased_at,
                "userId": row_uid,
                "username": r.try_get::<_, String>("username").unwrap_or_default(),
                "email": r.try_get::<_, String>("email").unwrap_or_default(),
                "source": "season",
                "sourceLabel": "Passe de Temporada",
            })
        })
        .collect();

    let recent_p2p: Vec<Value> = p2p_trade_rows
        .iter()
        .map(|r| {
            let trade_id: i64 = r.try_get("id").unwrap_or(0);
            let buyer_id: i32 = r.try_get("buyer_id").unwrap_or(0);
            let seller_id: i32 = r.try_get("seller_id").unwrap_or(0);
            let role = match uid {
                Some(u) if u == buyer_id => "buyer",
                Some(u) if u == seller_id => "seller",
                _ => "participant",
            };
            json!({
                "id": trade_id.to_string(),
                "createdAt": r.try_get::<_, i64>("created_at").unwrap_or(0),
                "buyerId": buyer_id,
                "buyerUsername": r.try_get::<_, String>("buyer_username").unwrap_or_default(),
                "buyerEmail": r.try_get::<_, String>("buyer_email").unwrap_or_default(),
                "sellerId": seller_id,
                "sellerUsername": r.try_get::<_, String>("seller_username").unwrap_or_default(),
                "sellerEmail": r.try_get::<_, String>("seller_email").unwrap_or_default(),
                "itemId": r.try_get::<_, String>("item_id").unwrap_or_default(),
                "itemName": r.try_get::<_, String>("item_name").unwrap_or_default(),
                "qty": r.try_get::<_, i32>("qty").unwrap_or(0),
                "unitPrice": r.try_get::<_, f64>("unit_price").unwrap_or(0.0),
                "buyerPaidUsdc": r.try_get::<_, f64>("buyer_paid_usdc").unwrap_or(0.0),
                "sellerReceivedUsdc": r.try_get::<_, f64>("seller_received_usdc").unwrap_or(0.0),
                "taxUsdc": r.try_get::<_, f64>("tax_usdc").unwrap_or(0.0),
                "role": role,
                "source": "p2p",
                "sourceLabel": if role == "seller" { "Venda P2P" } else { "Compra P2P" },
            })
        })
        .collect();

    let top_shop_buyers: Vec<Value> = shop_buyers
        .iter()
        .map(|r| {
            json!({
                "userId": r.try_get::<_, i32>("user_id").unwrap_or(0),
                "username": r.try_get::<_, String>("username").unwrap_or_default(),
                "email": r.try_get::<_, String>("email").unwrap_or_default(),
                "usdc": r.try_get::<_, f64>("total_cost").unwrap_or(0.0),
                "events": r.try_get::<_, i64>("checkouts").unwrap_or(0),
                "itemQty": r.try_get::<_, i64>("item_qty").unwrap_or(0),
                "source": "shop",
                "sourceLabel": "Loja Oficial",
            })
        })
        .collect();

    let top_p2p_buyers: Vec<Value> = p2p_buyers
        .iter()
        .map(|r| {
            json!({
                "userId": r.try_get::<_, i32>("user_id").unwrap_or(0),
                "username": r.try_get::<_, String>("username").unwrap_or_default(),
                "email": r.try_get::<_, String>("email").unwrap_or_default(),
                "usdc": r.try_get::<_, f64>("total_usdc").unwrap_or(0.0),
                "events": r.try_get::<_, i64>("trades").unwrap_or(0),
                "itemQty": r.try_get::<_, i64>("item_qty").unwrap_or(0),
                "source": "p2p",
                "sourceLabel": "Mercado P2P",
            })
        })
        .collect();

    Ok(json!({
        "sources": [
            {
                "id": "shop",
                "label": "Loja Oficial",
                "hint": "Débito do saldo USDC do jogo.",
                "usdc": shop_total_cost,
                "itemQty": shop_item_qty,
                "events": shop_checkout_count,
                "buyers": shop_buyers_n,
            },
            {
                "id": "season",
                "label": "Passes de Temporada",
                "hint": "Passes de época adquiridos pelo jogador.",
                "usdc": season_total_usdc,
                "itemQty": season_pass_count,
                "events": season_pass_count,
                "buyers": season_buyers_n,
            },
            {
                "id": "p2p",
                "label": "Mercado P2P (Compras)",
                "hint": "Compras de itens a outros jogadores.",
                "usdc": p2p_total_usdc,
                "itemQty": p2p_item_qty,
                "events": p2p_trade_count,
                "buyers": p2p_buyers_n,
            },
            {
                "id": "p2p_sell",
                "label": "Mercado P2P (Vendas)",
                "hint": "Vendas de itens para outros jogadores.",
                "usdc": p2p_sales_total_usdc,
                "itemQty": p2p_sales_item_qty,
                "events": p2p_sales_trade_count,
                "buyers": 0,
            }
        ],
        "byItem": by_item,
        "topBuyers": {
            "shop": top_shop_buyers,
            "p2p": top_p2p_buyers,
        },
        "recentShop": recent_shop,
        "recentSeason": recent_season,
        "recentP2p": recent_p2p,
        "seasonTotals": {
            "totalUsdc": season_total_usdc,
            "passCount": season_pass_count,
            "buyers": season_buyers_n,
        },
        "p2pSalesTotals": {
            "totalReceivedUsdc": p2p_sales_total_usdc,
            "totalTaxUsdc": p2p_sales_total_tax,
            "tradeCount": p2p_sales_trade_count,
            "itemQty": p2p_sales_item_qty,
        },
        "shopTruncated": shop_checkout_count > SHOP_CHECKOUT_HISTORY_LIMIT,
        "limit": SHOP_CHECKOUT_HISTORY_LIMIT,
        "filter": {
            "itemId": filter.item_id,
            "userId": filter.user_id,
            "q": filter.search,
            "fromMs": from_ms,
            "toMs": to_ms,
        }
    }))
}

fn parse_shop_lines(raw: &str) -> Vec<Value> {
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
    fn empty_time_is_open_range() {
        assert_eq!(parse_optional_ms("").unwrap(), None);
        assert_eq!(parse_optional_ms("  ").unwrap(), None);
        assert_eq!(parse_optional_ms("1700000000000").unwrap(), Some(1_700_000_000_000));
        assert!(parse_optional_ms("0").is_err());
        assert!(parse_optional_ms("01").is_err());
    }

    #[test]
    fn rejects_non_digit_time() {
        assert!(parse_optional_ms("abc").is_err());
    }

    #[test]
    fn filter_reuses_shop_parser() {
        use crate::admin_shop_checkouts::ShopCheckoutFilter;
        let f = parse_shop_checkout_filter("nft_a", "17", "Zezin").expect("ok");
        assert_eq!(
            f,
            ShopCheckoutFilter {
                item_id: "nft_a".into(),
                user_id: Some(17),
                search: "Zezin".into(),
            }
        );
    }
}
