//! Axum handlers for the admin catalog / settings writes.
//!
//! Payload-shape validation that Node keeps in its Express controllers (array
//! bodies, `id`/`text` presence) stays in genesis-api so the 400 body matches;
//! everything reaching a handler here is already shaped.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::http::AppState;
use crate::player_reads::{fail_read, ok_payload, PlayerReadBody};

use super::access_levels::run_replace_access_levels;
use super::loot_boxes::run_upsert_loot_boxes;
use super::mining_coins::run_upsert_mining_coins;
use super::news::{
    run_news_delete, run_news_expire_days_persist, run_news_fee_persist, run_news_upsert,
};
use super::rig_rooms::run_upsert_rig_rooms;
use super::season_passes::run_replace_season_passes;

type CatalogWriteResponse = (StatusCode, Json<PlayerReadBody>);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessLevelsReplaceRequest {
    #[serde(default)]
    pub levels: Vec<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootBoxesUpsertRequest {
    #[serde(default)]
    pub boxes: Vec<Value>,
    #[serde(default)]
    pub replace_catalog: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonPassesReplaceRequest {
    #[serde(default)]
    pub passes: Vec<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RigRoomsUpsertRequest {
    #[serde(default)]
    pub rooms: Vec<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsDeleteRequest {
    #[serde(default)]
    pub id: String,
}

/// The admin panel posts an arbitrary JSON document; Node reads `req.body` raw,
/// so the twin carries it untouched (arrays and `null` included).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPayloadRequest {
    #[serde(default)]
    pub payload: Value,
}

pub async fn post_access_levels_replace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AccessLevelsReplaceRequest>,
) -> CatalogWriteResponse {
    match run_replace_access_levels(&state.pool, &body.levels).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_loot_boxes_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LootBoxesUpsertRequest>,
) -> CatalogWriteResponse {
    match run_upsert_loot_boxes(&state.pool, &body.boxes, body.replace_catalog).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_mining_coins_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RawPayloadRequest>,
) -> CatalogWriteResponse {
    match run_upsert_mining_coins(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_news_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RawPayloadRequest>,
) -> CatalogWriteResponse {
    match run_news_upsert(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_news_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NewsDeleteRequest>,
) -> CatalogWriteResponse {
    match run_news_delete(&state.pool, &body.id).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_news_fee_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RawPayloadRequest>,
) -> CatalogWriteResponse {
    match run_news_fee_persist(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_news_expire_days_persist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RawPayloadRequest>,
) -> CatalogWriteResponse {
    match run_news_expire_days_persist(&state.pool, &body.payload).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_season_passes_replace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SeasonPassesReplaceRequest>,
) -> CatalogWriteResponse {
    match run_replace_season_passes(&state.pool, &body.passes).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}

pub async fn post_rig_rooms_upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RigRoomsUpsertRequest>,
) -> CatalogWriteResponse {
    match run_upsert_rig_rooms(&state.pool, &body.rooms).await {
        Ok(v) => ok_payload(v),
        Err(e) => fail_read(e),
    }
}
