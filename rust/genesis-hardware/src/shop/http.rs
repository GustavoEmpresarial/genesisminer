//! Axum handlers for `/v1/shop/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::http::AppState;

use super::checkout::{checkout, CheckoutOutcome};
use super::errors::ShopError;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopBody {
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
    pub total_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    pub user_id: i64,
    #[serde(default)]
    pub cart: serde_json::Map<String, serde_json::Value>,
    pub idempotency_key: String,
    pub clear_cart_id: Option<String>,
    pub request_fingerprint: Option<String>,
}

fn shop_fail(e: ShopError) -> (StatusCode, Json<ShopBody>) {
    match e {
        ShopError::Domain {
            status,
            error,
            code,
            missing,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(ShopBody {
                    ok: false,
                    error: Some(error),
                    code,
                    missing,
                    ..Default::default()
                }),
            )
        }
        ShopError::Transport(err) => {
            warn!(err = %err, "shop transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ShopBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn ok_checkout(out: CheckoutOutcome) -> (StatusCode, Json<ShopBody>) {
    (
        StatusCode::OK,
        Json(ShopBody {
            ok: true,
            new_usdc: Some(out.new_usdc),
            total_cost: Some(out.total_cost),
            cached: if out.cached { Some(true) } else { None },
            ..Default::default()
        }),
    )
}

pub async fn post_checkout(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CheckoutRequest>,
) -> (StatusCode, Json<ShopBody>) {
    match checkout(
        &state.pool,
        body.user_id,
        body.cart,
        &body.idempotency_key,
        body.clear_cart_id.as_deref(),
        body.request_fingerprint.as_deref(),
    )
    .await
    {
        Ok(out) => ok_checkout(out),
        Err(e) => shop_fail(e),
    }
}
