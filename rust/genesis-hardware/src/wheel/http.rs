//! Axum handlers for `/v1/wheel/*` and `/v1/roleta/claim`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::warn;

use crate::http::AppState;

use super::claim::claim;
use super::errors::WheelError;
use super::paid_spin::{paid_spin, PaidSpinOutcome, WheelPrizeDto};
use super::promo_redeem::redeem_code;
use super::roll::roll;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub won_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<WheelPrizeJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charged_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_replay: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelPrizeJson {
    pub id: String,
    pub label: String,
    pub weight: f64,
    pub color: Option<String>,
    #[serde(rename = "item_id")]
    pub item_id: String,
    pub image: Option<String>,
}

impl From<WheelPrizeDto> for WheelPrizeJson {
    fn from(p: WheelPrizeDto) -> Self {
        Self {
            id: p.id,
            label: p.label,
            weight: p.weight,
            color: p.color,
            item_id: p.item_id,
            image: p.image,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidSpinRequest {
    pub user_id: i64,
    pub idempotency_key: String,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemCodeRequest {
    pub user_id: i64,
    pub code: String,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollRequest {
    pub user_id: i64,
    pub code: String,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    pub user_id: i64,
    pub code: String,
    pub won_item_id: String,
    pub server_now_ms: Option<i64>,
}

fn wheel_fail(e: WheelError) -> (StatusCode, Json<WheelBody>) {
    match e {
        WheelError::Domain {
            status,
            error,
            code,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(WheelBody {
                    ok: false,
                    error: Some(error),
                    code,
                    ..Default::default()
                }),
            )
        }
        WheelError::Transport(err) => {
            warn!(err = %err, "wheel transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(WheelBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn wheel_fail_value(e: WheelError) -> (StatusCode, Json<Value>) {
    match e {
        WheelError::Domain {
            status,
            error,
            code,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            let mut body = json!({ "ok": false, "error": error });
            if let Some(c) = code {
                body["code"] = json!(c);
            }
            (sc, Json(body))
        }
        WheelError::Transport(err) => {
            warn!(err = %err, "wheel transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
        }
    }
}

fn ok_paid_spin(out: PaidSpinOutcome) -> (StatusCode, Json<WheelBody>) {
    (
        StatusCode::OK,
        Json(WheelBody {
            ok: true,
            spin_id: Some(out.spin_id),
            won_item_id: Some(out.won_item_id),
            item: out.item.map(WheelPrizeJson::from),
            new_usdc: Some(out.new_usdc),
            charged_usdc: Some(out.charged_usdc),
            box_id: Some(out.box_id),
            box_name: Some(out.box_name),
            idempotent_replay: Some(out.idempotent_replay),
            ..Default::default()
        }),
    )
}

pub async fn post_paid_spin(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PaidSpinRequest>,
) -> (StatusCode, Json<WheelBody>) {
    match paid_spin(
        &state.pool,
        body.user_id,
        &body.idempotency_key,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => ok_paid_spin(out),
        Err(e) => wheel_fail(e),
    }
}

pub async fn post_redeem_code(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RedeemCodeRequest>,
) -> (StatusCode, Json<Value>) {
    match redeem_code(&state.pool, body.user_id, &body.code, body.server_now_ms).await {
        Ok(out) => (StatusCode::OK, Json(out.to_wheel_json())),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_roll(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RollRequest>,
) -> (StatusCode, Json<Value>) {
    match roll(&state.pool, body.user_id, &body.code, body.server_now_ms).await {
        Ok(out) => (StatusCode::OK, Json(out.to_json())),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_roleta_claim(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClaimRequest>,
) -> (StatusCode, Json<Value>) {
    match claim(
        &state.pool,
        body.user_id,
        &body.code,
        &body.won_item_id,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => (StatusCode::OK, Json(out.to_json())),
        Err(e) => wheel_fail_value(e),
    }
}

// ---------------------------------------------------------------------------
// Admin editor (`/v1/wheel/admin/*`) — ports server/modules/wheel/services/admin.ts
// ---------------------------------------------------------------------------

use super::admin::{
    run_admin_wheel_players_add, run_admin_wheel_players_list, run_admin_wheel_players_remove,
    run_admin_wheel_prizes_list, run_admin_wheel_prizes_replace,
    run_admin_wheel_runtime_config_get, run_admin_wheel_runtime_config_set,
};

pub async fn post_admin_wheel_prizes_list(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_prizes_list(&state.pool).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_prizes_replace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_prizes_replace(&state.pool, &body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_runtime_config_get(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_runtime_config_get(&state.pool).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_runtime_config_set(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_runtime_config_set(&state.pool, &body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_players_list(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_players_list(&state.pool).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_players_add(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_players_add(&state.pool, &body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}

pub async fn post_admin_wheel_players_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    match run_admin_wheel_players_remove(&state.pool, &body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => wheel_fail_value(e),
    }
}
