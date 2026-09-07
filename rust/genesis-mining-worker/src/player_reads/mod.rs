//! Player reads for genesis-api — checkin / quests / header / nav / settings / profile.

pub mod checkin;
pub mod guide;
pub mod header;
pub mod nav;
pub mod profile;
pub mod quests;
pub mod roadmap;
pub mod settings;
pub mod transparency;

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

pub const CHECKIN_STATUS_PATH: &str = "/v1/checkin/status";
pub const CHECKIN_PERFORM_PATH: &str = "/v1/checkin/perform";
pub const QUESTS_STATE_PATH: &str = "/v1/quests/state";
pub const HEADER_PATH: &str = "/v1/player-game/header";
pub const HEADER_HIGHLIGHT_PATH: &str = "/v1/player-game/header/highlight";
pub const NAV_PATH: &str = "/v1/player-game/nav";
pub const ECONOMY_SETTINGS_PATH: &str = "/v1/settings/economy";
pub const EXCHANGE_SETTINGS_PATH: &str = "/v1/settings/exchange";
pub const MONETIZATION_SETTINGS_PATH: &str = "/v1/settings/monetization";
pub const MONETIZATION_SETTINGS_ADMIN_PATH: &str = "/v1/settings/monetization/read";
pub const DISPLAY_LABELS_PATH: &str = "/v1/settings/display-labels";
pub const PROFILE_STATE_PATH: &str = "/v1/profile/state";
pub const GUIDE_PATH: &str = "/v1/guide";
pub const ROADMAP_PATH: &str = "/v1/roadmap";
pub const TRANSPARENCY_PATH: &str = "/v1/transparency";
pub const TRANSPARENCY_HEALTH_PATH: &str = "/v1/transparency/health";

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_CONFLICT: u16 = 409;
/// Node `HTTP_UNPROCESSABLE` (422).
pub const HTTP_UNPROCESSABLE: u16 = 422;
const HTTP_INTERNAL: u16 = 500;
/// Node / worker infra when auth twin unset.
pub const HTTP_SERVICE_UNAVAILABLE: u16 = 503;

const _: () = assert!(HTTP_BAD_REQUEST == 400);
const _: () = assert!(HTTP_NOT_FOUND == 404);
const _: () = assert!(HTTP_CONFLICT == 409);
const _: () = assert!(HTTP_UNPROCESSABLE == 422);
const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);

#[derive(Debug)]
pub struct PlayerReadError {
    pub http_status: u16,
    pub error: String,
    pub code: Option<String>,
    pub extra: Value,
}

impl PlayerReadError {
    pub fn bad(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            error: error.into(),
            code: None,
            extra: Value::Object(serde_json::Map::new()),
        }
    }
    pub fn not_found(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            error: error.into(),
            code: Some("NOT_FOUND".into()),
            extra: Value::Object(serde_json::Map::new()),
        }
    }
    pub fn conflict(error: impl Into<String>, extra: Value) -> Self {
        Self {
            http_status: HTTP_CONFLICT,
            error: error.into(),
            code: Some("PREMIUM_COOLDOWN".into()),
            extra,
        }
    }
    pub fn controlled(http_status: u16, error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            http_status,
            error: error.into(),
            code: Some(code.into()),
            extra: Value::Object(serde_json::Map::new()),
        }
    }
    pub fn internal(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            error: error.into(),
            code: Some("INTERNAL".into()),
            extra: Value::Object(serde_json::Map::new()),
        }
    }
}

impl From<deadpool_postgres::PoolError> for PlayerReadError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::internal(e.to_string())
    }
}
impl From<tokio_postgres::Error> for PlayerReadError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::internal(e.to_string())
    }
}
impl From<anyhow::Error> for PlayerReadError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(e.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReadBody {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(flatten)]
    pub payload: Value,
}

pub fn ok_payload(payload: Value) -> (StatusCode, Json<PlayerReadBody>) {
    (
        StatusCode::OK,
        Json(PlayerReadBody {
            ok: true,
            error: None,
            code: None,
            payload,
        }),
    )
}

pub fn fail_read(e: PlayerReadError) -> (StatusCode, Json<PlayerReadBody>) {
    let status = StatusCode::from_u16(e.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut payload = e.extra;
    if payload.is_null() {
        payload = Value::Object(serde_json::Map::new());
    }
    (
        status,
        Json(PlayerReadBody {
            ok: false,
            error: Some(e.error),
            code: e.code,
            payload,
        }),
    )
}

pub fn f64_cell(row: &tokio_postgres::Row, col: &str) -> f64 {
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v;
        }
    }
    if let Ok(s) = row.try_get::<_, String>(col) {
        if let Ok(v) = s.parse::<f64>() {
            if v.is_finite() {
                return v;
            }
        }
    }
    0.0
}

pub fn i32_cell(row: &tokio_postgres::Row, col: &str) -> i32 {
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return i32::try_from(v).unwrap_or(0);
    }
    0
}

pub fn i64_cell(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return i64::from(v);
    }
    0
}

pub fn opt_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    if let Ok(v) = row.try_get::<_, Option<String>>(col) {
        return v.filter(|s| !s.trim().is_empty());
    }
    if let Ok(v) = row.try_get::<_, String>(col) {
        let t = v.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

pub fn string_cell(row: &tokio_postgres::Row, col: &str) -> String {
    opt_string(row, col).unwrap_or_default()
}

pub fn pg_user_id(uid: i64) -> Result<i32, PlayerReadError> {
    i32::try_from(uid)
        .map_err(|_| PlayerReadError::bad(format!("user_id out of int4 range: {uid}")))
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
        .unwrap_or(0)
}
