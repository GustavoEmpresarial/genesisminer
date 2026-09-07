//! Public settings GETs — economy / exchange / monetization / display-labels.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::{json, Value};

use super::{f64_cell, i32_cell, string_cell, PlayerReadError};

/// Node `TAX_MIN` / `TAX_MAX` in economy-settings.ts.
pub const TAX_MIN: f64 = 0.0;
pub const TAX_MAX: f64 = 100.0;
/// Node `BAND_MIN` / `BAND_MAX` / `BAND_DEFAULT`.
pub const BAND_MIN: f64 = 0.0;
pub const BAND_MAX: f64 = 200.0;
pub const BAND_DEFAULT: f64 = 20.0;
/// Node `MIN_DEFAULT` for exchange GET.
const EXCHANGE_MIN_DEFAULT: f64 = 0.1;
/// Node `FEE_DEFAULT` for exchange GET (no clamp).
const EXCHANGE_FEE_DEFAULT: f64 = 0.0;
pub const DEFAULT_APPLIXIR_REWARD_MESSAGE: &str = "Parabéns! Você ganhou {reward} W/h";

/// Node `economy_settings` singleton (`where: { id: 1 }`).
pub const ECONOMY_SETTINGS_ROW_ID: i32 = 1;

const _: () = assert!((EXCHANGE_MIN_DEFAULT * 10.0) as i64 == 1);
const _: () = assert!(TAX_MAX as i64 == 100);
const _: () = assert!(BAND_MAX as i64 == 200);
const _: () = assert!(BAND_DEFAULT as i64 == 20);

pub async fn run_economy_settings(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let row = conn
        .query_opt(
            "SELECT hardware_market_enabled, black_market_enabled,
                    market_tax_percent::double precision AS market_tax_percent,
                    black_market_price_band_percent::double precision AS black_market_price_band_percent
               FROM economy_settings WHERE id = $1",
            &[&ECONOMY_SETTINGS_ROW_ID],
        )
        .await?;
    let kv = load_kv(
        &conn,
        &[
            "hardware_market_enabled",
            "black_market_enabled",
            "market_tax_percent",
            "black_market_price_band_percent",
        ],
    )
    .await?;
    let hw = flag_row_or_kv(
        row.as_ref().map(|r| i32_cell(r, "hardware_market_enabled")),
        kv.get("hardware_market_enabled"),
        true,
    );
    let bm = flag_row_or_kv(
        row.as_ref().map(|r| i32_cell(r, "black_market_enabled")),
        kv.get("black_market_enabled"),
        true,
    );
    let tax = {
        let from_row = row.as_ref().map(|r| f64_cell(r, "market_tax_percent"));
        let mut t = from_row.filter(|v| v.is_finite()).unwrap_or(f64::NAN);
        if !t.is_finite() {
            t = kv
                .get("market_tax_percent")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
        }
        t.max(TAX_MIN).min(TAX_MAX)
    };
    let band = {
        let from_row = row
            .as_ref()
            .map(|r| f64_cell(r, "black_market_price_band_percent"));
        if let Some(b) = from_row.filter(|v| v.is_finite()) {
            b.max(BAND_MIN).min(BAND_MAX)
        } else if let Some(s) = kv.get("black_market_price_band_percent") {
            s.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .map(|b| b.max(BAND_MIN).min(BAND_MAX))
                .unwrap_or(BAND_DEFAULT)
        } else {
            BAND_DEFAULT
        }
    };
    Ok(json!({
        "hardwareMarketEnabled": hw,
        "blackMarketEnabled": bm,
        "marketTaxPercent": tax,
        "blackMarketPriceBandPercent": band,
    }))
}

pub async fn run_exchange_settings(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let kv = load_kv(&conn, &["exchange_min_usdc", "exchange_fee_percent"]).await?;
    let min = kv
        .get("exchange_min_usdc")
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(EXCHANGE_MIN_DEFAULT);
    let fee = kv
        .get("exchange_fee_percent")
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(EXCHANGE_FEE_DEFAULT);
    Ok(json!({
        "minExchangeAmount": min,
        "exchangeFeePercent": fee,
    }))
}

pub async fn run_monetization_settings(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let kv = load_kv(
        &conn,
        &[
            "applixir_enabled",
            "applixir_site_id",
            "applixir_zone_id",
            "applixir_account_id",
            "applixir_reward_message",
            "ezoic_enabled",
            "ezoic_publisher_id",
            "ezoic_app_id",
            "ezoic_placeholder_id",
        ],
    )
    .await?;
    Ok(json!({
        "applixirEnabled": kv.get("applixir_enabled").map(|s| s.as_str()) == Some("1"),
        "applixirSiteId": kv.get("applixir_site_id").cloned().unwrap_or_default(),
        "applixirZoneId": kv.get("applixir_zone_id").cloned().unwrap_or_default(),
        "applixirAccountId": kv.get("applixir_account_id").cloned().unwrap_or_default(),
        "applixirRewardMessage": kv.get("applixir_reward_message").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_APPLIXIR_REWARD_MESSAGE.into()),
        "ezoicEnabled": kv.get("ezoic_enabled").map(|s| s.as_str()) == Some("1"),
        "ezoicPublisherId": kv.get("ezoic_publisher_id").cloned().unwrap_or_default(),
        "ezoicAppId": kv.get("ezoic_app_id").cloned().unwrap_or_default(),
        "ezoicPlaceholderId": kv.get("ezoic_placeholder_id").cloned().unwrap_or_default(),
    }))
}

/// Admin variant of [`run_monetization_settings`] — includes
/// `applixirCallbackSecret` (Node `GET /api/admin/monetization-settings`).
pub async fn run_monetization_settings_admin(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let kv = load_kv(
        &conn,
        &[
            "applixir_enabled",
            "applixir_site_id",
            "applixir_zone_id",
            "applixir_account_id",
            "applixir_reward_message",
            "applixir_callback_secret",
            "ezoic_enabled",
            "ezoic_publisher_id",
            "ezoic_app_id",
            "ezoic_placeholder_id",
        ],
    )
    .await?;
    Ok(json!({
        "applixirEnabled": kv.get("applixir_enabled").map(|s| s.as_str()) == Some("1"),
        "applixirSiteId": kv.get("applixir_site_id").cloned().unwrap_or_default(),
        "applixirZoneId": kv.get("applixir_zone_id").cloned().unwrap_or_default(),
        "applixirAccountId": kv.get("applixir_account_id").cloned().unwrap_or_default(),
        "applixirRewardMessage": kv.get("applixir_reward_message").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_APPLIXIR_REWARD_MESSAGE.into()),
        "applixirCallbackSecret": kv.get("applixir_callback_secret").cloned().unwrap_or_default(),
        "ezoicEnabled": kv.get("ezoic_enabled").map(|s| s.as_str()) == Some("1"),
        "ezoicPublisherId": kv.get("ezoic_publisher_id").cloned().unwrap_or_default(),
        "ezoicAppId": kv.get("ezoic_app_id").cloned().unwrap_or_default(),
        "ezoicPlaceholderId": kv.get("ezoic_placeholder_id").cloned().unwrap_or_default(),
    }))
}

pub async fn run_display_labels(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT key, value FROM ui_display_labels ORDER BY key ASC",
            &[],
        )
        .await?;
    let mut obj = serde_json::Map::new();
    for r in &rows {
        let k = string_cell(r, "key");
        let v = string_cell(r, "value");
        if !k.is_empty() && !v.is_empty() {
            obj.insert(k, json!(v));
        }
    }
    Ok(Value::Object(obj))
}

async fn load_kv<C: GenericClient>(
    client: &C,
    keys: &[&str],
) -> Result<std::collections::HashMap<String, String>, PlayerReadError> {
    let key_vec: Vec<String> = keys.iter().map(|s| (*s).to_string()).collect();
    let rows = client
        .query(
            "SELECT key, value FROM settings WHERE key = ANY($1::text[])",
            &[&key_vec],
        )
        .await?;
    let mut m = std::collections::HashMap::new();
    for r in &rows {
        m.insert(string_cell(r, "key"), string_cell(r, "value"));
    }
    Ok(m)
}

fn flag_row_or_kv(row: Option<i32>, kv: Option<&String>, default_on: bool) -> bool {
    if let Some(v) = row {
        return v != 0;
    }
    if let Some(s) = kv {
        return s == "1";
    }
    default_on
}
