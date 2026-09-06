//! Axum handlers for `/v1/catalog/*`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;

use crate::http::AppState;

use super::errors::CatalogError;
use super::replace::{
    parse_expected_catalog_revision, replace_shop_upgrades, require_upgrades_array, ReplaceOutcome,
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_catalog_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_reload: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub upgrades: Value,
    pub expected_catalog_revision: Value,
}

fn catalog_fail(e: CatalogError) -> (StatusCode, Json<CatalogBody>) {
    match e {
        CatalogError::Domain {
            status,
            error,
            code,
            catalog_revision,
            expected_catalog_revision,
            force_reload,
            previous_id,
            attempted_id,
        } => {
            let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            (
                sc,
                Json(CatalogBody {
                    ok: false,
                    error: Some(error),
                    code,
                    catalog_revision,
                    expected_catalog_revision,
                    force_reload,
                    previous_id,
                    attempted_id,
                }),
            )
        }
        CatalogError::Transport(err) => {
            warn!(err = %err, "catalog transport");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(CatalogBody {
                    ok: false,
                    error: Some(err.to_string()),
                    ..Default::default()
                }),
            )
        }
    }
}

fn ok_replace(out: ReplaceOutcome) -> (StatusCode, Json<CatalogBody>) {
    (
        StatusCode::OK,
        Json(CatalogBody {
            ok: true,
            catalog_revision: Some(out.catalog_revision),
            ..Default::default()
        }),
    )
}

pub async fn post_upgrades_replace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReplaceRequest>,
) -> (StatusCode, Json<CatalogBody>) {
    let upgrades = match require_upgrades_array(&body.upgrades) {
        Ok(a) => a,
        Err(e) => return catalog_fail(e),
    };
    let expected = match parse_expected_catalog_revision(&body.expected_catalog_revision) {
        Ok(v) => v,
        Err(e) => return catalog_fail(e),
    };
    match replace_shop_upgrades(&state.pool, upgrades, expected).await {
        Ok(out) => ok_replace(out),
        Err(e) => catalog_fail(e),
    }
}
