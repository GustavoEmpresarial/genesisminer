//! Axum handlers for player-read twins.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::catalog::{
    run_catalog_access_levels, run_catalog_loot_boxes, run_catalog_mining_coins,
    run_catalog_upgrades, CatalogUserRequest,
};
use super::inventory::{inventory_me_from_state, run_inventory_state};
use super::lucky::{
    run_lucky_discard, run_lucky_history, run_lucky_inventory, run_lucky_opening, run_lucky_shop,
    run_lucky_state, LuckyDiscardRequest, LuckyUserRequest,
};
use super::merge::{run_merge_config, run_merge_history, run_merge_inventory, MergeUserRequest};
use super::news::{run_news_expire_days, run_news_fee, run_news_list};
use super::rooms::{run_my_rig_rooms, run_rig_rooms_list, MyRoomsRequest};
use super::season_passes::run_season_passes;
use super::servers::{
    run_admin_game_state_by_email, run_game_state_me, run_servers_state,
    AdminGameStateByEmailRequest, ServersUserRequest,
};
use super::shop::{
    run_cart_clear, run_cart_delete_line, run_cart_set, run_cart_set_line, run_shop_order,
    run_shop_state, ShopCartLineRequest, ShopCartSetLineRequest, ShopCartSetRequest,
    ShopOrderRequest, ShopUserRequest,
};
use super::upgrades::{run_upgrades_purchases, run_upgrades_state, UpgradesUserRequest};
use super::wheel::{
    run_roleta_pending_code, run_wheel_history, run_wheel_spin, run_wheel_state, WheelUserRequest,
};
use super::{
    fail_read, ok_payload, ADMIN_GAME_STATE_BY_EMAIL_PATH, CATALOG_ACCESS_LEVELS_PATH,
    CATALOG_LOOT_BOXES_PATH, CATALOG_MINING_COINS_PATH, CATALOG_UPGRADES_PATH, GAME_STATE_ME_PATH,
    INVENTORY_STATE_PATH, LUCKY_DISCARD_PATH, LUCKY_HISTORY_PATH, LUCKY_INVENTORY_PATH,
    LUCKY_OPENING_PATH, LUCKY_SHOP_PATH, LUCKY_STATE_PATH, MERGE_CONFIG_PATH, MERGE_HISTORY_PATH,
    MERGE_INVENTORY_PATH, MY_RIG_ROOMS_PATH, NEWS_EXPIRE_DAYS_PATH, NEWS_FEE_PATH, NEWS_LIST_PATH,
    RIG_ROOMS_PATH, ROLETA_PENDING_CODE_PATH, SEASON_PASSES_PATH, SERVERS_STATE_PATH,
    SHOP_CART_CLEAR_PATH, SHOP_CART_DELETE_LINE_PATH, SHOP_CART_SET_LINE_PATH, SHOP_CART_SET_PATH,
    SHOP_ORDER_PATH, SHOP_PRODUCTS_PATH, SHOP_STATE_PATH, UPGRADES_PURCHASES_PATH,
    UPGRADES_STATE_PATH, WHEEL_HISTORY_PATH, WHEEL_SPIN_PATH, WHEEL_STATE_PATH,
};
use crate::http::AppState;

pub const INVENTORY_ME_PATH: &str = "/v1/inventory/me";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserIdBody {
    user_id: i64,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(INVENTORY_STATE_PATH, post(post_inventory_state))
        .route(INVENTORY_ME_PATH, post(post_inventory_me))
        .route(SHOP_STATE_PATH, post(post_shop_state))
        .route(SHOP_PRODUCTS_PATH, post(post_shop_products))
        .route(SHOP_CART_SET_PATH, post(post_cart_set))
        .route(SHOP_CART_SET_LINE_PATH, post(post_cart_set_line))
        .route(SHOP_CART_DELETE_LINE_PATH, post(post_cart_delete_line))
        .route(SHOP_CART_CLEAR_PATH, post(post_cart_clear))
        .route(CATALOG_UPGRADES_PATH, post(post_catalog_upgrades))
        .route(CATALOG_MINING_COINS_PATH, post(post_catalog_mining_coins))
        .route(CATALOG_ACCESS_LEVELS_PATH, post(post_catalog_access_levels))
        .route(CATALOG_LOOT_BOXES_PATH, post(post_catalog_loot_boxes))
        .route(SERVERS_STATE_PATH, post(post_servers_state))
        .route(GAME_STATE_ME_PATH, post(post_game_state_me))
        .route(
            ADMIN_GAME_STATE_BY_EMAIL_PATH,
            post(post_admin_game_state_by_email),
        )
        .route(LUCKY_STATE_PATH, post(post_lucky_state))
        .route(LUCKY_SHOP_PATH, post(post_lucky_shop))
        .route(LUCKY_INVENTORY_PATH, post(post_lucky_inventory))
        .route(LUCKY_HISTORY_PATH, post(post_lucky_history))
        .route(LUCKY_OPENING_PATH, post(post_lucky_opening))
        .route(LUCKY_DISCARD_PATH, post(post_lucky_discard))
        .route(WHEEL_STATE_PATH, post(post_wheel_state))
        .route(WHEEL_HISTORY_PATH, post(post_wheel_history))
        .route(WHEEL_SPIN_PATH, post(post_wheel_spin))
        .route(ROLETA_PENDING_CODE_PATH, post(post_roleta_pending_code))
        .route(NEWS_LIST_PATH, post(post_news_list))
        .route(NEWS_FEE_PATH, post(post_news_fee))
        .route(NEWS_EXPIRE_DAYS_PATH, post(post_news_expire_days))
        .route(SEASON_PASSES_PATH, post(post_season_passes))
        .route(RIG_ROOMS_PATH, post(post_rig_rooms))
        .route(MY_RIG_ROOMS_PATH, post(post_my_rig_rooms))
        .route(MERGE_CONFIG_PATH, post(post_merge_config))
        .route(MERGE_INVENTORY_PATH, post(post_merge_inventory))
        .route(MERGE_HISTORY_PATH, post(post_merge_history))
        .route(UPGRADES_STATE_PATH, post(post_upgrades_state))
        .route(UPGRADES_PURCHASES_PATH, post(post_upgrades_purchases))
        .route(SHOP_ORDER_PATH, post(post_shop_order))
}

async fn post_inventory_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserIdBody>,
) -> impl axum::response::IntoResponse {
    match run_inventory_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_inventory_me(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserIdBody>,
) -> impl axum::response::IntoResponse {
    match run_inventory_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(inventory_me_from_state(&v)),
        Err(e) => fail_read(e),
    }
}

async fn post_shop_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_shop_state(&state.pool, body.user_id, body.is_admin.unwrap_or(false)).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_shop_products(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_shop_state(&state.pool, body.user_id, body.is_admin.unwrap_or(false)).await {
        Ok(v) => ok_payload(json!({ "products": v.get("products").cloned().unwrap_or(json!([])) })),
        Err(e) => fail_read(e),
    }
}

async fn post_cart_set(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopCartSetRequest>,
) -> impl axum::response::IntoResponse {
    match run_cart_set(&state.pool, body.user_id, &body.product_id, body.qty).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_cart_set_line(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopCartSetLineRequest>,
) -> impl axum::response::IntoResponse {
    match run_cart_set_line(&state.pool, body.user_id, &body.line_id, body.qty).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_cart_delete_line(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopCartLineRequest>,
) -> impl axum::response::IntoResponse {
    match run_cart_delete_line(&state.pool, body.user_id, &body.line_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_cart_clear(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserIdBody>,
) -> impl axum::response::IntoResponse {
    match run_cart_clear(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_catalog_upgrades(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CatalogUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_catalog_upgrades(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_catalog_mining_coins(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_catalog_mining_coins(&state.pool).await {
        Ok(v) => ok_payload(json!({ "items": v })),
        Err(e) => fail_read(e),
    }
}

async fn post_catalog_access_levels(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_catalog_access_levels(&state.pool).await {
        Ok(v) => ok_payload(json!({ "items": v })),
        Err(e) => fail_read(e),
    }
}

async fn post_catalog_loot_boxes(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_catalog_loot_boxes(&state.pool).await {
        Ok(v) => ok_payload(json!({ "items": v })),
        Err(e) => fail_read(e),
    }
}

async fn post_servers_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ServersUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_servers_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_game_state_me(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ServersUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_game_state_me(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_admin_game_state_by_email(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminGameStateByEmailRequest>,
) -> impl axum::response::IntoResponse {
    match run_admin_game_state_by_email(&state.pool, &body.email, body.admin_edit).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_lucky_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_shop(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_lucky_shop(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_inventory(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_lucky_inventory(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_lucky_history(&state.pool, body.user_id, body.cursor.as_deref()).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_opening(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyUserRequest>,
) -> impl axum::response::IntoResponse {
    let id = body.opening_id.unwrap_or_default();
    match run_lucky_opening(&state.pool, body.user_id, &id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_lucky_discard(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LuckyDiscardRequest>,
) -> impl axum::response::IntoResponse {
    match run_lucky_discard(
        &state.pool,
        body.user_id,
        &body.box_id,
        &body.qty.unwrap_or(json!(0)),
    )
    .await
    {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_wheel_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WheelUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_wheel_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_wheel_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WheelUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_wheel_history(&state.pool, body.user_id, body.limit).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_wheel_spin(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WheelUserRequest>,
) -> impl axum::response::IntoResponse {
    let id = body.spin_id.unwrap_or_default();
    match run_wheel_spin(&state.pool, body.user_id, &id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_roleta_pending_code(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UserIdBody>,
) -> impl axum::response::IntoResponse {
    match run_roleta_pending_code(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_news_list(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    match run_news_list(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_news_fee(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    match run_news_fee(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_news_expire_days(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_news_expire_days(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_season_passes(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_season_passes(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_rig_rooms(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    match run_rig_rooms_list(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_my_rig_rooms(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MyRoomsRequest>,
) -> impl axum::response::IntoResponse {
    match run_my_rig_rooms(&state.pool, body.user_id, body.email.as_deref()).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_merge_config(
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    match run_merge_config(&state.pool).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_merge_inventory(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MergeUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_merge_inventory(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_merge_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MergeUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_merge_history(&state.pool, body.user_id, body.limit).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_upgrades_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpgradesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_upgrades_state(&state.pool, body.user_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_upgrades_purchases(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpgradesUserRequest>,
) -> impl axum::response::IntoResponse {
    match run_upgrades_purchases(&state.pool, body.user_id, body.limit).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

async fn post_shop_order(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ShopOrderRequest>,
) -> impl axum::response::IntoResponse {
    match run_shop_order(&state.pool, body.user_id, &body.order_id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}
