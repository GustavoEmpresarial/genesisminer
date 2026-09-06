//! Axum handlers for `/v1/lucky-boxes/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::warn;

use crate::http::AppState;

use super::buy::{buy, BuyOutcome};
use super::errors::LuckyBoxError;
use super::open::{open, OpenOutcome, OpenReward};
use super::promo_redeem::promo_redeem;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuckyBoxBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty_purchased: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<Vec<RewardJson>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gained_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardJson {
    #[serde(rename = "type")]
    pub reward_type: String,
    pub id: String,
    pub qty: f64,
}

impl From<OpenReward> for RewardJson {
    fn from(r: OpenReward) -> Self {
        Self {
            reward_type: r.reward_type,
            id: r.id,
            qty: r.qty,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyRequest {
    pub user_id: i64,
    pub box_id: String,
    pub qty: Option<i32>,
    pub idempotency_key: String,
    pub idempotency_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub user_id: i64,
    pub box_id: String,
    pub idempotency_key: String,
    pub idempotency_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoRedeemRequest {
    pub user_id: i64,
    pub code: String,
    pub idempotency_key: Option<String>,
    pub server_now_ms: Option<i64>,
}

fn lucky_fail(e: LuckyBoxError) -> (StatusCode, Json<LuckyBoxBody>) {
    match e {
        LuckyBoxError::Domain {
            status,
            error,
            code,
            missing,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(LuckyBoxBody {
                    ok: false,
                    error: Some(error),
                    code,
                    missing,
                    ..Default::default()
                }),
            )
        }
        LuckyBoxError::Transport(err) => {
            warn!(err = %err, "lucky-box transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(LuckyBoxBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn lucky_fail_value(e: LuckyBoxError) -> (StatusCode, Json<Value>) {
    match e {
        LuckyBoxError::Domain {
            status,
            error,
            code,
            missing,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            let mut body = json!({ "ok": false, "error": error });
            if let Some(c) = code {
                body["code"] = json!(c);
            }
            if let Some(m) = missing {
                body["missing"] = json!(m);
            }
            (sc, Json(body))
        }
        LuckyBoxError::Transport(err) => {
            warn!(err = %err, "lucky-box transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
        }
    }
}

fn ok_buy(out: BuyOutcome) -> (StatusCode, Json<LuckyBoxBody>) {
    (
        StatusCode::OK,
        Json(LuckyBoxBody {
            ok: true,
            new_usdc: Some(out.new_usdc),
            box_name: Some(out.box_name),
            trigger: Some(out.trigger),
            price: Some(out.price),
            qty_purchased: Some(out.qty_purchased),
            cached: if out.cached { Some(true) } else { None },
            ..Default::default()
        }),
    )
}

fn ok_open(out: OpenOutcome) -> (StatusCode, Json<LuckyBoxBody>) {
    (
        StatusCode::OK,
        Json(LuckyBoxBody {
            ok: true,
            rewards: Some(out.rewards.into_iter().map(RewardJson::from).collect()),
            gained_usdc: Some(out.gained_usdc),
            box_name: Some(out.box_name),
            opening_id: Some(out.opening_id),
            cached: if out.cached { Some(true) } else { None },
            ..Default::default()
        }),
    )
}

pub async fn post_buy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BuyRequest>,
) -> (StatusCode, Json<LuckyBoxBody>) {
    match buy(
        &state.pool,
        body.user_id,
        &body.box_id,
        body.qty,
        &body.idempotency_key,
        body.idempotency_fingerprint.as_deref(),
    )
    .await
    {
        Ok(out) => ok_buy(out),
        Err(e) => lucky_fail(e),
    }
}

pub async fn post_open(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OpenRequest>,
) -> (StatusCode, Json<LuckyBoxBody>) {
    match open(
        &state.pool,
        body.user_id,
        &body.box_id,
        &body.idempotency_key,
        body.idempotency_fingerprint.as_deref(),
    )
    .await
    {
        Ok(out) => ok_open(out),
        Err(e) => lucky_fail(e),
    }
}

pub async fn post_promo_redeem(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PromoRedeemRequest>,
) -> (StatusCode, Json<Value>) {
    match promo_redeem(
        &state.pool,
        body.user_id,
        &body.code,
        body.idempotency_key.as_deref(),
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => {
            let sc = StatusCode::from_u16(out.status).unwrap_or(StatusCode::OK);
            (sc, Json(out.body))
        }
        Err(e) => lucky_fail_value(e),
    }
}
