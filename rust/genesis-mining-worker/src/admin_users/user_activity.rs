//! Admin user activity feed — Node `GET /api/admin/user-activity`
//! (`user-audit.controller` + `listAdminUserP2pActivityRowsFromPostgres` +
//! P2P half of `formatActivityEvent`). Mongo feed is discontinued.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::time::MS_PER_DAY;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::player_reads::{now_ms, pg_user_id, PlayerReadError};

use super::{CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_NOT_FOUND};

pub const ADMIN_USER_ACTIVITY_PATH: &str = "/v1/admin/user-activity";

/// Node `ACTIVITY_LIMIT_*` / fetch caps in user-audit.controller.ts.
pub const ACTIVITY_LIMIT_DEFAULT: i64 = 80;
pub const ACTIVITY_LIMIT_MAX: i64 = 100;
pub const ACTIVITY_LIMIT_MIN: i64 = 1;
const P2P_ROWS_FETCH_CAP: i64 = 250;
const P2P_ROWS_FETCH_MULTIPLIER: i64 = 3;
const P2P_ACTIVITY_ROWS_FETCH_CAP: i64 = 250;
const P2P_ACTIVITY_ROWS_LIMIT_DEFAULT: i64 = 200;
/// Node `LEGACY_P2P_LISTING_TTL_DAYS` × `MS_PER_DAY`.
const LEGACY_P2P_LISTING_TTL_DAYS: u64 = 7;
const LEGACY_P2P_LISTING_TTL_MS: i64 = (LEGACY_P2P_LISTING_TTL_DAYS * MS_PER_DAY) as i64;
/// Node / genesis-hardware `P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS` (MAX_SAFE_INTEGER).
const P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS: i64 = 9_007_199_254_740_991;
const LISTING_ID_SHORT_LEN: usize = 8;
const SUMMARY_KEY_PREVIEW_MAX_LEN: usize = 80;
const SUMMARY_KEY_PREVIEW_COUNT: usize = 4;

const ACTIVITY_LOG_NOTE: &str =
    "Por defeito: loja + mercado P2P. Inventário (equipar/rack) só no filtro Inventário. Movimentos com quantidade 0 são ignorados.";

const ERR_RESOLVE: &str = "Indique email, username ou userId válido";
const ERR_USER_NOT_FOUND: &str = "Utilizador não encontrado (email ou username).";

const _: () = assert!(ACTIVITY_LIMIT_DEFAULT == 80);
const _: () = assert!(ACTIVITY_LIMIT_MAX == 100);
const _: () = assert!(ACTIVITY_LIMIT_MIN == 1);
const _: () = assert!(P2P_ROWS_FETCH_CAP == 250);
const _: () = assert!(P2P_ROWS_FETCH_MULTIPLIER == 3);
const _: () = assert!(P2P_ACTIVITY_ROWS_LIMIT_DEFAULT == 200);
const _: () = assert!(LEGACY_P2P_LISTING_TTL_DAYS == 7);
const _: () = assert!(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS == 9_007_199_254_740_991);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserActivityRequest {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub user_id: Option<Value>,
    #[serde(default)]
    pub limit: Option<Value>,
    #[serde(default)]
    pub before_ms: Option<Value>,
    #[serde(default)]
    pub cursor: Option<Value>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub filter_id: Option<String>,
}

pub async fn run_user_activity(
    pool: &Pool,
    req: &UserActivityRequest,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = resolve_user_id(&conn, req).await?;

    let limit = clamp_i64(
        parse_i64_loose(req.limit.as_ref()).unwrap_or(ACTIVITY_LIMIT_DEFAULT),
        ACTIVITY_LIMIT_MIN,
        ACTIVITY_LIMIT_MAX,
    );
    let before_raw = parse_i64_loose(req.before_ms.as_ref())
        .or_else(|| parse_i64_loose(req.cursor.as_ref()));
    let before_ms = before_raw.filter(|n| *n > 0);

    let category_filter = req
        .category
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let severity_filter = req
        .severity
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let filter_id = req
        .filter_id
        .as_deref()
        .unwrap_or("all")
        .trim()
        .to_string();
    let filter_id = if filter_id.is_empty() {
        "all".to_string()
    } else {
        filter_id
    };

    let account_created_at_ms = load_account_created_at_ms(&conn, uid).await?;

    let fetch_limit = (limit * P2P_ROWS_FETCH_MULTIPLIER).min(P2P_ROWS_FETCH_CAP);
    let want_shop = activity_filter_wants_shop(&filter_id);
    let want_season = activity_filter_wants_season(&filter_id);
    let want_p2p = activity_filter_wants_p2p(&filter_id);
    let want_upgrades = activity_filter_wants_upgrades(&filter_id);
    let want_boxes = activity_filter_wants_boxes(&filter_id);
    let want_wheel = activity_filter_wants_wheel(&filter_id);
    let want_room_slots = activity_filter_wants_room_slots(&filter_id);
    let want_merge = activity_filter_wants_merge(&filter_id);
    let want_inventory = activity_filter_wants_inventory(&filter_id);

    let mut pg_rows = Vec::new();
    if want_p2p {
        pg_rows.extend(list_p2p_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_shop {
        pg_rows.extend(list_shop_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_season {
        pg_rows.extend(list_season_pass_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_upgrades {
        pg_rows.extend(list_upgrade_package_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_boxes {
        pg_rows.extend(list_lucky_box_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_wheel {
        pg_rows.extend(list_wheel_spin_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_room_slots {
        pg_rows.extend(list_room_slot_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_merge {
        pg_rows.extend(list_merge_activity_rows(&conn, uid, before_ms, fetch_limit).await?);
    }
    if want_inventory {
        // Keep inventory from drowning money events: smaller fetch when "all".
        let inv_limit = if filter_id == "all" {
            (fetch_limit / 2).max(limit)
        } else {
            fetch_limit
        };
        pg_rows.extend(list_inventory_activity_rows(&conn, uid, before_ms, inv_limit).await?);
    }
    let (merged, has_more) = merge_activity_logs(&[], &pg_rows, before_ms, limit);

    let mut enriched: Vec<Value> = merged
        .into_iter()
        .map(|row| {
            let action = row
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let meta = row.get("meta").cloned().unwrap_or(json!({}));
            let display = format_activity_event(&action, &meta);
            let mut out = match row {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            out.insert("display".into(), display);
            Value::Object(out)
        })
        .collect();

    if filter_id != "all" {
        enriched.retain(|r| {
            let display = r.get("display").cloned().unwrap_or(json!({}));
            let action = r.get("action").and_then(Value::as_str).unwrap_or("");
            matches_activity_filter(&display, action, &filter_id)
        });
    }
    if !category_filter.is_empty() {
        enriched.retain(|r| {
            r.get("display")
                .and_then(|d| d.get("category"))
                .and_then(Value::as_str)
                == Some(category_filter.as_str())
        });
    }
    if !severity_filter.is_empty() {
        enriched.retain(|r| {
            r.get("display")
                .and_then(|d| d.get("severity"))
                .and_then(Value::as_str)
                == Some(severity_filter.as_str())
        });
    }

    let search_q = req
        .search
        .as_deref()
        .or(req.q.as_deref())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    // Controller uses `q` for both resolve and search when email-style resolve
    // already succeeded — only apply text search when `search` is set, or when
    // resolve used userId (q was not an identity lookup). Mirror Node: it always
    // filters on `q || search` after resolve. When resolve used email/q, the
    // same q also filters titles — keep that behaviour.
    if !search_q.is_empty() {
        enriched.retain(|r| {
            let action = r.get("action").and_then(Value::as_str).unwrap_or("");
            let title = r
                .get("display")
                .and_then(|d| d.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let summary = r
                .get("display")
                .and_then(|d| d.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let hay = format!("{action} {title} {summary}").to_lowercase();
            hay.contains(&search_q)
        });
    }

    let next_cursor = enriched
        .last()
        .and_then(|r| r.get("createdAt"))
        .and_then(Value::as_i64);

    Ok(json!({
        "logs": enriched,
        "hasMore": has_more,
        "nextCursor": next_cursor,
        "accountCreatedAtMs": account_created_at_ms,
        "activityLogNote": ACTIVITY_LOG_NOTE,
    }))
}

async fn resolve_user_id<C: GenericClient>(
    client: &C,
    req: &UserActivityRequest,
) -> Result<i32, PlayerReadError> {
    let raw_q = req
        .email
        .as_deref()
        .or(req.q.as_deref())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !raw_q.is_empty() {
        let row = client
            .query_opt(
                "SELECT id FROM users
                 WHERE lower(trim(email::text)) = $1 OR lower(trim(username::text)) = $1
                 LIMIT 1",
                &[&raw_q],
            )
            .await?;
        return match row {
            Some(r) => Ok(r.get::<_, i32>("id")),
            None => Err(PlayerReadError::controlled(
                HTTP_NOT_FOUND,
                ERR_USER_NOT_FOUND,
                "NOT_FOUND",
            )),
        };
    }

    let uid_parsed = parse_i64_loose(req.user_id.as_ref()).filter(|n| *n > 0);
    if let Some(uid) = uid_parsed {
        return pg_user_id(uid);
    }

    Err(PlayerReadError::controlled(
        HTTP_BAD_REQUEST,
        ERR_RESOLVE,
        CODE_VALIDATION,
    ))
}

async fn load_account_created_at_ms<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<Option<i64>, PlayerReadError> {
    let row = client
        .query_opt(
            "SELECT start_time FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(r) = row else {
        return Ok(None);
    };
    let n = i64_cell(&r, "start_time");
    if n > 0 {
        Ok(Some(n))
    } else {
        Ok(None)
    }
}

async fn list_p2p_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);

    let sold = client
        .query(
            "SELECT id, created_at, buyer_id, seller_id, item_id, qty, unit_price, buyer_paid_usdc
             FROM p2p_market_trade_history
             WHERE seller_id = $1
             ORDER BY created_at DESC
             LIMIT $2",
            &[&uid, &(cap as i64)],
        )
        .await?;
    let bought = client
        .query(
            "SELECT id, created_at, buyer_id, seller_id, item_id, qty, unit_price, buyer_paid_usdc
             FROM p2p_market_trade_history
             WHERE buyer_id = $1
             ORDER BY created_at DESC
             LIMIT $2",
            &[&uid, &(cap as i64)],
        )
        .await?;
    let listings = client
        .query(
            "SELECT id, user_id, item_id, qty, price, status, reserved_by, expires_at
             FROM player_listings
             WHERE user_id = $1
             ORDER BY expires_at DESC
             LIMIT $2",
            &[&uid, &(cap as i64)],
        )
        .await?;
    let reserved = client
        .query(
            "SELECT id, user_id, item_id, qty, price, status, reserved_by, expires_at
             FROM player_listings
             WHERE reserved_by = $1
             ORDER BY expires_at DESC
             LIMIT $2",
            &[&uid, &(cap as i64)],
        )
        .await?;

    let mut item_ids = HashSet::new();
    for row in sold.iter().chain(bought.iter()) {
        item_ids.insert(row.get::<_, String>("item_id"));
    }
    for row in listings.iter().chain(reserved.iter()) {
        item_ids.insert(row.get::<_, String>("item_id"));
    }
    let names = load_upgrade_names(client, &item_ids).await?;

    let mut rows = Vec::new();
    for t in &sold {
        push_trade(&mut rows, t, "seller", before_ms, &names);
    }
    for t in &bought {
        push_trade(&mut rows, t, "buyer", before_ms, &names);
    }

    let mut listing_seen = HashSet::new();
    for l in &listings {
        let status = opt_string(l, "status").unwrap_or_else(|| "active".into());
        if !matches!(
            status.as_str(),
            "active" | "awaiting_pickup" | "reserved"
        ) {
            continue;
        }
        push_listing(
            &mut rows,
            l,
            "seller",
            uid,
            before_ms,
            &names,
            &mut listing_seen,
        );
    }
    for l in &reserved {
        let status = opt_string(l, "status").unwrap_or_else(|| "active".into());
        if !matches!(status.as_str(), "active" | "reserved") {
            continue;
        }
        push_listing(
            &mut rows,
            l,
            "buyer",
            uid,
            before_ms,
            &names,
            &mut listing_seen,
        );
    }

    rows.sort_by(|a, b| {
        let aa = a.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let bb = b.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        bb.cmp(&aa)
    });
    rows.truncate(cap as usize);
    Ok(rows)
}

fn push_trade(
    rows: &mut Vec<Value>,
    t: &tokio_postgres::Row,
    role: &str,
    before_ms: Option<i64>,
    names: &HashMap<String, String>,
) {
    let at_ms = i64_cell(t, "created_at");
    if at_ms <= 0 {
        return;
    }
    if let Some(b) = before_ms {
        if at_ms >= b {
            return;
        }
    }
    let trade_id = match t.try_get::<_, i64>("id") {
        Ok(v) => v.to_string(),
        Err(_) => match t.try_get::<_, i32>("id") {
            Ok(v) => v.to_string(),
            Err(_) => return,
        },
    };
    let item_id: String = t.get("item_id");
    let item_name = names.get(&item_id).cloned().unwrap_or_else(|| item_id.clone());
    let qty = i64_cell(t, "qty").max(1);
    let unit_price = f64_cell(t, "unit_price");
    let total_usdc = f64_cell(t, "buyer_paid_usdc");
    let buyer_id: i32 = t.get("buyer_id");
    let seller_id: i32 = t.get("seller_id");
    let counterparty = if role == "seller" {
        buyer_id
    } else {
        seller_id
    };
    let action = if role == "seller" {
        "p2p_trade_sell"
    } else {
        "p2p_trade_buy"
    };
    rows.push(json!({
        "id": format!("pg:p2p:{role}:{trade_id}"),
        "action": action,
        "createdAt": at_ms,
        "meta": {
            "source": "postgres",
            "itemId": item_id,
            "itemName": item_name,
            "qty": qty,
            "unitPrice": unit_price,
            "totalUsdc": total_usdc,
            "buyerPaidUsdc": total_usdc,
            "counterpartyUserId": counterparty,
            "buyerId": buyer_id,
            "sellerId": seller_id,
            "tradeId": trade_id
        }
    }));
}

fn push_listing(
    rows: &mut Vec<Value>,
    l: &tokio_postgres::Row,
    role: &str,
    uid: i32,
    before_ms: Option<i64>,
    names: &HashMap<String, String>,
    seen: &mut HashSet<String>,
) {
    let listing_id: String = match l.try_get::<_, String>("id") {
        Ok(v) => v,
        Err(_) => return,
    };
    let dedupe = format!("{role}:{listing_id}");
    if !seen.insert(dedupe) {
        return;
    }
    let expires_at_ms = i64_cell(l, "expires_at");
    let estimated_at_ms = if expires_at_ms > 0 {
        if is_p2p_listing_no_expiry(expires_at_ms) {
            now_ms()
        } else {
            (expires_at_ms - LEGACY_P2P_LISTING_TTL_MS).max(0)
        }
    } else {
        now_ms()
    };
    if let Some(b) = before_ms {
        if estimated_at_ms >= b {
            return;
        }
    }
    let item_id: String = l.get("item_id");
    let item_name = names.get(&item_id).cloned().unwrap_or_else(|| item_id.clone());
    let status = opt_string(l, "status").unwrap_or_else(|| "active".into());
    let reserved_by: Option<i32> = l.try_get("reserved_by").ok().flatten();
    let action = if role == "buyer" && reserved_by == Some(uid) {
        "p2p_listing_reserve"
    } else {
        "p2p_listing_open"
    };
    let seller_id: i32 = l.get("user_id");
    let qty = i64_cell(l, "qty").max(1);
    let price = f64_cell(l, "price");
    rows.push(json!({
        "id": format!("pg:listing:{role}:{listing_id}"),
        "action": action,
        "createdAt": estimated_at_ms,
        "meta": {
            "source": "postgres",
            "listingId": listing_id,
            "itemId": item_id,
            "itemName": item_name,
            "qty": qty,
            "price": price,
            "status": status,
            "sellerId": seller_id,
            "reservedBy": reserved_by,
            "expiresAtMs": if expires_at_ms > 0 { Value::from(expires_at_ms) } else { Value::Null }
        }
    }));
}

async fn load_upgrade_names<C: GenericClient>(
    client: &C,
    ids: &HashSet<String>,
) -> Result<HashMap<String, String>, PlayerReadError> {
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let list: Vec<String> = ids.iter().cloned().collect();
    let rows = client
        .query(
            "SELECT id, name FROM upgrades WHERE id = ANY($1::text[])",
            &[&list],
        )
        .await?;
    for r in rows {
        let id: String = r.get("id");
        let name: String = r.try_get("name").unwrap_or_else(|_| id.clone());
        map.insert(id, if name.is_empty() { r.get("id") } else { name });
    }
    Ok(map)
}

/// Node `mergeAdminUserActivityLogs` with empty mongo (P2P-only feed).
fn merge_activity_logs(
    _mongo: &[Value],
    postgres: &[Value],
    before_ms: Option<i64>,
    limit: i64,
) -> (Vec<Value>, bool) {
    let limit = limit.max(1) as usize;
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for r in postgres {
        let id = r
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        by_id.entry(id).or_insert_with(|| r.clone());
    }
    let mut sorted: Vec<Value> = by_id.into_values().collect();
    sorted.sort_by(|a, b| {
        let aa = a.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let bb = b.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        bb.cmp(&aa)
    });
    if let Some(b) = before_ms {
        sorted.retain(|r| r.get("createdAt").and_then(Value::as_i64).unwrap_or(0) < b);
    }
    let has_more = sorted.len() > limit;
    sorted.truncate(limit);
    (sorted, has_more)
}

fn is_p2p_listing_no_expiry(expires_at_ms: i64) -> bool {
    expires_at_ms >= P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS
}

async fn list_shop_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT idempotency_key, total_cost, new_usdc, lines_json, created_at
               FROM shop_checkout_idempotency
              WHERE user_id = $1
                AND ($2::bigint IS NULL OR created_at < $2)
              ORDER BY created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;
    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let key: String = row.get("idempotency_key");
        let lines_json: String = row.try_get("lines_json").unwrap_or_default();
        let (items_summary, item_lines) = shop_line_bits(&lines_json);
        let total = f64_cell(row, "total_cost");
        let new_usdc = f64_cell(row, "new_usdc");
        out.push(json!({
            "id": format!("pg:shop:{key}"),
            "action": "shop_checkout",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "itemsSummary": items_summary,
                "itemLines": item_lines,
                "totalUsdc": total,
                "newUsdc": new_usdc,
                "checkoutKey": key
            }
        }));
    }
    Ok(out)
}

async fn list_season_pass_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT sp.pass_id, sp.season_id, sp.purchased_at,
                    COALESCE(p.name, sp.pass_id) AS pass_name,
                    COALESCE(p.price_usdc, 0)::float8 AS price_usdc
               FROM season_purchases sp
               LEFT JOIN season_passes p ON p.id = sp.pass_id
              WHERE sp.user_id = $1
                AND ($2::bigint IS NULL OR sp.purchased_at < $2)
              ORDER BY sp.purchased_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;
    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "purchased_at");
        if at_ms <= 0 {
            continue;
        }
        let pass_id: String = row.get("pass_id");
        let season_id: String = row.get("season_id");
        let pass_name: String = row.get("pass_name");
        let price_usdc = f64_cell(row, "price_usdc");
        out.push(json!({
            "id": format!("pg:season:{pass_id}:{season_id}:{at_ms}"),
            "action": "season_pass_purchase",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "passId": pass_id,
                "passName": pass_name,
                "seasonId": season_id,
                "priceUsdc": price_usdc,
                "totalUsdc": price_usdc,
            }
        }));
    }
    Ok(out)
}

async fn list_inventory_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT id::text AS id, action, catalog_item_id, quantity_before, quantity_after, created_at
               FROM inventory_movements
              WHERE user_id = $1
                AND ($2::bigint IS NULL OR created_at < $2)
                AND NOT (
                  action IN ('miner_equip', 'miner_unequip', 'rack_place', 'rack_remove')
                  AND quantity_before IS NOT NULL
                  AND quantity_after IS NOT NULL
                  AND quantity_before = quantity_after
                )
              ORDER BY created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;
    let mut ids = HashSet::new();
    for row in &rows {
        if let Some(id) = opt_string(row, "catalog_item_id") {
            ids.insert(id);
        }
    }
    let names = load_upgrade_names(client, &ids).await?;
    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let id: String = row.get("id");
        let action: String = row.get("action");
        let item_id = opt_string(row, "catalog_item_id").unwrap_or_default();
        let item_name = if item_id.is_empty() {
            String::new()
        } else {
            names.get(&item_id).cloned().unwrap_or_else(|| item_id.clone())
        };
        let before = row.try_get::<_, Option<i32>>("quantity_before").ok().flatten();
        let after = row.try_get::<_, Option<i32>>("quantity_after").ok().flatten();
        out.push(json!({
            "id": format!("pg:inv:{id}"),
            "action": action,
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "itemId": item_id,
                "itemName": item_name,
                "quantityBefore": before,
                "quantityAfter": after
            }
        }));
    }
    Ok(out)
}

async fn list_upgrade_package_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT p.id::text AS purchase_id, p.upgrade_id, p.purchased_at,
                    COALESCE(u.name, p.upgrade_id) AS upgrade_name,
                    COALESCE(u.price_usdc, 0)::float8 AS price_usdc
               FROM admin_upgrade_purchases p
               LEFT JOIN admin_upgrades u ON u.id = p.upgrade_id
              WHERE p.user_id = $1
                AND ($2::bigint IS NULL OR p.purchased_at < $2)
              ORDER BY p.purchased_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;
    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "purchased_at");
        if at_ms <= 0 {
            continue;
        }
        let pid: String = row.get("purchase_id");
        let upgrade_id: String = row.get("upgrade_id");
        let upgrade_name: String = row.get("upgrade_name");
        let price = f64_cell(row, "price_usdc");
        out.push(json!({
            "id": format!("pg:upgrade:{pid}"),
            "action": "upgrade_package_buy",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "upgradeId": upgrade_id,
                "upgradeName": upgrade_name,
                "priceUsdc": price,
                "totalUsdc": price,
            }
        }));
    }
    Ok(out)
}

async fn list_lucky_box_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let mut out = Vec::new();

    let buy_rows = client
        .query(
            "SELECT i.idempotency_key, i.body_json, i.created_at,
                    COALESCE(b.name, '') AS box_name,
                    COALESCE(b.price, 0)::float8 AS box_price
               FROM lucky_box_idempotency i
               LEFT JOIN loot_boxes b ON b.id = (
                 CASE WHEN left(btrim(i.body_json), 1) = '{' THEN i.body_json::jsonb->>'boxId' ELSE '' END
               )
              WHERE i.user_id = $1
                AND i.scope = 'box_purchase'
                AND ($2::bigint IS NULL OR i.created_at < $2)
              ORDER BY i.created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;

    for row in &buy_rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let key: String = row.get("idempotency_key");
        let body_raw: String = row.try_get("body_json").unwrap_or_default();
        let box_name_db: String = row.try_get("box_name").unwrap_or_default();
        let box_price = f64_cell(row, "box_price");
        let v: Option<Value> = serde_json::from_str(&body_raw).ok();
        let box_id = v.as_ref()
            .and_then(|o| o.get("boxId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let qty = v.as_ref()
            .and_then(|o| o.get("qtyPurchased"))
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let new_usdc = v.as_ref()
            .and_then(|o| o.get("newUsdc"))
            .and_then(Value::as_f64);
        let name = if !box_name_db.is_empty() {
            box_name_db
        } else if !box_id.is_empty() {
            box_id.clone()
        } else {
            "Caixa da Sorte".into()
        };
        let total_usdc = box_price * (qty as f64);
        out.push(json!({
            "id": format!("pg:box_buy:{key}"),
            "action": "loot_box_buy",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "boxId": box_id,
                "boxName": name,
                "qty": qty,
                "price": box_price,
                "totalUsdc": total_usdc,
                "newUsdc": new_usdc,
                "idempotencyKey": key,
            }
        }));
    }

    let open_rows = client
        .query(
            "SELECT o.id::text AS id, o.box_id, o.rewards_json, o.gained_usdc::float8 AS gained_usdc,
                    o.created_at, COALESCE(b.name, o.box_id) AS box_name
               FROM lucky_box_openings o
               LEFT JOIN loot_boxes b ON b.id = o.box_id
              WHERE o.user_id = $1
                AND ($2::bigint IS NULL OR o.created_at < $2)
              ORDER BY o.created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;

    for row in &open_rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let oid: String = row.get("id");
        let box_id: String = row.get("box_id");
        let box_name: String = row.get("box_name");
        let gained_usdc = f64_cell(row, "gained_usdc");
        let rewards_raw: String = row.try_get("rewards_json").unwrap_or_default();
        out.push(json!({
            "id": format!("pg:box_open:{oid}"),
            "action": "loot_box_open",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "boxId": box_id,
                "boxName": box_name,
                "gainedUsdc": gained_usdc,
                "rewardsJson": rewards_raw,
            }
        }));
    }

    Ok(out)
}

async fn list_wheel_spin_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT s.id::text AS id, s.kind, s.won_item_id, s.charged_usdc::float8 AS charged_usdc,
                    s.created_at, COALESCE(u.name, s.won_item_id) AS won_item_name
               FROM wheel_spins s
               LEFT JOIN upgrades u ON u.id = s.won_item_id
              WHERE s.user_id = $1
                AND ($2::bigint IS NULL OR s.created_at < $2)
              ORDER BY s.created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;

    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let spin_id: String = row.get("id");
        let kind: String = row.get("kind");
        let won_item_id: String = row.get("won_item_id");
        let won_item_name: String = row.get("won_item_name");
        let charged = f64_cell(row, "charged_usdc");
        let is_paid = kind == "paid" || charged > 0.0;
        let action = if is_paid { "wheel_spin_paid" } else { "wheel_spin_free" };
        out.push(json!({
            "id": format!("pg:wheel:{spin_id}"),
            "action": action,
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "spinId": spin_id,
                "kind": kind,
                "wonItemId": won_item_id,
                "wonItemName": won_item_name,
                "chargedUsdc": charged,
                "totalUsdc": charged,
            }
        }));
    }
    Ok(out)
}

async fn list_room_slot_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT idempotency_key, room_id, slots_purchased,
                    total_price::float8 AS total_price,
                    new_usdc::float8 AS new_usdc,
                    created_at
               FROM room_slot_purchase_idempotency
              WHERE user_id = $1
                AND ($2::bigint IS NULL OR created_at < $2)
              ORDER BY created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;

    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let key: String = row.get("idempotency_key");
        let room_id: String = row.get("room_id");
        let slots = i64_cell(row, "slots_purchased");
        let total = f64_cell(row, "total_price");
        let new_usdc = f64_cell(row, "new_usdc");
        out.push(json!({
            "id": format!("pg:room_slot:{key}"),
            "action": "rig_room_slot_purchase",
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "roomId": room_id,
                "slotsPurchased": slots,
                "totalPrice": total,
                "totalUsdc": total,
                "newUsdc": new_usdc,
                "idempotencyKey": key,
            }
        }));
    }
    Ok(out)
}

async fn list_merge_activity_rows<C: GenericClient>(
    client: &C,
    uid: i32,
    before_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, PlayerReadError> {
    let cap = limit.max(1).min(P2P_ACTIVITY_ROWS_FETCH_CAP);
    let rows = client
        .query(
            "SELECT m.id::text AS id, m.source_item_id, m.result_item_id, m.source_rarity, m.result_rarity,
                    m.fee_usdc::float8 AS fee_usdc, m.created_at,
                    COALESCE(us.name, m.source_item_id) AS source_name,
                    COALESCE(ur.name, m.result_item_id) AS result_name
               FROM merge_history m
               LEFT JOIN upgrades us ON us.id = m.source_item_id
               LEFT JOIN upgrades ur ON ur.id = m.result_item_id
              WHERE m.user_id = $1
                AND ($2::bigint IS NULL OR m.created_at < $2)
              ORDER BY m.created_at DESC
              LIMIT $3",
            &[&uid, &before_ms, &cap],
        )
        .await?;

    let mut out = Vec::new();
    for row in &rows {
        let at_ms = i64_cell(row, "created_at");
        if at_ms <= 0 {
            continue;
        }
        let mid: String = row.get("id");
        let source_id: String = row.get("source_item_id");
        let result_id: String = row.get("result_item_id");
        let source_name: String = row.get("source_name");
        let result_name: String = row.get("result_name");
        let fee = f64_cell(row, "fee_usdc");
        let action = if fee > 0.0 { "merge_craft_paid" } else { "merge_craft" };
        out.push(json!({
            "id": format!("pg:merge:{mid}"),
            "action": action,
            "createdAt": at_ms,
            "meta": {
                "source": "postgres",
                "sourceItemId": source_id,
                "sourceItemName": source_name,
                "resultItemId": result_id,
                "resultItemName": result_name,
                "feeUsdc": fee,
                "totalUsdc": fee,
            }
        }));
    }
    Ok(out)
}

fn shop_line_bits(lines_json: &str) -> (String, Vec<String>) {
    let Ok(v) = serde_json::from_str::<Value>(lines_json) else {
        return ("Compra na loja".into(), Vec::new());
    };
    let Some(arr) = v.as_array() else {
        return ("Compra na loja".into(), Vec::new());
    };
    let mut parts = Vec::new();
    let mut lines = Vec::new();
    for line in arr {
        let id = line.get("id").and_then(Value::as_str).unwrap_or("").trim();
        if id.is_empty() {
            continue;
        }
        let name = line.get("name").and_then(Value::as_str).unwrap_or("").trim();
        let label = if name.is_empty() { id } else { name };
        let qty = line
            .get("qty")
            .and_then(Value::as_i64)
            .or_else(|| line.get("qty").and_then(Value::as_f64).map(|n| n as i64))
            .unwrap_or(0)
            .max(0);
        parts.push(format!("{qty}× {label}"));
        lines.push(format!("{label} ({id}) × {qty}"));
    }
    if parts.is_empty() {
        ("Compra na loja".into(), lines)
    } else {
        (parts.join(", "), lines)
    }
}

fn is_inventory_action(action: &str) -> bool {
    matches!(
        action,
        "miner_equip"
            | "miner_unequip"
            | "rack_place"
            | "rack_remove"
            | "merge_craft"
            | "merge_consume"
            | "admin_compensate"
            | "admin_restore_audit"
            | "stock_save_delta"
    )
}

fn inventory_title(action: &str) -> &'static str {
    match action {
        "miner_equip" => "Equipou máquina",
        "miner_unequip" => "Retirou máquina",
        "rack_place" => "Colocou rack na sala",
        "rack_remove" => "Removeu rack da sala",
        "merge_craft" => "Merge: item criado",
        "merge_consume" => "Merge: item consumido",
        "admin_compensate" => "Compensação de inventário",
        "admin_restore_audit" => "Restauro de inventário",
        "stock_save_delta" => "Ajuste de estoque",
        _ => "Movimento de inventário",
    }
}

fn format_shop_checkout(meta: &Map<String, Value>) -> Value {
    let items = str_meta(meta, "itemsSummary").unwrap_or_else(|| "Compra na loja".into());
    let total = num_meta(meta, "totalUsdc");
    let summary = match total {
        Some(n) => format!("{items} · {n:.2} USDC"),
        None => items.clone(),
    };
    let mut lines = Vec::new();
    if let Some(arr) = meta.get("itemLines").and_then(Value::as_array) {
        for line in arr {
            if let Some(s) = line.as_str() {
                lines.push(s.to_string());
            }
        }
    }
    if let Some(n) = num_meta(meta, "newUsdc") {
        lines.push(format!("Saldo do jogo depois: {n:.2} USDC"));
    }
    let mut out = json!({
        "category": "economy",
        "severity": "success",
        "title": "Compra na loja",
        "summary": summary,
        "technicalMeta": Value::Object(meta.clone()),
    });
    if !lines.is_empty() {
        out["lines"] = json!(lines);
    }
    out
}

fn format_inventory_action(action: &str, meta: &Map<String, Value>) -> Value {
    let item = str_meta(meta, "itemName")
        .filter(|s| !s.is_empty())
        .or_else(|| str_meta(meta, "itemId"));
    let before = num_meta(meta, "quantityBefore");
    let after = num_meta(meta, "quantityAfter");
    let delta = match (before, after) {
        (Some(b), Some(a)) => Some(a - b),
        _ => None,
    };
    let mut summary = inventory_title(action).to_string();
    if let Some(ref name) = item {
        summary = format!("{summary}: {name}");
    }
    if let (Some(b), Some(a)) = (before, after) {
        summary = format!("{summary} · {b:.0} → {a:.0}");
    }
    let severity = if delta.is_some_and(|d| d < 0.0) {
        "warning"
    } else if action == "admin_compensate" || action == "merge_craft" {
        "success"
    } else {
        "info"
    };
    let mut lines = Vec::new();
    if let Some(id) = str_meta(meta, "itemId").filter(|s| !s.is_empty()) {
        lines.push(format!("Item: {id}"));
    }
    if let Some(d) = delta {
        let sign = if d > 0.0 { "+" } else { "" };
        lines.push(format!("Quantidade: {sign}{d:.0}"));
    }
    let mut out = json!({
        "category": "inventory",
        "severity": severity,
        "title": inventory_title(action),
        "summary": summary,
        "technicalMeta": Value::Object(meta.clone()),
    });
    if !lines.is_empty() {
        out["lines"] = json!(lines);
    }
    out
}

fn format_activity_event(action: &str, meta: &Value) -> Value {
    let a = action.trim();
    let m = meta.as_object().cloned().unwrap_or_default();
    if a.starts_with("p2p_") {
        return format_p2p_action(a, &m);
    }
    if a == "shop_checkout" {
        return format_shop_checkout(&m);
    }
    if a == "season_pass_purchase" {
        return format_season_pass_purchase(&m);
    }
    if a == "upgrade_package_buy" {
        return format_upgrade_package_buy(&m);
    }
    if a == "loot_box_buy" {
        return format_loot_box_buy(&m);
    }
    if a == "loot_box_open" {
        return format_loot_box_open(&m);
    }
    if a.starts_with("wheel_spin") || a.starts_with("roleta_") {
        return format_wheel_spin(a, &m);
    }
    if a == "rig_room_slot_purchase" {
        return format_rig_room_slot_purchase(&m);
    }
    if a.starts_with("merge_") {
        return format_merge_action(a, &m);
    }
    if is_inventory_action(a) {
        return format_inventory_action(a, &m);
    }
    default_display(a, &m)
}

fn format_upgrade_package_buy(meta: &Map<String, Value>) -> Value {
    let name = str_meta(meta, "upgradeName").unwrap_or_else(|| "Pacote de Upgrades".into());
    let price = num_meta(meta, "priceUsdc").or_else(|| num_meta(meta, "totalUsdc")).unwrap_or(0.0);
    json!({
        "category": "economy",
        "severity": "success",
        "title": "Pacote de Upgrades",
        "summary": format!("Aquisição: {} ({:.2} USDC)", name, price),
        "lines": [
            format!("Pacote: {name}"),
            format!("Preço pago: {:.2} USDC", price),
        ],
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_loot_box_buy(meta: &Map<String, Value>) -> Value {
    let box_name = str_meta(meta, "boxName")
        .or_else(|| str_meta(meta, "boxId"))
        .unwrap_or_else(|| "Caixa da Sorte".into());
    let qty = num_meta(meta, "qty").unwrap_or(1.0) as i64;
    let total = num_meta(meta, "totalUsdc")
        .or_else(|| num_meta(meta, "price"))
        .unwrap_or(0.0);
    let mut lines = vec![
        format!("Caixa: {box_name}"),
        format!("Quantidade: {qty} un."),
        format!("Total pago: {:.2} USDC", total),
    ];
    if let Some(n) = num_meta(meta, "newUsdc") {
        lines.push(format!("Saldo do jogo depois: {n:.2} USDC"));
    }
    json!({
        "category": "boxes",
        "severity": "success",
        "title": "Compra de Caixa da Sorte",
        "summary": format!("Comprou {qty}× {box_name} · {:.2} USDC", total),
        "lines": lines,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_loot_box_open(meta: &Map<String, Value>) -> Value {
    let box_name = str_meta(meta, "boxName")
        .or_else(|| str_meta(meta, "boxId"))
        .unwrap_or_else(|| "Caixa da Sorte".into());
    let gained = num_meta(meta, "gainedUsdc").unwrap_or(0.0);
    let mut lines = vec![format!("Caixa aberta: {box_name}")];
    if gained > 0.0 {
        lines.push(format!("USDC recebido: +{gained:.2} USDC"));
    }
    if let Some(r_str) = str_meta(meta, "rewardsJson") {
        if let Ok(v) = serde_json::from_str::<Value>(&r_str) {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    let iname = item.get("name").or_else(|| item.get("id")).and_then(Value::as_str).unwrap_or("Item");
                    let iqty = item.get("qty").and_then(Value::as_i64).unwrap_or(1);
                    lines.push(format!("Prémio: {iqty}× {iname}"));
                }
            }
        }
    }
    let summary = if gained > 0.0 {
        format!("Abriu {box_name} (+{gained:.2} USDC)")
    } else {
        format!("Abriu {box_name}")
    };
    json!({
        "category": "boxes",
        "severity": "info",
        "title": "Caixa Aberta",
        "summary": summary,
        "lines": lines,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_wheel_spin(action: &str, meta: &Map<String, Value>) -> Value {
    let item_name = str_meta(meta, "wonItemName")
        .or_else(|| str_meta(meta, "wonItemId"))
        .unwrap_or_else(|| "Prémio".into());
    let charged = num_meta(meta, "chargedUsdc")
        .or_else(|| num_meta(meta, "totalUsdc"))
        .unwrap_or(0.0);
    let is_paid = action == "wheel_spin_paid" || charged > 0.0;
    let title = if is_paid { "Giro Pago na Roleta" } else { "Giro na Roleta" };
    let category = if is_paid { "economy" } else { "boxes" };
    let summary = if is_paid {
        format!("Giro pago ({:.2} USDC) → Ganhou: {}", charged, item_name)
    } else {
        format!("Giro na roleta → Ganhou: {}", item_name)
    };
    let mut lines = vec![format!("Item ganho: {item_name}")];
    if is_paid {
        lines.push(format!("Custo do giro: {:.2} USDC", charged));
    }
    json!({
        "category": category,
        "severity": "success",
        "title": title,
        "summary": summary,
        "lines": lines,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_rig_room_slot_purchase(meta: &Map<String, Value>) -> Value {
    let room_id = str_meta(meta, "roomId").unwrap_or_else(|| "sala".into());
    let room_label = match room_id.as_str() {
        "room_initial" => "Sala Inicial",
        "room_vip" => "Sala VIP",
        "room_gold" => "Sala Gold",
        "room_founders" => "Sala Fundadores",
        "room_asics" => "Sala ASICs",
        "room_extra" => "Sala Extra",
        "room_streamers" => "Sala Streamers",
        "room_nfts" => "Sala NFTs",
        _ => &room_id,
    };
    let slots = num_meta(meta, "slotsPurchased").unwrap_or(1.0) as i64;
    let total = num_meta(meta, "totalPrice")
        .or_else(|| num_meta(meta, "totalUsdc"))
        .unwrap_or(0.0);
    let mut lines = vec![
        format!("Sala: {room_label}"),
        format!("Slots adicionados: +{slots}"),
        format!("Valor pago: {:.2} USDC", total),
    ];
    if let Some(n) = num_meta(meta, "newUsdc") {
        lines.push(format!("Saldo do jogo depois: {n:.2} USDC"));
    }
    json!({
        "category": "economy",
        "severity": "success",
        "title": "Expansão de Slots de Sala",
        "summary": format!("+{slots} Slot(s) na {room_label} · {:.2} USDC", total),
        "lines": lines,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_merge_action(action: &str, meta: &Map<String, Value>) -> Value {
    let source = str_meta(meta, "sourceItemName").unwrap_or_else(|| "Item base".into());
    let result = str_meta(meta, "resultItemName").unwrap_or_else(|| "Item fundido".into());
    let fee = num_meta(meta, "feeUsdc").unwrap_or(0.0);
    let is_paid = fee > 0.0 || action == "merge_craft_paid";
    let summary = if is_paid {
        format!("Fundiu {source} → {result} (Taxa: {:.2} USDC)", fee)
    } else {
        format!("Fundiu {source} → {result}")
    };
    let mut lines = vec![
        format!("Origem: {source}"),
        format!("Resultado: {result}"),
    ];
    if is_paid {
        lines.push(format!("Taxa paga: {:.2} USDC", fee));
    }
    json!({
        "category": if is_paid { "economy" } else { "inventory" },
        "severity": if is_paid { "success" } else { "info" },
        "title": "Fusão de Itens (Merge)",
        "summary": summary,
        "lines": lines,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn format_season_pass_purchase(meta: &Map<String, Value>) -> Value {
    let pass_name = str_meta(meta, "passName").unwrap_or_else(|| "Passe de Temporada".into());
    let price = num_meta(meta, "priceUsdc").unwrap_or(0.0);
    json!({
        "category": "money",
        "severity": "info",
        "title": "Passe de Temporada",
        "summary": format!("Aquisição: {} ({:.2} USDC)", pass_name, price),
        "detail": format!("Passe de época {} adquirido por {:.2} USDC.", pass_name, price),
    })
}

fn format_p2p_action(action: &str, meta: &Map<String, Value>) -> Value {
    let item_name = str_meta(meta, "itemName").or_else(|| str_meta(meta, "itemId"));
    let qty = num_meta(meta, "qty")
        .or_else(|| num_meta(meta, "buyQty"))
        .or_else(|| num_meta(meta, "purchasedQty"));
    let price = num_meta(meta, "price").or_else(|| num_meta(meta, "unitPrice"));
    let total = num_meta(meta, "totalUsdc").or_else(|| num_meta(meta, "buyerPaidUsdc"));
    let counterparty = meta
        .get("sellerId")
        .and_then(json_i64)
        .map(|id| format!("#{id}"))
        .or_else(|| {
            meta.get("buyerId")
                .and_then(json_i64)
                .map(|id| format!("#{id}"))
        })
        .or_else(|| {
            meta.get("counterpartyUserId")
                .and_then(json_i64)
                .map(|id| format!("#{id}"))
        })
        .unwrap_or_default();

    let title = match action {
        "p2p_listing_create" => "Anúncio P2P criado",
        "p2p_listing_open" => "Anúncio P2P activo",
        "p2p_listing_cancel" => "Anúncio P2P cancelado",
        "p2p_listing_reserve" => "Reserva P2P",
        "p2p_reserve_cancel" => "Reserva P2P cancelada",
        "p2p_listing_buy" => "Compra P2P",
        "p2p_listing_sold" => "Venda P2P concluída",
        "p2p_trade_sell" => "Venda no mercado P2P",
        "p2p_trade_buy" => "Compra no mercado P2P",
        "p2p_proceeds_claim" => "Levantamento P2P (vendedor)",
        "p2p_custody_claim" => "Item retirado do cofre P2P",
        "p2p_custody_claim_all" => "Itens retirados do cofre P2P",
        _ => "Mercado P2P",
    };

    let mut summary = action
        .trim_start_matches("p2p_")
        .replace('_', " ");
    if let Some(ref name) = item_name {
        if action == "p2p_listing_create" {
            summary = format!(
                "Listou {}× {}{}",
                qty.unwrap_or(1.0) as i64,
                name,
                price
                    .map(|p| format!(" · {} USDC/un.", fmt_usdc(p)))
                    .unwrap_or_default()
            );
        } else if action == "p2p_listing_buy" {
            summary = format!(
                "Comprou {}× {}{}",
                qty.unwrap_or(1.0) as i64,
                name,
                total
                    .map(|t| format!(" · {} USDC", fmt_usdc(t)))
                    .unwrap_or_default()
            );
        } else if action == "p2p_trade_buy" || action == "p2p_trade_sell" {
            let verb = if action == "p2p_trade_sell" {
                "Vendeu"
            } else {
                "Comprou"
            };
            summary = format!(
                "{verb} {}× {}{}",
                qty.unwrap_or(1.0) as i64,
                name,
                total
                    .map(|t| format!(" · {} USDC", fmt_usdc(t)))
                    .unwrap_or_default()
            );
        } else if action == "p2p_listing_sold" {
            summary = format!(
                "Vendeu {}× {}{}",
                qty.unwrap_or(1.0) as i64,
                name,
                total
                    .map(|t| format!(" · {} USDC", fmt_usdc(t)))
                    .unwrap_or_default()
            );
        } else if action == "p2p_listing_open" {
            summary = format!(
                "Anúncio activo: {}× {}{}",
                qty.unwrap_or(1.0) as i64,
                name,
                price
                    .map(|p| format!(" · {} USDC/un.", fmt_usdc(p)))
                    .unwrap_or_default()
            );
        } else if action == "p2p_listing_cancel" {
            summary = format!("Cancelou anúncio de {name}");
        }
    }
    if action == "p2p_proceeds_claim" {
        summary = format!(
            "Levantou {} USDC",
            fmt_usdc(num_meta(meta, "claimedUsdc").unwrap_or(0.0))
        );
    } else if action == "p2p_custody_claim_all" {
        summary = format!(
            "Retirou {} item(ns) do cofre",
            num_meta(meta, "claimed").unwrap_or(0.0) as i64
        );
    }

    let mut lines = Vec::new();
    if let Some(ref name) = item_name {
        lines.push(format!("Item: {name}"));
    }
    if !counterparty.is_empty() {
        lines.push(format!("Contraparte: {counterparty}"));
    }
    if let Some(lid) = str_meta(meta, "listingId") {
        let short = if lid.len() > LISTING_ID_SHORT_LEN {
            format!("{}…", &lid[..LISTING_ID_SHORT_LEN])
        } else {
            format!("{lid}…")
        };
        lines.push(format!("Anúncio: {short}"));
    }

    let severity = if matches!(
        action,
        "p2p_listing_buy" | "p2p_trade_buy" | "p2p_trade_sell"
    ) {
        "success"
    } else {
        "info"
    };

    let mut out = json!({
        "category": "p2p",
        "severity": severity,
        "title": title,
        "summary": summary,
        "technicalMeta": Value::Object(meta.clone()),
    });
    if !lines.is_empty() {
        out["lines"] = json!(lines);
    }
    out
}

fn default_display(action: &str, meta: &Map<String, Value>) -> Value {
    let keys: Vec<&String> = meta.keys().collect();
    let summary = if keys.is_empty() {
        format!("Evento técnico: {action}")
    } else {
        keys.iter()
            .take(SUMMARY_KEY_PREVIEW_COUNT)
            .map(|k| {
                let raw = serde_json::to_string(&meta[*k]).unwrap_or_default();
                let preview = if raw.len() > SUMMARY_KEY_PREVIEW_MAX_LEN {
                    &raw[..SUMMARY_KEY_PREVIEW_MAX_LEN]
                } else {
                    &raw
                };
                format!("{k}={preview}")
            })
            .collect::<Vec<_>>()
            .join(" · ")
    };
    json!({
        "category": "other",
        "severity": "info",
        "title": action.replace('_', " "),
        "summary": summary,
        "technicalMeta": Value::Object(meta.clone()),
    })
}

fn activity_filter_wants_shop(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "purchase" | "shop" | "near_account_creation"
    )
}

fn activity_filter_wants_season(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "purchase" | "season" | "season_pass" | "near_account_creation"
    )
}

fn activity_filter_wants_p2p(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all"
            | "money"
            | "p2p"
            | "p2p_buy"
            | "p2p_sell"
            | "near_account_creation"
            | "inventory_moves"
    )
}

fn activity_filter_wants_inventory(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "inventory" | "inventory_moves" | "losses" | "near_account_creation"
    )
}

fn activity_filter_wants_upgrades(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "purchase" | "upgrades" | "upgrade_packages" | "near_account_creation"
    )
}

fn activity_filter_wants_boxes(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "purchase" | "boxes" | "near_account_creation"
    )
}

fn activity_filter_wants_wheel(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "wheel" | "roleta" | "near_account_creation"
    )
}

fn activity_filter_wants_room_slots(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "purchase" | "room_slots" | "rigs" | "near_account_creation"
    )
}

fn activity_filter_wants_merge(filter_id: &str) -> bool {
    matches!(
        filter_id,
        "all" | "money" | "inventory" | "inventory_moves" | "near_account_creation"
    )
}

fn matches_activity_filter(display: &Value, action: &str, filter_id: &str) -> bool {
    if filter_id == "all" {
        return true;
    }
    let category = display
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("");
    let severity = display
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("");
    match filter_id {
        "money" => {
            action == "shop_checkout"
                || action == "season_pass_purchase"
                || action == "upgrade_package_buy"
                || action == "loot_box_buy"
                || action == "wheel_spin_paid"
                || action == "rig_room_slot_purchase"
                || action == "merge_craft_paid"
                || action.starts_with("p2p_")
                || category == "economy"
        }
        "season" | "season_pass" => action == "season_pass_purchase",
        "upgrades" | "upgrade_packages" => action == "upgrade_package_buy",
        "losses" => {
            category == "inventory" && (severity == "warning" || severity == "danger")
        }
        "session" => category == "session",
        "inventory" => category == "inventory" || action.starts_with("merge_"),
        "inventory_moves" => {
            category == "inventory"
                || matches!(action, "rack_miner_equip" | "rack_miner_unequip")
                || matches!(action, "stock_delta" | "inventory_loss_alert")
                || matches!(
                    action,
                    "p2p_listing_create" | "p2p_listing_cancel" | "p2p_listing_buy"
                )
        }
        "p2p" => category == "p2p" || action.starts_with("p2p_"),
        "p2p_buy" => action == "p2p_trade_buy" || action == "p2p_listing_buy",
        "p2p_sell" => action == "p2p_trade_sell",
        "purchase" | "shop" => matches!(
            action,
            "shop_checkout"
                | "season_pass_purchase"
                | "upgrade_package_buy"
                | "loot_box_buy"
                | "rig_room_slot_purchase"
                | "hardware_buy"
                | "shop_checkout_ok"
                | "exchange_sell"
        ),
        "auth" | "login" => category == "auth",
        "deposit" => action.to_ascii_lowercase().contains("deposit"),
        "boxes" => category == "boxes" || action.starts_with("loot_box_"),
        "wheel" | "roleta" => action.starts_with("wheel_") || action.starts_with("roleta_"),
        "room_slots" => action == "rig_room_slot_purchase",
        "rigs" => category == "rigs" || action == "rig_room_slot_purchase",
        _ => true,
    }
}

fn clamp_i64(n: i64, min: i64, max: i64) -> i64 {
    n.max(min).min(max)
}

fn parse_i64_loose(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            t.parse::<i64>()
                .ok()
                .or_else(|| t.parse::<f64>().ok().map(|f| f as i64))
        }
        _ => None,
    }
}

fn json_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| v.as_f64().map(|f| f as i64))
}

fn str_meta(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(|v| match v {
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            }
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
}

fn num_meta(meta: &Map<String, Value>, key: &str) -> Option<f64> {
    meta.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    })
}

fn fmt_usdc(n: f64) -> String {
    // Node `toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })`
    // — keep a stable en-US-ish decimal without inventing precision.
    if !n.is_finite() {
        return "—".into();
    }
    let s = format!("{n:.6}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.contains('.') {
        let parts: Vec<&str> = trimmed.split('.').collect();
        if parts.len() == 2 && parts[1].len() < 2 {
            format!("{}.{:0<2}", parts[0], parts[1])
        } else {
            trimmed.to_string()
        }
    } else {
        format!("{trimmed}.00")
    }
}

fn i64_cell(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return i64::from(v);
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v as i64;
        }
    }
    0
}

fn f64_cell(row: &tokio_postgres::Row, col: &str) -> f64 {
    if let Ok(v) = row.try_get::<_, f64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v as f64;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return f64::from(v);
    }
    0.0
}

fn opt_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    row.try_get::<_, Option<String>>(col)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<_, String>(col).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_limits_match_node() {
        assert_eq!(ADMIN_USER_ACTIVITY_PATH, "/v1/admin/user-activity");
        assert_eq!(ACTIVITY_LIMIT_DEFAULT, 80);
        assert_eq!(LEGACY_P2P_LISTING_TTL_MS, (7 * MS_PER_DAY) as i64);
    }

    #[test]
    fn p2p_formatter_trade_buy() {
        let meta = json!({
            "itemName": "GPU",
            "qty": 2,
            "totalUsdc": 1.5,
            "counterpartyUserId": 9
        });
        let d = format_activity_event("p2p_trade_buy", &meta);
        assert_eq!(d["category"], "p2p");
        assert_eq!(d["severity"], "success");
        assert!(d["summary"].as_str().unwrap().contains("Comprou"));
    }

    #[test]
    fn shop_and_inventory_are_readable() {
        let shop = format_activity_event(
            "shop_checkout",
            &json!({
                "itemsSummary": "2× NFT A",
                "itemLines": ["NFT A (nft_a) × 2"],
                "totalUsdc": 200,
                "newUsdc": 50
            }),
        );
        assert_eq!(shop["title"], "Compra na loja");
        assert_eq!(shop["category"], "economy");
        assert!(shop["summary"].as_str().unwrap().contains("200.00"));

        let inv = format_activity_event(
            "miner_equip",
            &json!({"itemName": "Estelar", "itemId": "estelar", "quantityBefore": 3, "quantityAfter": 2}),
        );
        assert_eq!(inv["category"], "inventory");
        assert_eq!(inv["title"], "Equipou máquina");
        assert_eq!(inv["severity"], "warning");
    }

    #[test]
    fn filter_p2p_matches_category() {
        let d = json!({"category": "p2p", "severity": "info"});
        assert!(matches_activity_filter(&d, "p2p_trade_buy", "p2p"));
        assert!(matches_activity_filter(&d, "p2p_trade_buy", "p2p_buy"));
        assert!(!matches_activity_filter(&d, "p2p_trade_buy", "p2p_sell"));
        assert!(matches_activity_filter(&d, "p2p_trade_sell", "p2p_sell"));
        assert!(matches_activity_filter(&d, "shop_checkout", "purchase"));
        assert!(matches_activity_filter(
            &json!({"category": "economy", "severity": "success"}),
            "shop_checkout",
            "money"
        ));
        assert!(!matches_activity_filter(&d, "p2p_trade_buy", "purchase"));
        assert!(!matches_activity_filter(&d, "p2p_trade_buy", "auth"));
        assert!(!matches_activity_filter(
            &json!({"category": "inventory", "severity": "info"}),
            "miner_equip",
            "money"
        ));
    }

    #[test]
    fn formatters_all_purchase_types() {
        // Upgrade Package
        let upg = format_activity_event(
            "upgrade_package_buy",
            &json!({
                "upgradeName": "Pacote SALA GOLD II",
                "priceUsdc": 50.0
            }),
        );
        assert_eq!(upg["title"], "Pacote de Upgrades");
        assert_eq!(upg["category"], "economy");
        assert!(upg["summary"].as_str().unwrap().contains("SALA GOLD II"));
        assert!(upg["summary"].as_str().unwrap().contains("50.00 USDC"));

        // Lucky Box Buy
        let box_buy = format_activity_event(
            "loot_box_buy",
            &json!({
                "boxName": "Caixa Mística",
                "qty": 2,
                "totalUsdc": 10.0,
                "newUsdc": 40.0
            }),
        );
        assert_eq!(box_buy["title"], "Compra de Caixa da Sorte");
        assert_eq!(box_buy["category"], "boxes");
        assert!(box_buy["summary"].as_str().unwrap().contains("2× Caixa Mística"));

        // Paid Wheel Spin
        let wheel = format_activity_event(
            "wheel_spin_paid",
            &json!({
                "wonItemName": "RTX 4090",
                "chargedUsdc": 2.5
            }),
        );
        assert_eq!(wheel["title"], "Giro Pago na Roleta");
        assert_eq!(wheel["category"], "economy");
        assert!(wheel["summary"].as_str().unwrap().contains("2.50 USDC"));
        assert!(wheel["summary"].as_str().unwrap().contains("RTX 4090"));

        // Room Slot Purchase
        let slot = format_activity_event(
            "rig_room_slot_purchase",
            &json!({
                "roomId": "room_vip",
                "slotsPurchased": 4,
                "totalPrice": 12.0
            }),
        );
        assert_eq!(slot["title"], "Expansão de Slots de Sala");
        assert_eq!(slot["category"], "economy");
        assert!(slot["summary"].as_str().unwrap().contains("+4 Slot(s) na Sala VIP"));

        // Filter money matches all purchase types
        assert!(matches_activity_filter(&upg, "upgrade_package_buy", "money"));
        assert!(matches_activity_filter(&box_buy, "loot_box_buy", "money"));
        assert!(matches_activity_filter(&wheel, "wheel_spin_paid", "money"));
        assert!(matches_activity_filter(&slot, "rig_room_slot_purchase", "money"));
        assert!(matches_activity_filter(&upg, "upgrade_package_buy", "purchase"));
        assert!(matches_activity_filter(&upg, "upgrade_package_buy", "upgrades"));
        assert!(matches_activity_filter(&box_buy, "loot_box_buy", "boxes"));
    }
}
