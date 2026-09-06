//! Axum handlers for `/v1/rooms/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::http::AppState;

use super::errors::RoomsError;
use super::purchase_slot::{purchase_slot, PurchaseSlotOutcome};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomsBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots_purchased: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseSlotRequest {
    pub user_id: i64,
    pub room_id: String,
    pub quantity: Option<i64>,
    pub idempotency_key: String,
    pub server_now_ms: Option<i64>,
}

fn rooms_fail(e: RoomsError) -> (StatusCode, Json<RoomsBody>) {
    match e {
        RoomsError::Domain {
            status,
            error,
            code,
            missing,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(RoomsBody {
                    ok: false,
                    error: Some(error),
                    code,
                    missing,
                    ..Default::default()
                }),
            )
        }
        RoomsError::Transport(err) => {
            warn!(err = %err, "rooms transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(RoomsBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn ok_purchase(out: PurchaseSlotOutcome) -> (StatusCode, Json<RoomsBody>) {
    (
        StatusCode::OK,
        Json(RoomsBody {
            ok: true,
            room_id: Some(out.room_id),
            slots_purchased: Some(out.slots_purchased),
            total_price: Some(out.total_price),
            new_usdc: Some(out.new_usdc),
            cached: if out.cached { Some(true) } else { None },
            ..Default::default()
        }),
    )
}

pub async fn post_purchase_slot(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PurchaseSlotRequest>,
) -> (StatusCode, Json<RoomsBody>) {
    match purchase_slot(
        &state.pool,
        body.user_id,
        &body.room_id,
        body.quantity.unwrap_or(1),
        &body.idempotency_key,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => ok_purchase(out),
        Err(e) => rooms_fail(e),
    }
}
