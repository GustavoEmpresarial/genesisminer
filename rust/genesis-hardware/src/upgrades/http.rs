//! Axum handlers for `/v1/upgrades/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::http::AppState;

use super::errors::UpgradesError;
use super::purchase::{purchase_package, PurchaseOutcome, PurchasedBox};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradesBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_replay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_version: Option<i32>,
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    pub purchased_box: Option<BoxJson>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxJson {
    pub id: String,
    pub name: String,
    pub quantity: i32,
}

impl From<PurchasedBox> for BoxJson {
    fn from(b: PurchasedBox) -> Self {
        Self {
            id: b.id,
            name: b.name,
            quantity: b.quantity,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRequest {
    pub user_id: i64,
    pub package_id: String,
    /// When omitted/null, skip `upgrade_purchase_idempotency` (Node legacy compat).
    pub idempotency_key: Option<String>,
    pub client_package_version: Option<i32>,
    pub server_now_ms: Option<i64>,
}

fn upgrades_fail(e: UpgradesError) -> (StatusCode, Json<UpgradesBody>) {
    match e {
        UpgradesError::Domain {
            status,
            error,
            code,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(UpgradesBody {
                    ok: false,
                    error: Some(error),
                    code,
                    ..Default::default()
                }),
            )
        }
        UpgradesError::Transport(err) => {
            warn!(err = %err, "upgrades transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UpgradesBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn ok_purchase(out: PurchaseOutcome) -> (StatusCode, Json<UpgradesBody>) {
    (
        StatusCode::OK,
        Json(UpgradesBody {
            ok: true,
            new_usdc: Some(out.new_usdc),
            idempotent_replay: Some(out.idempotent_replay),
            package_version: Some(out.package_version),
            purchased_box: out.box_info.map(BoxJson::from),
            ..Default::default()
        }),
    )
}

pub async fn post_purchase(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PurchaseRequest>,
) -> (StatusCode, Json<UpgradesBody>) {
    match purchase_package(
        &state.pool,
        body.user_id,
        &body.package_id,
        body.idempotency_key.as_deref(),
        body.client_package_version,
        body.server_now_ms,
    )
    .await
    {
        Ok(out) => ok_purchase(out),
        Err(e) => upgrades_fail(e),
    }
}
