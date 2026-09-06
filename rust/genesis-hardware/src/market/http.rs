//! Axum handlers for `/v1/market/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::http::AppState;

use super::buy::{buy, buy_cached};
use super::cancel::cancel;
use super::claim::{claim_all, claim_item, claim_proceeds};
use super::errors::MarketError;
use super::reads::{
    custody, history, listings_page, my_listings, sellable_stock, state, ListingsQuery,
};
use super::reclaim::{reclaim_expired, ReclaimOpts};
use super::reserve::{cancel_reserve, reserve};
use super::sell::sell;
use super::{
    MARKET_BUY_CACHED_PATH, MARKET_BUY_PATH, MARKET_CANCEL_PATH, MARKET_CANCEL_RESERVE_PATH,
    MARKET_CLAIM_ALL_PATH, MARKET_CLAIM_ITEM_PATH, MARKET_CLAIM_PROCEEDS_PATH, MARKET_CUSTODY_PATH,
    MARKET_HISTORY_PATH, MARKET_LISTINGS_PATH, MARKET_MY_LISTINGS_PATH, MARKET_RECLAIM_PATH,
    MARKET_RESERVE_PATH, MARKET_SELLABLE_STOCK_PATH, MARKET_SELL_PATH, MARKET_STATE_PATH,
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buy_qty: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seller_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchased_qty: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reclaimed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchases: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sales: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SellRequest {
    pub user_id: i64,
    pub item_id: String,
    pub price: f64,
    pub qty: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserListingRequest {
    pub user_id: i64,
    pub listing_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyRequest {
    pub buyer_id: i64,
    pub listing_id: String,
    pub qty: Option<serde_json::Value>,
    pub idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyCachedRequest {
    pub buyer_id: i64,
    pub idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimRequest {
    pub now_ms: Option<i64>,
    pub batch_size: Option<i64>,
    pub max_rounds: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingsRequest {
    pub exclude_seller_id: Option<i64>,
    pub search: Option<String>,
    pub category: Option<String>,
    #[serde(rename = "type")]
    pub type_filter: Option<String>,
    pub sort_price: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub user_id: i64,
    pub limit: Option<i64>,
}

fn market_fail(e: MarketError) -> (StatusCode, Json<MarketBody>) {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            missing,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(MarketBody {
                    ok: false,
                    error: Some(error),
                    code,
                    missing,
                    ..Default::default()
                }),
            )
        }
        MarketError::Transport(err) => {
            warn!(err = %err, "market transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(MarketBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn ok_body(body: MarketBody) -> (StatusCode, Json<MarketBody>) {
    (StatusCode::OK, Json(body))
}

pub fn market_paths() -> [&'static str; 16] {
    [
        MARKET_SELL_PATH,
        MARKET_CANCEL_PATH,
        MARKET_RESERVE_PATH,
        MARKET_CANCEL_RESERVE_PATH,
        MARKET_BUY_PATH,
        MARKET_BUY_CACHED_PATH,
        MARKET_CLAIM_PROCEEDS_PATH,
        MARKET_CLAIM_ALL_PATH,
        MARKET_CLAIM_ITEM_PATH,
        MARKET_RECLAIM_PATH,
        MARKET_LISTINGS_PATH,
        MARKET_MY_LISTINGS_PATH,
        MARKET_CUSTODY_PATH,
        MARKET_SELLABLE_STOCK_PATH,
        MARKET_HISTORY_PATH,
        MARKET_STATE_PATH,
    ]
}

pub async fn post_sell(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SellRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match sell(
        &state.pool,
        body.user_id,
        &body.item_id,
        body.price,
        body.qty,
    )
    .await
    {
        Ok(out) => ok_body(MarketBody {
            ok: true,
            listing_id: Some(out.listing_id),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_cancel(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserListingRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match cancel(&state.pool, body.user_id, &body.listing_id).await {
        Ok(out) => ok_body(MarketBody {
            ok: true,
            item_id: Some(out.item_id),
            qty: Some(out.qty),
            price: Some(out.price),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_reserve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserListingRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match reserve(&state.pool, body.user_id, &body.listing_id).await {
        Ok(until) => ok_body(MarketBody {
            ok: true,
            reserved_until: Some(until),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_cancel_reserve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserListingRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match cancel_reserve(&state.pool, body.user_id, &body.listing_id).await {
        Ok(cancelled) => ok_body(MarketBody {
            ok: true,
            cancelled: Some(cancelled),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_buy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BuyRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match buy(
        &state.pool,
        body.buyer_id,
        &body.listing_id,
        body.qty,
        &body.idempotency_key,
    )
    .await
    {
        Ok(out) => ok_body(MarketBody {
            ok: true,
            buy_qty: Some(out.buy_qty),
            total_price: Some(out.total_price),
            unit_price: Some(out.unit_price),
            seller_id: Some(out.seller_id),
            item_id: Some(out.item_id),
            listing_id: Some(out.listing_id),
            message: Some(out.message),
            purchased_qty: Some(out.purchased_qty),
            total_usdc: Some(out.total_usdc),
            cached: Some(out.cached),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_buy_cached(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BuyCachedRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match buy_cached(&state.pool, body.buyer_id, &body.idempotency_key).await {
        Ok(Some(cached)) => ok_body(MarketBody {
            ok: true,
            cached: Some(true),
            http_status: Some(cached.status),
            body: Some(cached.body),
            ..Default::default()
        }),
        Ok(None) => ok_body(MarketBody {
            ok: true,
            cached: Some(false),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_claim_proceeds(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match claim_proceeds(&state.pool, body.user_id).await {
        Ok(moved) => ok_body(MarketBody {
            ok: true,
            moved: Some(moved),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_claim_all(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match claim_all(&state.pool, body.user_id).await {
        Ok(ids) => ok_body(MarketBody {
            ok: true,
            claimed_ids: Some(ids),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_claim_item(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserListingRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match claim_item(&state.pool, body.user_id, &body.listing_id).await {
        Ok(out) => ok_body(MarketBody {
            ok: true,
            item_id: Some(out.item_id),
            qty: Some(out.qty),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_reclaim(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReclaimRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match reclaim_expired(
        &state.pool,
        ReclaimOpts {
            now_ms: body.now_ms,
            batch_size: body.batch_size,
            max_rounds: body.max_rounds,
        },
    )
    .await
    {
        Ok(n) => ok_body(MarketBody {
            ok: true,
            reclaimed: Some(n),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_listings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ListingsRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match listings_page(
        &state.pool,
        ListingsQuery {
            exclude_seller_id: body.exclude_seller_id,
            search: body.search,
            category: body.category,
            type_filter: body.type_filter,
            sort_price: body.sort_price,
            limit: body.limit,
            offset: body.offset,
        },
    )
    .await
    {
        Ok(page) => ok_body(MarketBody {
            ok: true,
            items: serde_json::to_value(&page.items).ok(),
            total: Some(page.total),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_my_listings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match my_listings(&state.pool, body.user_id).await {
        Ok(items) => ok_body(MarketBody {
            ok: true,
            items: serde_json::to_value(&items).ok(),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_custody(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match custody(&state.pool, body.user_id).await {
        Ok(items) => ok_body(MarketBody {
            ok: true,
            items: serde_json::to_value(&items).ok(),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_sellable_stock(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match sellable_stock(&state.pool, body.user_id).await {
        Ok(items) => ok_body(MarketBody {
            ok: true,
            items: serde_json::to_value(&items).ok(),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HistoryRequest>,
) -> (StatusCode, Json<MarketBody>) {
    let limit = body.limit.unwrap_or(super::HISTORY_LIMIT);
    match history(&state.pool, body.user_id, limit).await {
        Ok(h) => ok_body(MarketBody {
            ok: true,
            purchases: serde_json::to_value(&h.purchases).ok(),
            sales: serde_json::to_value(&h.sales).ok(),
            ..Default::default()
        }),
        Err(e) => market_fail(e),
    }
}

pub async fn post_state(
    State(app): State<Arc<AppState>>,
    Json(body): Json<UserRequest>,
) -> (StatusCode, Json<MarketBody>) {
    match state(&app.pool, body.user_id).await {
        Ok(dto) => match serde_json::to_value(&dto) {
            Ok(v) => ok_body(MarketBody {
                ok: true,
                state: Some(v),
                ..Default::default()
            }),
            Err(e) => market_fail(MarketError::transport(e)),
        },
        Err(e) => market_fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_market_paths_registered() {
        let paths = market_paths();
        assert_eq!(paths.len(), 16);
        assert!(paths.contains(&"/v1/market/sell"));
        assert!(paths.contains(&"/v1/market/buy-cached"));
        assert!(paths.contains(&"/v1/market/state"));
        assert!(!paths.iter().any(|p| p.contains("p2p-instances")));
    }
}
