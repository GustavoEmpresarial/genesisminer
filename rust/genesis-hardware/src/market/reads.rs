//! P2P book / custody / sellable / history / state reads.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use genesis_core::market::{clamp_limit, clamp_offset, is_reservation_active};
use serde::Serialize;

use crate::pg_types::pg_user_id;

use super::errors::MarketError;
use super::reclaim::{prepare_market_book_reads, reclaim_expired_for_reads, ReclaimOpts};
use super::sell::price_band_percent;
use super::{
    current_now_ms, finish_tx, set_market_tx_timeouts, CATEGORY_MAX_LENGTH,
    ECONOMY_SETTINGS_SINGLETON_ID, HISTORY_EMPTY_COUNTERPART, HISTORY_LIMIT, HISTORY_LIMIT_MAX,
    SEARCH_MAX_LENGTH, TYPE_MAX_LENGTH,
};

const P2P_LISTING_SELECT_SQL: &str = "l.id,
  l.user_id AS seller_id,
  l.item_id,
  l.price,
  l.qty,
  l.expires_at,
  l.status,
  l.reserved_by,
  l.reserved_until,
  l.is_player,
  l.buyer_paid_usdc,
  COALESCE(NULLIF(TRIM(usr.username), ''), usr.email::text, '') AS seller_display_name,
  ru.username AS reserver_username";

const COUNT_LISTINGS_PREFIX: &str = "SELECT COUNT(*)::bigint AS c
    FROM player_listings l
    JOIN users usr ON l.user_id = usr.id
    JOIN upgrades u ON u.id = l.item_id AND COALESCE(u.is_active, 1) = 1
    WHERE ";

const LIST_LISTINGS_PREFIX: &str = "SELECT ";
const LIST_LISTINGS_FROM: &str = "
    FROM player_listings l
    JOIN users usr ON l.user_id = usr.id
    LEFT JOIN users ru ON ru.id = l.reserved_by
    JOIN upgrades u ON u.id = l.item_id AND COALESCE(u.is_active, 1) = 1
    WHERE ";

const MY_LISTINGS_SQL: &str = "SELECT l.id,
  l.user_id AS seller_id,
  l.item_id,
  l.price,
  l.qty,
  l.expires_at,
  l.status,
  l.reserved_by,
  l.reserved_until,
  l.is_player,
  l.buyer_paid_usdc,
  COALESCE(NULLIF(TRIM(usr.username), ''), usr.email::text, '') AS seller_display_name,
  ru.username AS reserver_username
    FROM player_listings l
    JOIN users usr ON l.user_id = usr.id
    LEFT JOIN users ru ON ru.id = l.reserved_by
    WHERE l.user_id = $1 AND l.status = 'active' AND l.expires_at > $2
    ORDER BY l.expires_at ASC";

const CUSTODY_SQL: &str = "SELECT l.id,
  l.user_id AS seller_id,
  l.item_id,
  l.price,
  l.qty,
  l.expires_at,
  l.status,
  l.reserved_by,
  l.reserved_until,
  l.is_player,
  l.buyer_paid_usdc,
  COALESCE(NULLIF(TRIM(usr.username), ''), usr.email::text, '') AS seller_display_name,
  ru.username AS reserver_username
    FROM player_listings l
    JOIN users usr ON l.user_id = usr.id
    LEFT JOIN users ru ON ru.id = l.reserved_by
    WHERE l.status = 'awaiting_pickup' AND l.reserved_by = $1";

const SELLABLE_SQL: &str =
    "SELECT s.item_id, s.qty::int AS qty, u.base_cost::double precision AS base_cost
    FROM stock s
    JOIN upgrades u ON u.id = s.item_id AND COALESCE(u.is_active, 1) = 1
    WHERE s.user_id = $1 AND s.qty > 0 AND COALESCE(u.sell_in_black_market, 1) <> 0
    ORDER BY s.item_id ASC";

const HIST_PURCH_SQL: &str = "SELECT t.created_at, t.item_id, t.qty, t.unit_price, t.buyer_paid_usdc, t.seller_received_usdc, t.tax_usdc,
           COALESCE(NULLIF(TRIM(su.username), ''), su.email, '') AS counterpart_display
    FROM p2p_market_trade_history t
    JOIN users su ON su.id = t.seller_id
    WHERE t.buyer_id = $1
    ORDER BY t.created_at DESC
    LIMIT $2";

const HIST_SALES_SQL: &str = "SELECT t.created_at, t.item_id, t.qty, t.unit_price, t.buyer_paid_usdc, t.seller_received_usdc, t.tax_usdc,
           COALESCE(NULLIF(TRIM(bu.username), ''), bu.email, '') AS counterpart_display
    FROM p2p_market_trade_history t
    JOIN users bu ON bu.id = t.buyer_id
    WHERE t.seller_id = $1
    ORDER BY t.created_at DESC
    LIMIT $2";

const CATEGORIES_SQL: &str = "SELECT DISTINCT u.category AS c
    FROM player_listings l
    JOIN upgrades u ON u.id = l.item_id AND COALESCE(u.is_active, 1) = 1
    WHERE l.status = 'active'
      AND l.expires_at > $1
      AND l.user_id <> $2
      AND COALESCE(TRIM(u.category), '') <> ''
    ORDER BY 1 ASC";

const SELECT_GS_SQL: &str = "SELECT usdc, black_market_balance FROM game_states WHERE user_id = $1";
const SELECT_ENABLED_SQL: &str = "SELECT black_market_enabled FROM economy_settings WHERE id = $1";
const SELECT_ENABLED_FALLBACK_SQL: &str = "SELECT value FROM settings WHERE key = $1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingClientDto {
    pub id: String,
    pub seller_id: i32,
    pub seller_name: String,
    pub item_id: String,
    pub price: f64,
    pub qty: i32,
    pub line_total: f64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_paid_usdc: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellableRow {
    pub item_id: String,
    pub qty: i32,
    pub base_cost: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: i64,
    pub item_id: String,
    pub qty: i32,
    pub unit_price: f64,
    pub buyer_paid_usdc: f64,
    pub seller_received_usdc: f64,
    pub tax_usdc: f64,
    pub counterpart_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDto {
    pub purchases: Vec<HistoryEntry>,
    pub sales: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingsPage {
    pub items: Vec<ListingClientDto>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDto {
    pub version: i32,
    pub enabled: bool,
    pub usdc: f64,
    pub black_market_balance: f64,
    pub price_band_percent: f64,
    pub listings: StateListings,
    pub my_active_listings: Vec<ListingClientDto>,
    pub custody: Vec<ListingClientDto>,
    pub sellable_stock: Vec<SellableRow>,
    pub buy_filter_categories: Vec<String>,
    pub history: StateHistory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateListings {
    pub items: Vec<ListingClientDto>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateHistory {
    pub purchases: Vec<HistoryEntry>,
    pub sales: Vec<HistoryEntry>,
    pub limit: i64,
}

pub struct ListingsQuery {
    pub exclude_seller_id: Option<i64>,
    pub search: Option<String>,
    pub category: Option<String>,
    pub type_filter: Option<String>,
    pub sort_price: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn map_listing_row(row: &tokio_postgres::Row, now_ms: i64, include_paid: bool) -> ListingClientDto {
    let seller_id: i32 = row.get("seller_id");
    let seller_name: String = row
        .try_get::<_, String>("seller_display_name")
        .unwrap_or_default();
    let item_id: String = row.get("item_id");
    let price: f64 = row.get("price");
    let qty: Option<i32> = row.get("qty");
    let qty = super::listing_qty_from_row(qty);
    let expires_at: i64 = row.get("expires_at");
    let reserved_until: Option<i64> = row.get("reserved_until");
    let reserved_active = is_reservation_active(reserved_until, now_ms);
    let reserver: Option<String> = row.try_get("reserver_username").ok().flatten();
    let reserved_by = if reserved_active {
        reserver.filter(|s| !s.is_empty())
    } else {
        None
    };
    let reserved_until_out = if reserved_active {
        reserved_until
    } else {
        None
    };
    let buyer_paid = if include_paid {
        row.try_get::<_, Option<f64>>("buyer_paid_usdc")
            .ok()
            .flatten()
            .filter(|v| v.is_finite())
    } else {
        None
    };
    ListingClientDto {
        id: row.get("id"),
        seller_id,
        seller_name,
        item_id,
        price,
        qty,
        line_total: price * f64::from(qty),
        expires_at,
        reserved_by,
        reserved_until: reserved_until_out,
        buyer_paid_usdc: buyer_paid,
    }
}

fn escape_like(s: &str) -> String {
    s.replace('%', "\\%").replace('_', "\\_")
}

pub async fn listings_page(pool: &Pool, q: ListingsQuery) -> Result<ListingsPage, MarketError> {
    let now_ms = current_now_ms();
    prepare_market_book_reads(pool, now_ms).await?;
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = listings_page_on_tx(&tx, &q, now_ms).await;
    finish_tx(tx, result).await
}

async fn listings_page_on_tx<C: GenericClient>(
    client: &C,
    q: &ListingsQuery,
    now_ms: i64,
) -> Result<ListingsPage, MarketError> {
    let limit = clamp_limit(q.limit);
    let offset = clamp_offset(q.offset);
    let exclude = q
        .exclude_seller_id
        .filter(|n| *n > 0)
        .and_then(|n| i32::try_from(n).ok());
    let search = q
        .search
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(SEARCH_MAX_LENGTH)
        .collect::<String>();
    let category = q
        .category
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(CATEGORY_MAX_LENGTH)
        .collect::<String>();
    let type_f = q
        .type_filter
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(TYPE_MAX_LENGTH)
        .collect::<String>();
    let sort_desc = q.sort_price.as_deref() == Some("desc");
    let like = if search.is_empty() {
        None
    } else {
        Some(format!("%{}%", escape_like(&search)))
    };

    let mut where_sql = String::from("l.status = 'active' AND l.expires_at > $1");
    let mut idx = 2;
    if exclude.is_some() {
        where_sql.push_str(&format!(" AND l.user_id <> ${idx}"));
        idx += 1;
    }
    if !category.is_empty() {
        where_sql.push_str(&format!(" AND u.category = ${idx}"));
        idx += 1;
    }
    if !type_f.is_empty() {
        where_sql.push_str(&format!(" AND u.type = ${idx}"));
        idx += 1;
    }
    if like.is_some() {
        where_sql.push_str(&format!(
            " AND (u.name ILIKE ${idx} OR l.item_id ILIKE ${idx} OR usr.username ILIKE ${idx} OR COALESCE(usr.email::text, '') ILIKE ${idx})"
        ));
        idx += 1;
    }
    let order_sql = if sort_desc {
        "l.price DESC, l.id DESC"
    } else {
        "l.price ASC, l.id ASC"
    };
    let count_sql = format!("{COUNT_LISTINGS_PREFIX}{where_sql}");
    let list_sql = format!(
        "{LIST_LISTINGS_PREFIX}{P2P_LISTING_SELECT_SQL}{LIST_LISTINGS_FROM}{where_sql} ORDER BY {order_sql} LIMIT ${idx} OFFSET ${}",
        idx + 1
    );

    // Bind via a boxed slice of ToSql — keep it simple with sequential queries.
    let total = query_count(
        client,
        &count_sql,
        now_ms,
        exclude,
        &category,
        &type_f,
        like.as_deref(),
    )
    .await?;
    let items = query_list(
        client,
        &list_sql,
        now_ms,
        exclude,
        &category,
        &type_f,
        like.as_deref(),
        limit,
        offset,
    )
    .await?;
    Ok(ListingsPage { items, total })
}

async fn query_count<C: GenericClient>(
    client: &C,
    sql: &str,
    now_ms: i64,
    exclude: Option<i32>,
    category: &str,
    type_f: &str,
    like: Option<&str>,
) -> Result<i64, MarketError> {
    let rows = match (exclude, category.is_empty(), type_f.is_empty(), like) {
        (None, true, true, None) => client.query(sql, &[&now_ms]).await,
        (Some(ex), true, true, None) => client.query(sql, &[&now_ms, &ex]).await,
        (None, false, true, None) => client.query(sql, &[&now_ms, &category]).await,
        (None, true, false, None) => client.query(sql, &[&now_ms, &type_f]).await,
        (None, true, true, Some(lk)) => client.query(sql, &[&now_ms, &lk]).await,
        (Some(ex), false, true, None) => client.query(sql, &[&now_ms, &ex, &category]).await,
        (Some(ex), true, false, None) => client.query(sql, &[&now_ms, &ex, &type_f]).await,
        (Some(ex), true, true, Some(lk)) => client.query(sql, &[&now_ms, &ex, &lk]).await,
        (None, false, false, None) => client.query(sql, &[&now_ms, &category, &type_f]).await,
        (None, false, true, Some(lk)) => client.query(sql, &[&now_ms, &category, &lk]).await,
        (None, true, false, Some(lk)) => client.query(sql, &[&now_ms, &type_f, &lk]).await,
        (Some(ex), false, false, None) => {
            client.query(sql, &[&now_ms, &ex, &category, &type_f]).await
        }
        (Some(ex), false, true, Some(lk)) => {
            client.query(sql, &[&now_ms, &ex, &category, &lk]).await
        }
        (Some(ex), true, false, Some(lk)) => client.query(sql, &[&now_ms, &ex, &type_f, &lk]).await,
        (None, false, false, Some(lk)) => {
            client.query(sql, &[&now_ms, &category, &type_f, &lk]).await
        }
        (Some(ex), false, false, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &ex, &category, &type_f, &lk])
                .await
        }
    }
    .map_err(MarketError::transport)?;
    Ok(rows.first().map(|r| r.get::<_, i64>("c")).unwrap_or(0))
}

#[allow(clippy::too_many_arguments)]
async fn query_list<C: GenericClient>(
    client: &C,
    sql: &str,
    now_ms: i64,
    exclude: Option<i32>,
    category: &str,
    type_f: &str,
    like: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<ListingClientDto>, MarketError> {
    let rows = match (exclude, category.is_empty(), type_f.is_empty(), like) {
        (None, true, true, None) => client.query(sql, &[&now_ms, &limit, &offset]).await,
        (Some(ex), true, true, None) => client.query(sql, &[&now_ms, &ex, &limit, &offset]).await,
        (None, false, true, None) => {
            client
                .query(sql, &[&now_ms, &category, &limit, &offset])
                .await
        }
        (None, true, false, None) => {
            client
                .query(sql, &[&now_ms, &type_f, &limit, &offset])
                .await
        }
        (None, true, true, Some(lk)) => client.query(sql, &[&now_ms, &lk, &limit, &offset]).await,
        (Some(ex), false, true, None) => {
            client
                .query(sql, &[&now_ms, &ex, &category, &limit, &offset])
                .await
        }
        (Some(ex), true, false, None) => {
            client
                .query(sql, &[&now_ms, &ex, &type_f, &limit, &offset])
                .await
        }
        (Some(ex), true, true, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &ex, &lk, &limit, &offset])
                .await
        }
        (None, false, false, None) => {
            client
                .query(sql, &[&now_ms, &category, &type_f, &limit, &offset])
                .await
        }
        (None, false, true, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &category, &lk, &limit, &offset])
                .await
        }
        (None, true, false, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &type_f, &lk, &limit, &offset])
                .await
        }
        (Some(ex), false, false, None) => {
            client
                .query(sql, &[&now_ms, &ex, &category, &type_f, &limit, &offset])
                .await
        }
        (Some(ex), false, true, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &ex, &category, &lk, &limit, &offset])
                .await
        }
        (Some(ex), true, false, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &ex, &type_f, &lk, &limit, &offset])
                .await
        }
        (None, false, false, Some(lk)) => {
            client
                .query(sql, &[&now_ms, &category, &type_f, &lk, &limit, &offset])
                .await
        }
        (Some(ex), false, false, Some(lk)) => {
            client
                .query(
                    sql,
                    &[&now_ms, &ex, &category, &type_f, &lk, &limit, &offset],
                )
                .await
        }
    }
    .map_err(MarketError::transport)?;
    Ok(rows
        .iter()
        .map(|r| map_listing_row(r, now_ms, false))
        .collect())
}

pub async fn my_listings(pool: &Pool, user_id: i64) -> Result<Vec<ListingClientDto>, MarketError> {
    let now_ms = current_now_ms();
    prepare_market_book_reads(pool, now_ms).await?;
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    let rows = conn
        .query(MY_LISTINGS_SQL, &[&uid, &now_ms])
        .await
        .map_err(MarketError::transport)?;
    Ok(rows
        .iter()
        .map(|r| map_listing_row(r, now_ms, false))
        .collect())
}

pub async fn custody(pool: &Pool, user_id: i64) -> Result<Vec<ListingClientDto>, MarketError> {
    let now_ms = current_now_ms();
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    let rows = conn
        .query(CUSTODY_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    Ok(rows
        .iter()
        .map(|r| map_listing_row(r, now_ms, true))
        .collect())
}

pub async fn sellable_stock(pool: &Pool, user_id: i64) -> Result<Vec<SellableRow>, MarketError> {
    reclaim_expired_for_reads(
        pool,
        ReclaimOpts {
            now_ms: None,
            batch_size: None,
            max_rounds: None,
        },
    )
    .await?;
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    let rows = conn
        .query(SELLABLE_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    Ok(rows
        .iter()
        .map(|r| {
            let item_id: String = r.get("item_id");
            let qty: i32 = r.get("qty");
            let bc: Option<f64> = r.get("base_cost");
            let base_cost = bc.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
            SellableRow {
                item_id: item_id.trim().to_string(),
                qty: qty.max(0),
                base_cost,
            }
        })
        .collect())
}

fn map_hist_row(row: &tokio_postgres::Row) -> HistoryEntry {
    let qty: i32 = row.get("qty");
    let counterpart: Option<String> = row.get("counterpart_display");
    let name = counterpart
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| HISTORY_EMPTY_COUNTERPART.to_string());
    HistoryEntry {
        at: row.get("created_at"),
        item_id: {
            let s: String = row.get("item_id");
            s.trim().to_string()
        },
        qty: if qty >= 1 { qty } else { 1 },
        unit_price: row.get::<_, f64>("unit_price"),
        buyer_paid_usdc: row.get::<_, f64>("buyer_paid_usdc"),
        seller_received_usdc: row.get::<_, f64>("seller_received_usdc"),
        tax_usdc: row.get::<_, f64>("tax_usdc"),
        counterpart_name: name,
    }
}

pub async fn history(pool: &Pool, user_id: i64, limit: i64) -> Result<HistoryDto, MarketError> {
    let lim = limit.clamp(1, HISTORY_LIMIT_MAX);
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    let purch = conn
        .query(HIST_PURCH_SQL, &[&uid, &lim])
        .await
        .map_err(MarketError::transport)?;
    let sales = conn
        .query(HIST_SALES_SQL, &[&uid, &lim])
        .await
        .map_err(MarketError::transport)?;
    Ok(HistoryDto {
        purchases: purch.iter().map(map_hist_row).collect(),
        sales: sales.iter().map(map_hist_row).collect(),
    })
}

async fn is_p2p_enabled<C: GenericClient>(client: &C) -> bool {
    if let Ok(rows) = client
        .query(SELECT_ENABLED_SQL, &[&ECONOMY_SETTINGS_SINGLETON_ID])
        .await
    {
        if let Some(row) = rows.first() {
            let v: Option<i32> = row.get("black_market_enabled");
            return v.unwrap_or(0) != 0;
        }
    }
    if let Ok(rows) = client
        .query(SELECT_ENABLED_FALLBACK_SQL, &[&"black_market_enabled"])
        .await
    {
        if let Some(row) = rows.first() {
            let v: String = row.get("value");
            return v == "1";
        }
    }
    true
}

async fn buy_filter_categories<C: GenericClient>(
    client: &C,
    seller_id: i32,
    now_ms: i64,
) -> Vec<String> {
    match client.query(CATEGORIES_SQL, &[&now_ms, &seller_id]).await {
        Ok(rows) => rows
            .iter()
            .filter_map(|r| {
                let c: Option<String> = r.get("c");
                c.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub async fn state(pool: &Pool, user_id: i64) -> Result<StateDto, MarketError> {
    let now_ms = current_now_ms();
    prepare_market_book_reads(pool, now_ms).await?;
    let listings = listings_page(
        pool,
        ListingsQuery {
            exclude_seller_id: Some(user_id),
            search: None,
            category: None,
            type_filter: None,
            sort_price: Some("asc".into()),
            limit: Some(genesis_core::market::BLACK_MARKET_DEFAULT_LIMIT),
            offset: Some(0),
        },
    )
    .await?;
    let my = my_listings(pool, user_id).await?;
    let cust = custody(pool, user_id).await?;
    let sellable = sellable_stock(pool, user_id).await?;
    let hist = history(pool, user_id, HISTORY_LIMIT).await?;
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let conn = pool.get().await?;
    let enabled = is_p2p_enabled(&conn).await;
    let band = price_band_percent(&conn)
        .await
        .unwrap_or(genesis_core::market::PRICE_BAND_DEFAULT_PERCENT);
    let gs = conn
        .query(SELECT_GS_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    let (usdc, black_market_balance) = match gs.first() {
        Some(r) => {
            let u: f64 = r.get("usdc");
            let b: Option<f64> = r.get("black_market_balance");
            (
                if u.is_finite() { u } else { 0.0 },
                b.filter(|v| v.is_finite()).unwrap_or(0.0),
            )
        }
        None => (0.0, 0.0),
    };
    let cats = buy_filter_categories(&conn, uid, now_ms).await;
    Ok(StateDto {
        version: 1,
        enabled,
        usdc,
        black_market_balance,
        price_band_percent: band,
        listings: StateListings {
            items: listings.items,
            total: listings.total,
            limit: genesis_core::market::BLACK_MARKET_DEFAULT_LIMIT,
            offset: 0,
        },
        my_active_listings: my,
        custody: cust,
        sellable_stock: sellable,
        buy_filter_categories: cats,
        history: StateHistory {
            purchases: hist.purchases,
            sales: hist.sales,
            limit: HISTORY_LIMIT,
        },
    })
}

/// Node `listAdminMarketListings` — every `player_listings` row + seller name,
/// ordered `status ASC, item_id ASC`. Bare array (no client-side filter).
pub async fn admin_market_listings(pool: &Pool) -> Result<serde_json::Value, MarketError> {
    let client = pool.get().await.map_err(MarketError::transport)?;
    let rows = client
        .query(
            "SELECT l.id, l.user_id, l.item_id,
                    l.price::float8 AS price,
                    COALESCE(l.qty, 1) AS qty,
                    l.status, l.expires_at, l.reserved_by, l.reserved_until,
                    COALESCE(NULLIF(TRIM(u.username), ''), u.email::text, '') AS seller_name
               FROM player_listings l
               LEFT JOIN users u ON u.id = l.user_id
              ORDER BY l.status ASC, l.item_id ASC",
            &[],
        )
        .await
        .map_err(MarketError::transport)?;

    let out: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let unit: f64 = r.get::<_, Option<f64>>("price").unwrap_or(0.0);
            let qty: i32 = r.get::<_, Option<i32>>("qty").unwrap_or(1).max(1);
            let mut dto = serde_json::json!({
                "id": r.get::<_, String>("id"),
                "sellerId": r.get::<_, i32>("user_id"),
                "sellerName": r.get::<_, String>("seller_name"),
                "itemId": r.get::<_, String>("item_id"),
                "price": unit,
                "qty": qty,
                "lineTotal": unit * f64::from(qty),
                "status": r.get::<_, Option<String>>("status"),
                "expiresAt": r.get::<_, Option<i64>>("expires_at").unwrap_or(0),
                "reservedBy": r.get::<_, Option<i32>>("reserved_by"),
            });
            if let Some(ru) = r.get::<_, Option<i64>>("reserved_until") {
                dto["reservedUntil"] = serde_json::json!(ru);
            }
            dto
        })
        .collect();
    Ok(serde_json::json!(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_sql_matches_node_aliases() {
        assert!(P2P_LISTING_SELECT_SQL.contains("seller_display_name"));
        assert!(P2P_LISTING_SELECT_SQL.contains("reserver_username"));
        assert!(P2P_LISTING_SELECT_SQL.contains("seller_id"));
        assert!(!P2P_LISTING_SELECT_SQL.contains("gen_random_uuid"));
        assert!(SELLABLE_SQL.contains("sell_in_black_market"));
        assert!(HIST_PURCH_SQL.contains("counterpart_display"));
        assert_eq!(HISTORY_EMPTY_COUNTERPART, "—");
        assert_eq!(HISTORY_LIMIT, 80);
        assert_eq!(HISTORY_LIMIT_MAX, 200);
    }

    #[test]
    fn state_version_is_one() {
        assert_eq!(genesis_core::market::BLACK_MARKET_DEFAULT_LIMIT, 60);
    }
}
