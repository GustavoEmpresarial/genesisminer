//! Axum HTTP surface for Node → Rust hardware persist / intent / credit / adjust / racks-power / fold-warehouse / recall-all / wipe-user / p2p-instances / market / shop / merge / wheel / lucky-boxes / rooms / upgrades / catalog.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use deadpool_postgres::Pool;
use genesis_core::hardware::intent::{
    apply_place_rack_from_stock, apply_rack_aux_equip, apply_rack_aux_unequip,
    apply_rack_miner_equip, apply_rack_miner_unequip, apply_remove_rack_to_stock,
};
use genesis_core::hardware::types::{
    AuxEquipInput, AuxUnequipInput, HardwareApplyResult, PlacedRack, StoredBattery,
};
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::adjust::{adjust_stock, AdjustLine};
use crate::admin_catalog::http::{
    post_access_levels_replace, post_admin_delete_user_box, post_admin_user_boxes,
    post_loot_box_delete, post_loot_box_redemptions, post_loot_boxes_upsert,
    post_mining_coins_economy_settings, post_mining_coins_set_active, post_mining_coins_upsert, post_news_delete, post_news_expire_days_persist, post_news_fee_persist,
    post_news_upsert, post_rig_rooms_upsert, post_season_passes_replace,
};
use crate::admin_catalog::{
    ACCESS_LEVELS_REPLACE_PATH, ADMIN_DELETE_USER_BOX_PATH, ADMIN_USER_BOXES_PATH,
    LOOT_BOXES_DELETE_PATH, LOOT_BOXES_UPSERT_PATH, LOOT_BOX_REDEMPTIONS_PATH,
    MINING_COINS_ECONOMY_SETTINGS_PATH, MINING_COINS_SET_ACTIVE_PATH, MINING_COINS_UPSERT_PATH, NEWS_DELETE_PATH, NEWS_EXPIRE_DAYS_PERSIST_PATH, NEWS_FEE_PERSIST_PATH,
    NEWS_UPSERT_PATH, RIG_ROOMS_UPSERT_PATH, SEASON_PASSES_REPLACE_PATH,
};
use crate::catalog::http::post_upgrades_replace as post_catalog_upgrades_replace;
use crate::catalog::CATALOG_UPGRADES_REPLACE_PATH;
use crate::config::{
    current_unix_ms, WorkerConfig, HARDWARE_TX_TIMEOUT_MS, MINING_WORKER_AUTH_HEADER,
};
use crate::intent_idem::{
    build_success_response_json, insert_intent_idem_success, lookup_intent_idem,
    validate_intent_idem_keys, IntentIdemError, IntentIdemLookup, HTTP_BAD_REQUEST, HTTP_CONFLICT,
};
use crate::leases::expire_user_asic_leases;
use crate::load::{
    load_hardware_state, load_upgrades_with_compat, resolve_asic_room_ids, resolve_nft_room_ids,
};
use crate::lucky_boxes::http::{
    post_buy as post_lucky_box_buy, post_open as post_lucky_box_open,
    post_promo_redeem as post_lucky_box_promo_redeem,
};
use crate::lucky_boxes::{LUCKY_BOX_BUY_PATH, LUCKY_BOX_OPEN_PATH, LUCKY_BOX_PROMO_REDEEM_PATH};
use crate::market::http::{
    post_buy, post_buy_cached, post_cancel, post_cancel_reserve, post_claim_all, post_claim_item,
    post_admin_listings, post_claim_proceeds, post_custody, post_history, post_listings,
    post_my_listings, post_reclaim,
    post_reserve, post_sell, post_sellable_stock, post_state,
};
use crate::market::{
    MARKET_BUY_CACHED_PATH, MARKET_BUY_PATH, MARKET_CANCEL_PATH, MARKET_CANCEL_RESERVE_PATH,
    MARKET_CLAIM_ALL_PATH, MARKET_CLAIM_ITEM_PATH, MARKET_CLAIM_PROCEEDS_PATH, MARKET_CUSTODY_PATH,
    MARKET_HISTORY_PATH, MARKET_LISTINGS_PATH, MARKET_MY_LISTINGS_PATH, MARKET_RECLAIM_PATH,
    MARKET_ADMIN_LISTINGS_PATH, MARKET_RESERVE_PATH, MARKET_SELLABLE_STOCK_PATH, MARKET_SELL_PATH,
    MARKET_STATE_PATH,
};
use crate::merge::http::post_execute as post_merge_execute;
use crate::merge::MERGE_EXECUTE_PATH;
use crate::p2p::{p2p_instances, P2pInstancesInput, P2P_INSTANCES_PATH};
use crate::persist::{
    credit_stock, fold_warehouse_ids, persist_hardware, PersistInput, StockMode,
    FOLD_WAREHOUSE_PATH,
};
use crate::post_apply::{
    run_post_apply, sanitize_placed_racks_nft_auto_room, strip_nft_coins_before_persist,
    validate_placed_racks_for_save, PostApplyError, PostApplyInput,
};
use crate::racks_power::{apply_racks_power, RacksPowerError, RacksPowerRequest};
use crate::recall_all::{recall_all, RECALL_ALL_PATH};
use crate::rooms::http::post_purchase_slot as post_rooms_purchase_slot;
use crate::rooms::ROOM_PURCHASE_SLOT_PATH;
use crate::shop::http::post_checkout as post_shop_checkout;
use crate::shop::SHOP_CHECKOUT_PATH;
use crate::upgrades::http::post_purchase as post_upgrades_purchase;
use crate::upgrades::UPGRADE_PACKAGE_PURCHASE_PATH;
use crate::wheel::http::{
    post_admin_wheel_players_add, post_admin_wheel_players_list, post_admin_wheel_players_remove,
    post_admin_wheel_prizes_list,
    post_admin_wheel_prizes_replace, post_admin_wheel_runtime_config_get,
    post_admin_wheel_runtime_config_set, post_paid_spin as post_wheel_paid_spin,
    post_redeem_code as post_wheel_redeem_code, post_roleta_claim, post_roll as post_wheel_roll,
};
use crate::wheel::{
    ROLETA_CLAIM_PATH, WHEEL_ADMIN_PLAYERS_ADD_PATH, WHEEL_ADMIN_PLAYERS_PATH,
    WHEEL_ADMIN_PLAYERS_REMOVE_PATH, WHEEL_ADMIN_PRIZES_PATH, WHEEL_ADMIN_PRIZES_REPLACE_PATH, WHEEL_ADMIN_RUNTIME_CONFIG_PATH,
    WHEEL_ADMIN_RUNTIME_CONFIG_SET_PATH, WHEEL_PAID_SPIN_PATH, WHEEL_REDEEM_CODE_PATH,
    WHEEL_ROLL_PATH,
};
use crate::partners_streamer::{
    deactivate_streamer_room, STREAMER_ROOM_DEACTIVATE_PATH, STREAMER_ROOM_ID,
};
use crate::wipe_user::{wipe_user, WIPE_USER_PATH};

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub cfg: WorkerConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistRequest {
    pub user_id: i64,
    pub stock: Option<HashMap<String, i64>>,
    pub stock_mode: Option<String>,
    pub stored_batteries: Option<Vec<StoredBattery>>,
    pub placed_racks: Option<Vec<PlacedRack>>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stock: Option<HashMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_batteries: Option<Vec<StoredBattery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placed_racks: Option<Vec<PlacedRack>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_moved: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub racks_processed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditRequest {
    pub user_id: i64,
    pub item_id: String,
    pub qty: i64,
    pub duration_amount: Option<i64>,
    pub duration_unit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustLineBody {
    pub item_id: String,
    pub qty: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustRequest {
    pub user_id: i64,
    pub debit: Vec<AdjustLineBody>,
    pub credit: Vec<AdjustLineBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldWarehouseRequest {
    pub user_id: i64,
    pub battery_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallAllRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WipeUserRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pInstancesRequest {
    pub user_id: i64,
    pub item_id: String,
    pub op: String,
    pub qty: Option<i64>,
    pub to_user_id: Option<i64>,
    pub instance_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentRequest {
    pub user_id: i64,
    pub kind: String,
    pub rack_id: Option<String>,
    pub catalog_item_id: Option<String>,
    pub room_id: Option<String>,
    pub slot_index: Option<i64>,
    pub stored_battery_id: Option<String>,
    pub battery_mode: Option<String>,
    pub multiplier_slot_index: Option<i64>,
    pub aux_kind: Option<String>,
    pub scope: String,
    pub idempotency_key: String,
    pub request_fingerprint: Option<String>,
}

pub fn router(state: AppState) -> Router {
    let state = Arc::new(state);
    let protected = Router::new()
        .route("/v1/hardware/persist", post(post_persist))
        .route("/v1/hardware/intent", post(post_intent))
        .route("/v1/hardware/credit", post(post_credit))
        .route("/v1/hardware/adjust", post(post_adjust))
        .route(FOLD_WAREHOUSE_PATH, post(post_fold_warehouse))
        .route("/v1/hardware/racks-power", post(post_racks_power))
        .route(
            crate::bulk_batteries::BULK_BATTERIES_PATH,
            post(post_bulk_batteries),
        )
        .route(RECALL_ALL_PATH, post(post_recall_all))
        .route(WIPE_USER_PATH, post(post_wipe_user))
        .route(
            STREAMER_ROOM_DEACTIVATE_PATH,
            post(post_streamer_room_deactivate),
        )
        .route(P2P_INSTANCES_PATH, post(post_p2p_instances))
        .route(MARKET_SELL_PATH, post(post_sell))
        .route(MARKET_CANCEL_PATH, post(post_cancel))
        .route(MARKET_RESERVE_PATH, post(post_reserve))
        .route(MARKET_CANCEL_RESERVE_PATH, post(post_cancel_reserve))
        .route(MARKET_BUY_PATH, post(post_buy))
        .route(MARKET_BUY_CACHED_PATH, post(post_buy_cached))
        .route(MARKET_CLAIM_PROCEEDS_PATH, post(post_claim_proceeds))
        .route(MARKET_CLAIM_ALL_PATH, post(post_claim_all))
        .route(MARKET_CLAIM_ITEM_PATH, post(post_claim_item))
        .route(MARKET_RECLAIM_PATH, post(post_reclaim))
        .route(MARKET_LISTINGS_PATH, post(post_listings))
        .route(MARKET_MY_LISTINGS_PATH, post(post_my_listings))
        .route(MARKET_CUSTODY_PATH, post(post_custody))
        .route(MARKET_SELLABLE_STOCK_PATH, post(post_sellable_stock))
        .route(MARKET_HISTORY_PATH, post(post_history))
        .route(MARKET_STATE_PATH, post(post_state))
        .route(MARKET_ADMIN_LISTINGS_PATH, post(post_admin_listings))
        .route(SHOP_CHECKOUT_PATH, post(post_shop_checkout))
        .route(MERGE_EXECUTE_PATH, post(post_merge_execute))
        .route(WHEEL_PAID_SPIN_PATH, post(post_wheel_paid_spin))
        .route(WHEEL_REDEEM_CODE_PATH, post(post_wheel_redeem_code))
        .route(WHEEL_ROLL_PATH, post(post_wheel_roll))
        .route(ROLETA_CLAIM_PATH, post(post_roleta_claim))
        .route(WHEEL_ADMIN_PRIZES_PATH, post(post_admin_wheel_prizes_list))
        .route(
            WHEEL_ADMIN_PRIZES_REPLACE_PATH,
            post(post_admin_wheel_prizes_replace),
        )
        .route(
            WHEEL_ADMIN_RUNTIME_CONFIG_PATH,
            post(post_admin_wheel_runtime_config_get),
        )
        .route(
            WHEEL_ADMIN_RUNTIME_CONFIG_SET_PATH,
            post(post_admin_wheel_runtime_config_set),
        )
        .route(WHEEL_ADMIN_PLAYERS_PATH, post(post_admin_wheel_players_list))
        .route(
            WHEEL_ADMIN_PLAYERS_ADD_PATH,
            post(post_admin_wheel_players_add),
        )
        .route(
            WHEEL_ADMIN_PLAYERS_REMOVE_PATH,
            post(post_admin_wheel_players_remove),
        )
        .route(LUCKY_BOX_BUY_PATH, post(post_lucky_box_buy))
        .route(LUCKY_BOX_OPEN_PATH, post(post_lucky_box_open))
        .route(
            LUCKY_BOX_PROMO_REDEEM_PATH,
            post(post_lucky_box_promo_redeem),
        )
        .route(ROOM_PURCHASE_SLOT_PATH, post(post_rooms_purchase_slot))
        .route(UPGRADE_PACKAGE_PURCHASE_PATH, post(post_upgrades_purchase))
        .route(
            CATALOG_UPGRADES_REPLACE_PATH,
            post(post_catalog_upgrades_replace),
        )
        .route(ACCESS_LEVELS_REPLACE_PATH, post(post_access_levels_replace))
        .route(LOOT_BOXES_UPSERT_PATH, post(post_loot_boxes_upsert))
        .route(LOOT_BOXES_DELETE_PATH, post(post_loot_box_delete))
        .route(LOOT_BOX_REDEMPTIONS_PATH, post(post_loot_box_redemptions))
        .route(ADMIN_USER_BOXES_PATH, post(post_admin_user_boxes))
        .route(ADMIN_DELETE_USER_BOX_PATH, post(post_admin_delete_user_box))
        .route(MINING_COINS_UPSERT_PATH, post(post_mining_coins_upsert))
        .route(MINING_COINS_ECONOMY_SETTINGS_PATH, post(post_mining_coins_economy_settings))
        .route(MINING_COINS_SET_ACTIVE_PATH, post(post_mining_coins_set_active))
        .route(NEWS_UPSERT_PATH, post(post_news_upsert))
        .route(NEWS_DELETE_PATH, post(post_news_delete))
        .route(NEWS_FEE_PERSIST_PATH, post(post_news_fee_persist))
        .route(
            NEWS_EXPIRE_DAYS_PERSIST_PATH,
            post(post_news_expire_days_persist),
        )
        .route(SEASON_PASSES_REPLACE_PATH, post(post_season_passes_replace))
        .route(RIG_ROOMS_UPSERT_PATH, post(post_rig_rooms_upsert))
        .merge(crate::player_reads::http::routes())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_worker_auth,
        ));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn require_worker_auth(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    match state.cfg.mining_worker_auth_token.as_deref() {
        Some(expected) => {
            let provided = request
                .headers()
                .get(MINING_WORKER_AUTH_HEADER)
                .and_then(|v| v.to_str().ok());
            if provided != Some(expected) {
                return Err(StatusCode::UNAUTHORIZED);
            }
        }
        None => {}
    }
    Ok(next.run(request).await)
}

async fn post_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PersistRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware persist pool");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(OkBody {
                    ok: false,
                    error: Some("pool".into()),
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            );
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware persist begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(OkBody {
                    ok: false,
                    error: Some("begin".into()),
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            );
        }
    };
    let input = PersistInput {
        user_id: body.user_id,
        stock: body.stock,
        stock_mode: StockMode::parse(body.stock_mode.as_deref()),
        stored_batteries: body.stored_batteries,
        placed_racks: body.placed_racks,
    };
    match persist_hardware(&tx, input).await {
        Ok(()) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware persist commit");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(OkBody {
                        ok: false,
                        error: Some("commit".into()),
                        stock: None,
                        stored_batteries: None,
                        placed_racks: None,
                        ..Default::default()
                    }),
                );
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware persist failed");
            let _ = tx.rollback().await;
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(OkBody {
                    ok: false,
                    error: Some(e.to_string()),
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
    }
}

async fn post_credit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreditRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware credit pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware credit begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    match credit_stock(
        &tx,
        body.user_id,
        &body.item_id,
        body.qty,
        body.duration_amount,
        body.duration_unit.as_deref(),
    )
    .await
    {
        Ok(()) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware credit commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware credit failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_adjust(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdjustRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware adjust pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware adjust begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    let debit: Vec<AdjustLine> = body
        .debit
        .into_iter()
        .map(|l| AdjustLine {
            item_id: l.item_id,
            qty: l.qty,
        })
        .collect();
    let credit: Vec<AdjustLine> = body
        .credit
        .into_iter()
        .map(|l| AdjustLine {
            item_id: l.item_id,
            qty: l.qty,
        })
        .collect();
    match adjust_stock(&tx, body.user_id, &debit, &credit).await {
        Ok(stock) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware adjust commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: Some(stock),
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware adjust failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_fold_warehouse(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FoldWarehouseRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware fold-warehouse pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware fold-warehouse begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    match fold_warehouse_ids(&tx, body.user_id, &body.battery_ids).await {
        Ok(stock) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware fold-warehouse commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: Some(stock),
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware fold-warehouse failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_bulk_batteries(
    State(state): State<Arc<AppState>>,
    Json(body): Json<crate::bulk_batteries::BulkBatteriesRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::bulk_batteries::run_bulk_batteries(&state.pool, body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => {
            let status =
                StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, Json(e.body))
        }
    }
}

async fn post_racks_power(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RacksPowerRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware racks-power pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware racks-power begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    match apply_racks_power(&tx, &body).await {
        Ok(()) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware racks-power commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(RacksPowerError::Domain(error)) => {
            let _ = tx.rollback().await;
            (
                StatusCode::BAD_REQUEST,
                Json(OkBody {
                    ok: false,
                    error: Some(error),
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            )
        }
        Err(RacksPowerError::Transport(e)) => {
            warn!(err = %e, "hardware racks-power failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        }
    }
}

async fn post_recall_all(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<RecallAllRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware recall-all pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware recall-all begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    match recall_all(&tx).await {
        Ok(out) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware recall-all commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    items_moved: Some(out.items_moved),
                    racks_processed: Some(out.racks_processed),
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware recall-all failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_p2p_instances(
    State(state): State<Arc<AppState>>,
    Json(body): Json<P2pInstancesRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware p2p-instances pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware p2p-instances begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    let input = P2pInstancesInput {
        user_id: body.user_id,
        item_id: &body.item_id,
        op: &body.op,
        qty: body.qty,
        to_user_id: body.to_user_id,
        instance_ids: body.instance_ids.as_deref(),
    };
    match p2p_instances(&tx, input).await {
        Ok(out) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware p2p-instances commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    stock: Some(out.stock),
                    instance_ids: Some(out.instance_ids),
                    codes: Some(out.codes),
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware p2p-instances failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_wipe_user(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WipeUserRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware wipe-user pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware wipe-user begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    match wipe_user(&tx, body.user_id).await {
        Ok(()) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware wipe-user commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware wipe-user failed");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

async fn post_streamer_room_deactivate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WipeUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "partners streamer-room deactivate pool");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": "pool" })),
            );
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "partners streamer-room deactivate begin");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": "begin" })),
            );
        }
    };
    match deactivate_streamer_room(&tx, body.user_id).await {
        Ok(removed) => {
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "partners streamer-room deactivate commit");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "ok": false, "error": "commit" })),
                );
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "roomId": STREAMER_ROOM_ID,
                    "removedRackCount": removed,
                })),
            )
        }
        Err(e) => {
            warn!(err = %e, "partners streamer-room deactivate failed");
            let _ = tx.rollback().await;
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            )
        }
    }
}

async fn post_intent(
    State(state): State<Arc<AppState>>,
    Json(body): Json<IntentRequest>,
) -> (StatusCode, Json<OkBody>) {
    let mut conn = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "hardware intent pool");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "pool");
        }
    };
    let tx = match conn.transaction().await {
        Ok(t) => t,
        Err(e) => {
            warn!(err = %e, "hardware intent begin");
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "begin");
        }
    };
    if let Err(e) = tx
        .execute(
            &format!("SET LOCAL statement_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
    {
        warn!(err = %e, "hardware intent timeout");
        let _ = tx.rollback().await;
        return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    if let Err(e) = tx
        .execute(
            &format!("SET LOCAL lock_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
    {
        warn!(err = %e, "hardware intent lock timeout");
        let _ = tx.rollback().await;
        return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }

    let keys = match validate_intent_idem_keys(&body.scope, &body.idempotency_key) {
        Ok(k) => k,
        Err(e) => {
            let _ = tx.rollback().await;
            return intent_idem_fail(e);
        }
    };
    match lookup_intent_idem(
        &tx,
        body.user_id,
        &keys,
        body.request_fingerprint.as_deref(),
    )
    .await
    {
        Ok(IntentIdemLookup::Replay(replay)) => {
            let _ = tx.rollback().await;
            return (
                StatusCode::OK,
                Json(OkBody {
                    ok: replay.ok,
                    error: None,
                    stock: replay.stock,
                    stored_batteries: replay.stored_batteries,
                    placed_racks: replay.placed_racks,
                    ..Default::default()
                }),
            );
        }
        Ok(IntentIdemLookup::Miss) => {}
        Err(e) => {
            let _ = tx.rollback().await;
            return intent_idem_fail(e);
        }
    }

    let now_ms = current_unix_ms();
    if let Err(e) = expire_user_asic_leases(&tx, body.user_id, now_ms).await {
        warn!(err = %e, "hardware intent expire leases");
        let _ = tx.rollback().await;
        return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }

    let prev = match load_hardware_state(&tx, body.user_id).await {
        Ok(s) => s,
        Err(e) => {
            warn!(err = %e, "hardware intent load");
            let _ = tx.rollback().await;
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    };
    let upgrades = match load_upgrades_with_compat(&tx).await {
        Ok(u) => u,
        Err(e) => {
            warn!(err = %e, "hardware intent upgrades");
            let _ = tx.rollback().await;
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    };
    let nft_ids = resolve_nft_room_ids(&tx)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_nft_room_ids());
    let asic_ids = resolve_asic_room_ids(&tx)
        .await
        .unwrap_or_else(|_| genesis_core::hardware::room::default_asic_room_ids());

    let mut prev = prev;
    if let Err(e) = sanitize_placed_racks_nft_auto_room(
        &tx,
        body.user_id,
        &mut prev,
        &nft_ids,
        &asic_ids,
        &upgrades,
        now_ms,
    )
    .await
    {
        warn!(err = %e, "hardware intent sanitize");
        let _ = tx.rollback().await;
        return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }

    let applied = apply_intent(&body, &prev, &upgrades, Some(&nft_ids), Some(&asic_ids));
    let HardwareApplyResult::Ok(mut ok) = applied else {
        let HardwareApplyResult::Err(err) = applied else {
            unreachable!();
        };
        let _ = tx.rollback().await;
        return (
            StatusCode::BAD_REQUEST,
            Json(OkBody {
                ok: false,
                error: Some(err.error),
                stock: None,
                stored_batteries: None,
                placed_racks: None,
                ..Default::default()
            }),
        );
    };

    let post_input = PostApplyInput {
        user_id: body.user_id,
        kind: &body.kind,
        rack_id: body.rack_id.as_deref(),
        catalog_item_id: body.catalog_item_id.as_deref(),
        room_id: body.room_id.as_deref(),
        slot_index: body.slot_index,
    };
    match run_post_apply(&tx, &post_input, &prev, &mut ok, now_ms).await {
        Ok(()) => {}
        Err(PostApplyError::Domain(error)) => {
            let _ = tx.rollback().await;
            return (
                StatusCode::BAD_REQUEST,
                Json(OkBody {
                    ok: false,
                    error: Some(error),
                    stock: None,
                    stored_batteries: None,
                    placed_racks: None,
                    ..Default::default()
                }),
            );
        }
        Err(PostApplyError::Transport(e)) => {
            warn!(err = %e, "hardware intent postApply");
            let _ = tx.rollback().await;
            return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }

    strip_nft_coins_before_persist(&mut ok, &nft_ids);
    if let Err(e) = validate_placed_racks_for_save(&tx, &ok.placed_racks, &nft_ids, &asic_ids).await
    {
        match e {
            PostApplyError::Domain(error) => {
                let _ = tx.rollback().await;
                return (
                    StatusCode::BAD_REQUEST,
                    Json(OkBody {
                        ok: false,
                        error: Some(error),
                        stock: None,
                        stored_batteries: None,
                        placed_racks: None,
                        ..Default::default()
                    }),
                );
            }
            PostApplyError::Transport(err) => {
                warn!(err = %err, "hardware intent validate");
                let _ = tx.rollback().await;
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
            }
        }
    }

    let input = PersistInput {
        user_id: body.user_id,
        stock: Some(ok.stock.clone()),
        stock_mode: StockMode::Snapshot,
        stored_batteries: Some(ok.stored_batteries.clone()),
        placed_racks: Some(ok.placed_racks.clone()),
    };
    match persist_hardware(&tx, input).await {
        Ok(()) => {
            let stored_ms = current_unix_ms();
            let stored = build_success_response_json(
                &ok.stock,
                &ok.stored_batteries,
                &ok.placed_racks,
                &keys.scope,
                body.rack_id.as_deref().unwrap_or(""),
                body.request_fingerprint.as_deref(),
                stored_ms,
            );
            if let Err(e) = insert_intent_idem_success(&tx, body.user_id, &keys, &stored).await {
                let _ = tx.rollback().await;
                return intent_idem_fail(e);
            }
            if let Err(e) = tx.commit().await {
                warn!(err = %e, "hardware intent commit");
                return fail_body(StatusCode::INTERNAL_SERVER_ERROR, "commit");
            }
            (
                StatusCode::OK,
                Json(OkBody {
                    ok: true,
                    error: None,
                    stock: Some(ok.stock),
                    stored_batteries: Some(ok.stored_batteries),
                    placed_racks: Some(ok.placed_racks),
                    ..Default::default()
                }),
            )
        }
        Err(e) => {
            warn!(err = %e, "hardware intent persist");
            let _ = tx.rollback().await;
            fail_body(StatusCode::UNPROCESSABLE_ENTITY, &e.to_string())
        }
    }
}

fn apply_intent(
    body: &IntentRequest,
    prev: &genesis_core::hardware::types::HardwareState,
    upgrades: &[genesis_core::hardware::types::UpgradeRow],
    nft_ids: Option<&std::collections::HashSet<String>>,
    asic_ids: Option<&std::collections::HashSet<String>>,
) -> HardwareApplyResult {
    let kind = body.kind.trim().to_ascii_lowercase();
    match kind.as_str() {
        "place" => apply_place_rack_from_stock(
            prev,
            body.catalog_item_id.as_deref().unwrap_or(""),
            body.room_id.as_deref().unwrap_or(""),
            body.slot_index.unwrap_or(0),
            upgrades,
            nft_ids,
            asic_ids,
        ),
        "remove" => {
            apply_remove_rack_to_stock(prev, body.rack_id.as_deref().unwrap_or(""), upgrades, None)
        }
        "miner_equip" => apply_rack_miner_equip(
            prev,
            body.rack_id.as_deref().unwrap_or(""),
            body.slot_index.unwrap_or(0),
            body.catalog_item_id.as_deref().unwrap_or(""),
            upgrades,
            nft_ids,
            asic_ids,
        ),
        "miner_unequip" => apply_rack_miner_unequip(
            prev,
            body.rack_id.as_deref().unwrap_or(""),
            body.slot_index.unwrap_or(0),
            upgrades,
        ),
        "aux_equip" => {
            let Some(input) = parse_aux_equip(body) else {
                return HardwareApplyResult::fail("Invalid aux equip body.");
            };
            apply_rack_aux_equip(
                prev,
                body.rack_id.as_deref().unwrap_or(""),
                &input,
                upgrades,
                None,
            )
        }
        "aux_unequip" => {
            let Some(input) = parse_aux_unequip(body) else {
                return HardwareApplyResult::fail("Invalid aux unequip body.");
            };
            apply_rack_aux_unequip(
                prev,
                body.rack_id.as_deref().unwrap_or(""),
                &input,
                upgrades,
                None,
            )
        }
        _ => HardwareApplyResult::fail("Unknown intent kind."),
    }
}

fn parse_aux_equip(body: &IntentRequest) -> Option<AuxEquipInput> {
    let kind = body
        .aux_kind
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match kind.as_str() {
        "battery" => {
            let mode = body
                .battery_mode
                .as_deref()
                .unwrap_or("from_stock")
                .trim()
                .to_ascii_lowercase();
            if mode == "from_warehouse" {
                Some(AuxEquipInput::BatteryFromWarehouse {
                    stored_battery_id: body.stored_battery_id.clone().unwrap_or_default(),
                })
            } else {
                Some(AuxEquipInput::BatteryFromStock {
                    catalog_item_id: body.catalog_item_id.clone().unwrap_or_default(),
                })
            }
        }
        "wiring" => Some(AuxEquipInput::Wiring {
            catalog_item_id: body.catalog_item_id.clone().unwrap_or_default(),
        }),
        "multiplier" => Some(AuxEquipInput::Multiplier {
            catalog_item_id: body.catalog_item_id.clone().unwrap_or_default(),
            multiplier_slot_index: body.multiplier_slot_index.unwrap_or(0),
        }),
        _ => None,
    }
}

fn parse_aux_unequip(body: &IntentRequest) -> Option<AuxUnequipInput> {
    let kind = body
        .aux_kind
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match kind.as_str() {
        "battery" => Some(AuxUnequipInput::Battery),
        "wiring" => Some(AuxUnequipInput::Wiring),
        "multiplier" => Some(AuxUnequipInput::Multiplier {
            multiplier_slot_index: body.multiplier_slot_index.unwrap_or(0),
        }),
        _ => None,
    }
}

fn fail_body(status: StatusCode, error: &str) -> (StatusCode, Json<OkBody>) {
    (
        status,
        Json(OkBody {
            ok: false,
            error: Some(error.to_string()),
            ..Default::default()
        }),
    )
}

fn intent_idem_fail(e: IntentIdemError) -> (StatusCode, Json<OkBody>) {
    match e {
        IntentIdemError::Domain { http_status, error } => {
            let status = if http_status == HTTP_CONFLICT {
                StatusCode::CONFLICT
            } else if http_status == HTTP_BAD_REQUEST {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::BAD_REQUEST
            };
            fail_body(status, &error)
        }
        IntentIdemError::Transport(err) => {
            warn!(err = %err, "hardware intent idem");
            fail_body(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string())
        }
    }
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let port = state.cfg.hardware_worker_port;
    if state.cfg.mining_worker_auth_token.is_none() {
        warn!(
            event = "auth_disabled",
            "MINING_WORKER_AUTH_TOKEN unset — hardware HTTP auth disabled (dev only)"
        );
    } else {
        info!(
            event = "auth_enabled",
            "hardware worker HTTP requires {}", MINING_WORKER_AUTH_HEADER
        );
    }
    let app = router(state);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "hardware worker HTTP listening");
    axum::serve(listener, app).await?;
    Ok(())
}
