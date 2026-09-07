//! Axum HTTP surface for Node → Rust wallet money TXs.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::admin_balances::{
    run_admin_bulk_coin_balance, run_admin_save_game_balances, run_admin_set_coin_balance,
    ADMIN_BULK_COIN_BALANCE_PATH, ADMIN_SAVE_GAME_BALANCES_PATH, ADMIN_SET_COIN_BALANCE_PATH,
};
use crate::admin_web3::{
    post_wallet_labels_list, post_wallet_labels_upsert, post_web3_settings_persist,
    WALLET_LABELS_LIST_PATH, WALLET_LABELS_UPSERT_PATH, WEB3_SETTINGS_PERSIST_PATH,
};
use crate::admin_withdrawal_status::{
    run_admin_withdrawal_status, run_admin_withdrawals_list, ADMIN_WITHDRAWALS_LIST_PATH,
    ADMIN_WITHDRAWAL_STATUS_PATH,
};
use crate::config::{WorkerConfig, MINING_WORKER_AUTH_HEADER};
use crate::treasury_token_txs::{run_treasury_token_txs, TreasuryTokenTxsQuery, TREASURY_TOKEN_TXS_PATH};
use crate::deposit::{run_deposit_credit, DEPOSIT_CREDIT_PATH};
use crate::deposit_receipt::{
    run_resolve_deposit_receipt, DepositSettingsPayload, DEPOSIT_RESOLVE_RECEIPT_PATH,
};
use crate::deposit_verify::{run_deposit_verify, DepositVerifyRequest, DEPOSIT_VERIFY_PATH};
use crate::errors::WalletError;
use crate::exchange::{run_exchange_liquidation, EXCHANGE_LIQUIDATE_PATH};
use crate::partner_youtube_approve::{run_partner_youtube_approve, PARTNER_YOUTUBE_APPROVE_PATH};
use crate::player_reads::{
    run_deposits_history, run_wallet_history, run_wallet_state, run_web3_settings,
    run_withdrawals_history, WalletUserRequest, DEPOSITS_HISTORY_PATH, WALLET_HISTORY_PATH,
    WALLET_STATE_PATH, WEB3_SETTINGS_PATH, WITHDRAWALS_HISTORY_PATH,
};
use crate::quest_claim::{run_quest_claim, QUEST_CLAIM_PATH};
use crate::referral_credit::{run_referral_credit_on_email_verified, REFERRAL_CREDIT_PATH};
use crate::withdraw::{run_withdraw_request, WITHDRAW_REQUEST_PATH};
use crate::zerads_credit::{run_zerads_credit, ZERADS_CREDIT_PATH};
use crate::zerads_offerwall::{
    run_zerads_callback, run_zerads_stats, run_zerads_token, ZeradsCallbackRequest,
    ZeradsUserRequest, ZERADS_CALLBACK_PATH, ZERADS_STATS_PATH, ZERADS_TOKEN_PATH,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub cfg: WorkerConfig,
    pub http: reqwest::Client,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_reload: Option<bool>,
    // liquidate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sold_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gross_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_coin_balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_replay: Option<bool>,
    // withdraw
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    // deposit
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_contract: Option<String>,
    // quest claim
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_usdc: Option<f64>,
    // referral credit
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credited_usdc: Option<f64>,
    // zerads credit
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_split: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_usdc: Option<f64>,
    // partner youtube approve
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidateRequest {
    pub user_id: i64,
    pub coin_id: String,
    pub fraction: f64,
    pub fraction_mode: String,
    pub min_usdc: f64,
    pub fee_percent: f64,
    pub idempotency_key: Option<String>,
    pub idempotency_scope: String,
    pub server_now_ms: Option<i64>,
    pub request_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawRequest {
    pub user_id: i64,
    pub coin_id: String,
    pub amount: f64,
    pub wallet_address: String,
    pub idempotency_key: String,
    /// genesis-api forwards the raw client body (no fingerprint); when absent the
    /// worker derives a deterministic one from the request params.
    #[serde(default)]
    pub request_fingerprint: String,
    pub server_now_ms: Option<i64>,
    pub withdraw_tokens_raw: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositCreditRequest {
    pub user_id: i64,
    pub tx_hash: String,
    pub network: String,
    pub amount_usdc: f64,
    pub wallet_address: String,
    pub token_contract: Option<String>,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositResolveReceiptRequest {
    pub tx_hash: String,
    pub network: String,
    pub settings: DepositSettingsPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestClaimRequest {
    pub user_id: i64,
    pub quest_id: String,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralCreditRequest {
    pub verified_user_id: i64,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZeradsCreditRequest {
    pub user_id: i64,
    pub amount_zer: f64,
    pub clicks: i32,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWithdrawalStatusRequest {
    pub request_id: String,
    pub status: String,
    pub tx_hash: Option<String>,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSetCoinBalanceRequest {
    pub user_id: i64,
    pub coin_id: String,
    pub amount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBulkCoinBalanceRequest {
    pub coin_id: String,
    pub amount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSaveGameBalancesRequest {
    pub user_id: i64,
    pub usdc: Option<f64>,
    pub coin_balances: Option<HashMap<String, f64>>,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerYoutubeApproveRequest {
    pub id: String,
    pub admin_user_id: i64,
    pub reviewed_at: Option<i64>,
}

fn wallet_fail(e: WalletError) -> (StatusCode, Json<WalletBody>) {
    match e {
        WalletError::Domain {
            status,
            error,
            code,
            force_reload,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(WalletBody {
                    ok: false,
                    error: Some(error),
                    code,
                    force_reload,
                    ..Default::default()
                }),
            )
        }
        WalletError::Transport(err) => {
            warn!(err = %err, "wallet transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(WalletBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn router(state: AppState) -> Router {
    let state = Arc::new(state);
    let protected = Router::new()
        .route(EXCHANGE_LIQUIDATE_PATH, post(post_liquidate))
        .route(WITHDRAW_REQUEST_PATH, post(post_withdraw))
        .route(DEPOSIT_CREDIT_PATH, post(post_deposit_credit))
        .route(
            DEPOSIT_RESOLVE_RECEIPT_PATH,
            post(post_deposit_resolve_receipt),
        )
        .route(DEPOSIT_VERIFY_PATH, post(post_deposit_verify))
        .route(QUEST_CLAIM_PATH, post(post_quest_claim))
        .route(ZERADS_TOKEN_PATH, post(post_zerads_token))
        .route(ZERADS_STATS_PATH, post(post_zerads_stats))
        .route(ZERADS_CALLBACK_PATH, post(post_zerads_callback))
        .route(REFERRAL_CREDIT_PATH, post(post_referral_credit))
        .route(ZERADS_CREDIT_PATH, post(post_zerads_credit))
        .route(
            ADMIN_WITHDRAWAL_STATUS_PATH,
            post(post_admin_withdrawal_status),
        )
        .route(
            ADMIN_SET_COIN_BALANCE_PATH,
            post(post_admin_set_coin_balance),
        )
        .route(
            ADMIN_BULK_COIN_BALANCE_PATH,
            post(post_admin_bulk_coin_balance),
        )
        .route(ADMIN_WITHDRAWALS_LIST_PATH, post(post_admin_withdrawals_list))
        .route(
            ADMIN_SAVE_GAME_BALANCES_PATH,
            post(post_admin_save_game_balances),
        )
        .route(
            PARTNER_YOUTUBE_APPROVE_PATH,
            post(post_partner_youtube_approve),
        )
        .route(WALLET_STATE_PATH, post(post_wallet_state))
        .route(WALLET_HISTORY_PATH, post(post_wallet_history))
        .route(WITHDRAWALS_HISTORY_PATH, post(post_withdrawals_history))
        .route(DEPOSITS_HISTORY_PATH, post(post_deposits_history))
        .route(WEB3_SETTINGS_PATH, post(post_web3_settings))
        .route(WEB3_SETTINGS_PERSIST_PATH, post(post_web3_settings_persist))
        .route(WALLET_LABELS_LIST_PATH, post(post_wallet_labels_list))
        .route(WALLET_LABELS_UPSERT_PATH, post(post_wallet_labels_upsert))
        .route(TREASURY_TOKEN_TXS_PATH, post(post_treasury_token_txs))
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

fn player_read_ok(v: serde_json::Value) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::OK, Json(v))
}

fn player_read_fail(
    e: crate::player_reads::PlayerReadError,
) -> (StatusCode, Json<serde_json::Value>) {
    let status = StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": e.error })),
    )
}

async fn post_wallet_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WalletUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_wallet_state(&state.pool, body.user_id).await {
        Ok(v) => player_read_ok(v),
        Err(e) => player_read_fail(e),
    }
}

async fn post_wallet_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WalletUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_wallet_history(&state.pool, body.user_id, body.limit).await {
        Ok(v) => player_read_ok(v),
        Err(e) => player_read_fail(e),
    }
}

async fn post_withdrawals_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WalletUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_withdrawals_history(&state.pool, body.user_id, body.limit).await {
        Ok(v) => player_read_ok(v),
        Err(e) => player_read_fail(e),
    }
}

async fn post_deposits_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WalletUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_deposits_history(&state.pool, body.user_id, body.limit).await {
        Ok(v) => player_read_ok(v),
        Err(e) => player_read_fail(e),
    }
}

async fn post_web3_settings(
    State(state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_web3_settings(&state.pool).await {
        Ok(v) => player_read_ok(v),
        Err(e) => player_read_fail(e),
    }
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

async fn post_liquidate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LiquidateRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_exchange_liquidation(
        &state.pool,
        body.user_id,
        &body.coin_id,
        body.fraction,
        &body.fraction_mode,
        body.min_usdc,
        body.fee_percent,
        body.idempotency_key.as_deref(),
        &body.idempotency_scope,
        body.server_now_ms,
        body.request_fingerprint.as_deref(),
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                sold_amount: Some(out.sold_amount),
                gross_usdc: Some(out.gross_usdc),
                fee_usdc: Some(out.fee_usdc),
                net_usdc: Some(out.net_usdc),
                new_usdc: Some(out.new_usdc),
                new_coin_balance: Some(out.new_coin_balance),
                idempotent_replay: Some(out.idempotent_replay),
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_withdraw(
    State(state): State<Arc<AppState>>,
    Json(body): Json<WithdrawRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_withdraw_request(
        &state.pool,
        body.user_id,
        &body.coin_id,
        body.amount,
        &body.wallet_address,
        &body.idempotency_key,
        &body.request_fingerprint,
        body.server_now_ms,
        body.withdraw_tokens_raw.as_deref(),
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                request_id: Some(out.request_id),
                message: Some(out.message),
                idempotent_replay: if out.idempotent_replay {
                    Some(true)
                } else {
                    None
                },
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_deposit_credit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DepositCreditRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_deposit_credit(
        &state.pool,
        body.user_id,
        &body.tx_hash,
        &body.network,
        body.amount_usdc,
        &body.wallet_address,
        body.token_contract.as_deref(),
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                amount: Some(out.amount),
                new_usdc: Some(out.new_usdc),
                already: out.already,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreasuryTokenTxsBody {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    offset: Option<String>,
    #[serde(default)]
    address: Option<String>,
}

async fn post_treasury_token_txs(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TreasuryTokenTxsBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let q = TreasuryTokenTxsQuery {
        page: body.page,
        offset: body.offset,
        address: body.address,
    };
    match run_treasury_token_txs(&state.pool, &state.http, &q).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => {
            let (sc, Json(fail)) = wallet_fail(e);
            (sc, Json(serde_json::json!({ "error": fail.error })))
        }
    }
}

async fn post_deposit_verify(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DepositVerifyRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_deposit_verify(&state.pool, &state.http, body).await {
        Ok(out) => {
            let sc = StatusCode::from_u16(out.status).unwrap_or(StatusCode::OK);
            (sc, Json(out.body))
        }
        Err(e) => {
            let (sc, Json(fail)) = wallet_fail(e);
            (
                sc,
                Json(serde_json::json!({
                    "ok": fail.ok,
                    "error": fail.error,
                    "code": fail.code
                })),
            )
        }
    }
}

async fn post_deposit_resolve_receipt(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DepositResolveReceiptRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_resolve_deposit_receipt(&state.http, &body.tx_hash, &body.network, &body.settings)
        .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                pending: out.pending,
                network: out.network,
                amount_usdc: out.amount_usdc,
                wallet_address: out.wallet_address,
                token_contract: out.token_contract,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_quest_claim(
    State(state): State<Arc<AppState>>,
    Json(body): Json<QuestClaimRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_quest_claim(
        &state.pool,
        body.user_id,
        &body.quest_id,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                reward_usdc: Some(out.reward_usdc),
                new_usdc: Some(out.new_usdc),
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_referral_credit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReferralCreditRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_referral_credit_on_email_verified(
        &state.pool,
        body.verified_user_id,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                skipped: out.skipped,
                credited_usdc: out.credited_usdc,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_zerads_token(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ZeradsUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_zerads_token(&state.pool, body.user_id).await {
        Ok(v) => player_read_ok(v),
        Err(e) => {
            let (sc, Json(fail)) = wallet_fail(e);
            (
                sc,
                Json(serde_json::json!({
                    "ok": fail.ok,
                    "error": fail.error,
                    "code": fail.code
                })),
            )
        }
    }
}

async fn post_zerads_stats(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ZeradsUserRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_zerads_stats(&state.pool, body.user_id).await {
        Ok(v) => player_read_ok(v),
        Err(e) => {
            let (sc, Json(fail)) = wallet_fail(e);
            (
                sc,
                Json(serde_json::json!({
                    "ok": fail.ok,
                    "error": fail.error,
                    "code": fail.code
                })),
            )
        }
    }
}

async fn post_zerads_callback(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ZeradsCallbackRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let out = run_zerads_callback(&state.pool, body).await;
    let sc = StatusCode::from_u16(out.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (sc, Json(out.body))
}

async fn post_zerads_credit(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ZeradsCreditRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_zerads_credit(
        &state.pool,
        body.user_id,
        body.amount_zer,
        body.clicks,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                duplicate: Some(out.duplicate),
                idempotency_key: Some(out.idempotency_key),
                rate: out.rate,
                user_split: out.user_split,
                total_usdc: out.total_usdc,
                user_usdc: out.user_usdc,
                platform_usdc: out.platform_usdc,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_admin_withdrawal_status(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminWithdrawalStatusRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_admin_withdrawal_status(
        &state.pool,
        &body.request_id,
        &body.status,
        body.tx_hash.as_deref(),
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                message: Some(out.message),
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_admin_set_coin_balance(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminSetCoinBalanceRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_admin_set_coin_balance(&state.pool, body.user_id, &body.coin_id, body.amount).await {
        Ok(_) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_admin_bulk_coin_balance(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminBulkCoinBalanceRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_admin_bulk_coin_balance(&state.pool, &body.coin_id, body.amount).await {
        Ok(out) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "count": out.count })),
        ),
        Err(e) => {
            let (sc, body) = wallet_fail(e);
            (sc, Json(serde_json::to_value(&body.0).unwrap_or_else(|_| serde_json::json!({ "ok": false }))))
        }
    }
}

async fn post_admin_withdrawals_list(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<serde_json::Value>) {
    match run_admin_withdrawals_list(&state.pool).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => {
            let (sc, body) = wallet_fail(e);
            (sc, Json(serde_json::to_value(&body.0).unwrap_or_else(|_| serde_json::json!({ "ok": false }))))
        }
    }
}

async fn post_admin_save_game_balances(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AdminSaveGameBalancesRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_admin_save_game_balances(
        &state.pool,
        body.user_id,
        body.usdc,
        body.coin_balances,
        body.server_now_ms,
    )
    .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

async fn post_partner_youtube_approve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartnerYoutubeApproveRequest>,
) -> (StatusCode, Json<WalletBody>) {
    match run_partner_youtube_approve(&state.pool, &body.id, body.admin_user_id, body.reviewed_at)
        .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(WalletBody {
                ok: true,
                updated: Some(out.updated),
                ..Default::default()
            }),
        ),
        Err(e) => wallet_fail(e),
    }
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let port = state.cfg.wallet_worker_port;
    if state.cfg.mining_worker_auth_token.is_none() {
        warn!(
            event = "auth_disabled",
            "MINING_WORKER_AUTH_TOKEN unset — wallet HTTP auth disabled (dev only)"
        );
    } else {
        info!(
            event = "auth_enabled",
            "wallet worker HTTP requires {}", MINING_WORKER_AUTH_HEADER
        );
    }
    let app = router(state);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "wallet worker HTTP listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use crate::config::WALLET_WORKER_DEFAULT_PORT;

    fn test_state() -> AppState {
        // Pool unused for health — create unreachable URL pool is heavy; health does not touch it.
        // Use a dummy pool via deadpool only if needed; health route ignores state.pool.
        let mut pg = deadpool_postgres::Config::new();
        pg.url = Some("postgres://invalid:invalid@127.0.0.1:1/none".into());
        let pool = pg
            .create_pool(
                Some(deadpool_postgres::Runtime::Tokio1),
                tokio_postgres::NoTls,
            )
            .expect("pool");
        AppState {
            pool,
            cfg: WorkerConfig {
                database_url: "postgres://invalid".into(),
                wallet_worker_port: WALLET_WORKER_DEFAULT_PORT,
                mining_worker_auth_token: None,
            },
            http: reqwest::Client::new(),
        }
    }

    #[tokio::test]
    async fn health_is_public() {
        let app = router(test_state());
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
