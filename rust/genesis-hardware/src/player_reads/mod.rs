//! Player read twins for genesis-api — inventory / shop / catalog / servers / lucky / wheel.
//!
//! Node Express stays JWT / rate-limit; I/O is fail-closed HTTP here.

pub mod catalog;
pub mod http;
pub mod inventory;
pub mod lucky;
pub mod merge;
pub mod news;
pub mod rooms;
pub mod season_passes;
pub mod servers;
pub mod shop;
pub mod upgrades;
pub mod wheel;

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

pub const INVENTORY_STATE_PATH: &str = "/v1/inventory/state";
pub const SHOP_STATE_PATH: &str = "/v1/shop/state";
pub const SHOP_PRODUCTS_PATH: &str = "/v1/shop/products";
pub const SHOP_CART_SET_PATH: &str = "/v1/shop/cart/set";
pub const SHOP_CART_SET_LINE_PATH: &str = "/v1/shop/cart/set-line";
pub const SHOP_CART_DELETE_LINE_PATH: &str = "/v1/shop/cart/delete-line";
pub const SHOP_CART_CLEAR_PATH: &str = "/v1/shop/cart/clear";
pub const CATALOG_UPGRADES_PATH: &str = "/v1/catalog/upgrades";
pub const CATALOG_MINING_COINS_PATH: &str = "/v1/catalog/mining-coins";
pub const CATALOG_ACCESS_LEVELS_PATH: &str = "/v1/catalog/access-levels";
pub const CATALOG_LOOT_BOXES_PATH: &str = "/v1/catalog/loot-boxes";
pub const SERVERS_STATE_PATH: &str = "/v1/servers/state";
pub const GAME_STATE_ME_PATH: &str = "/v1/game-state/me";
pub const ADMIN_GAME_STATE_BY_EMAIL_PATH: &str = "/v1/game-state/by-email";
pub const LUCKY_STATE_PATH: &str = "/v1/lucky-boxes/state";
pub const LUCKY_SHOP_PATH: &str = "/v1/lucky-boxes/shop";
pub const LUCKY_INVENTORY_PATH: &str = "/v1/lucky-boxes/inventory";
pub const LUCKY_HISTORY_PATH: &str = "/v1/lucky-boxes/history";
pub const LUCKY_OPENING_PATH: &str = "/v1/lucky-boxes/opening";
pub const LUCKY_DISCARD_PATH: &str = "/v1/lucky-boxes/discard";
pub const WHEEL_STATE_PATH: &str = "/v1/wheel/state";
pub const WHEEL_HISTORY_PATH: &str = "/v1/wheel/history";
pub const WHEEL_SPIN_PATH: &str = "/v1/wheel/spin";
pub const ROLETA_PENDING_CODE_PATH: &str = "/v1/roleta/pending-code";
pub const NEWS_LIST_PATH: &str = "/v1/catalog/news";
pub const NEWS_FEE_PATH: &str = "/v1/catalog/news-fee";
pub const NEWS_EXPIRE_DAYS_PATH: &str = "/v1/catalog/news-expire-days";
pub const SEASON_PASSES_PATH: &str = "/v1/catalog/season-passes";
pub const RIG_ROOMS_PATH: &str = "/v1/rooms/list";
pub const MY_RIG_ROOMS_PATH: &str = "/v1/rooms/mine";
pub const MERGE_CONFIG_PATH: &str = "/v1/merge/config";
pub const MERGE_INVENTORY_PATH: &str = "/v1/merge/inventory";
pub const MERGE_HISTORY_PATH: &str = "/v1/merge/history";
pub const UPGRADES_STATE_PATH: &str = "/v1/upgrades/state";
pub const UPGRADES_PURCHASES_PATH: &str = "/v1/upgrades/purchases";
pub const SHOP_ORDER_PATH: &str = "/v1/shop/order";

/// Node `HTTP_BAD_REQUEST`.
pub const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_FORBIDDEN`.
pub const HTTP_FORBIDDEN: u16 = 403;
/// Node `HTTP_NOT_FOUND`.
pub const HTTP_NOT_FOUND: u16 = 404;
/// Node `HTTP_UNPROCESSABLE`.
pub const HTTP_UNPROCESSABLE: u16 = 422;
/// Node `HTTP_CONFLICT`.
pub const HTTP_CONFLICT: u16 = 409;
const HTTP_INTERNAL: u16 = 500;

const _: () = assert!(HTTP_BAD_REQUEST == 400);
const _: () = assert!(HTTP_FORBIDDEN == 403);
const _: () = assert!(HTTP_NOT_FOUND == 404);
const _: () = assert!(HTTP_UNPROCESSABLE == 422);

#[derive(Debug)]
pub struct PlayerReadError {
    pub http_status: u16,
    pub error: String,
    pub code: Option<String>,
}

impl PlayerReadError {
    pub fn bad(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            error: error.into(),
            code: None,
        }
    }
    pub fn forbidden(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            error: error.into(),
            code: Some("FORBIDDEN".into()),
        }
    }
    pub fn not_found(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            error: error.into(),
            code: Some("NOT_FOUND".into()),
        }
    }
    pub fn unprocessable(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_UNPROCESSABLE,
            error: error.into(),
            code: None,
        }
    }
    pub fn conflict(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_CONFLICT,
            error: error.into(),
            code: Some("CONFLICT".into()),
        }
    }
    pub fn internal(error: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            error: error.into(),
            code: Some("INTERNAL".into()),
        }
    }
}

impl From<anyhow::Error> for PlayerReadError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(e.to_string())
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
    (
        status,
        Json(PlayerReadBody {
            ok: false,
            error: Some(e.error),
            code: e.code,
            payload: Value::Object(serde_json::Map::new()),
        }),
    )
}

pub fn f64_cell(row: &tokio_postgres::Row, col: &str) -> f64 {
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v;
        }
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(col) {
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
    if let Ok(Some(s)) = row.try_get::<_, Option<String>>(col) {
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
    if let Ok(Some(v)) = row.try_get::<_, Option<i32>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return i32::try_from(v).unwrap_or(0);
    }
    0
}

pub fn opt_i32_cell(row: &tokio_postgres::Row, col: &str) -> Option<i32> {
    if let Ok(v) = row.try_get::<_, Option<i32>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return Some(v);
    }
    None
}

pub fn opt_string_cell(row: &tokio_postgres::Row, col: &str) -> Option<String> {
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
    opt_string_cell(row, col).unwrap_or_default()
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

pub fn opt_i64_cell(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    if let Ok(v) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return Some(i64::from(v));
    }
    None
}

pub fn opt_f64_cell(row: &tokio_postgres::Row, col: &str) -> Option<f64> {
    if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(col) {
        if v.is_finite() {
            return Some(v);
        }
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return Some(v);
        }
    }
    None
}
