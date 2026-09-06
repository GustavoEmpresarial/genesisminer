//! Admin settings writes — economy / exchange / monetization persist twins.
//!
//! Ports `persistEconomySettings`, `persistExchangeSettings` and
//! `persistMonetizationSettings` from
//! `server/modules/admin/{economy,exchange,monetization}-settings/services/`.
//! Each persist runs in one transaction (Node `prisma.$transaction` /
//! `upsertSettingsEntries`), so a half-saved admin form is impossible.
//!
//! Coercion mirrors the JS operators the Node services rely on (`Number(x) || 0`,
//! `x ? 1 : 0`, `String(x || '')`) — see [`js`].

use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;

use crate::player_reads::settings::{
    BAND_DEFAULT, BAND_MAX, BAND_MIN, DEFAULT_APPLIXIR_REWARD_MESSAGE, ECONOMY_SETTINGS_ROW_ID,
    TAX_MAX, TAX_MIN,
};
use crate::player_reads::PlayerReadError;

pub const ECONOMY_SETTINGS_PERSIST_PATH: &str = "/v1/settings/economy/persist";
pub const EXCHANGE_SETTINGS_PERSIST_PATH: &str = "/v1/settings/exchange/persist";
pub const MONETIZATION_SETTINGS_PERSIST_PATH: &str = "/v1/settings/monetization/persist";

/// Node `FEE_MAX` in exchange-settings.ts.
const EXCHANGE_FEE_MAX: f64 = 100.0;
/// Node `Math.max(0, ...)` floor on both exchange fields.
const EXCHANGE_FLOOR: f64 = 0.0;

/// Node `HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid payload.' })`.
const ERR_INVALID_PAYLOAD: &str = "Invalid payload.";

const KV_UPSERT_SQL: &str = "INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

const ECONOMY_ROW_UPSERT_SQL: &str = "INSERT INTO economy_settings
       (id, black_market_enabled, hardware_market_enabled, market_tax_percent,
        black_market_price_band_percent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       black_market_enabled = EXCLUDED.black_market_enabled,
       hardware_market_enabled = EXCLUDED.hardware_market_enabled,
       market_tax_percent = EXCLUDED.market_tax_percent,
       black_market_price_band_percent = EXCLUDED.black_market_price_band_percent";

const ECONOMY_PREVIOUS_BAND_SQL: &str =
    "SELECT black_market_price_band_percent::double precision AS black_market_price_band_percent
       FROM economy_settings WHERE id = $1";

const _: () = assert!(EXCHANGE_FEE_MAX as i64 == 100);
const _: () = assert!(TAX_MAX as i64 == 100);
const _: () = assert!(BAND_MAX as i64 == 200);
const _: () = assert!(BAND_DEFAULT as i64 == 20);

/// The admin panel posts an arbitrary JSON document; Node reads `req.body` raw,
/// so the twin carries it untouched (arrays and `null` included).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPersistRequest {
    #[serde(default)]
    pub payload: Value,
}

/// JavaScript coercion parity for the operators used by the Node services.
///
/// Kept explicit (instead of "reasonable Rust" semantics) because these
/// endpoints must accept the exact same payloads the admin panel already sends:
/// `"0"` is truthy in JS, `null` numbers to `0`, absent keys number to `NaN`.
mod js {
    use serde_json::Value;

    /// JS `!!value` (`undefined`/absent → `false`).
    pub fn truthy(v: Option<&Value>) -> bool {
        match v {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        }
    }

    /// JS `Number(value)` — absent/objects → `NaN`, `null` → `0`, arrays via
    /// their string form (`[] → 0`, `[5] → 5`, `[1,2] → NaN`).
    pub fn number(v: Option<&Value>) -> f64 {
        match v {
            None => f64::NAN,
            Some(Value::Null) => 0.0,
            Some(Value::Bool(b)) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => number_from_str(s),
            Some(Value::Array(items)) => {
                let joined = items
                    .iter()
                    .map(|i| match i {
                        Value::Null => String::new(),
                        other => string(Some(other)),
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                number_from_str(&joined)
            }
            Some(Value::Object(_)) => f64::NAN,
        }
    }

    /// JS `Number(value) || 0` — `NaN`/`0`/`-0` all collapse to `0`.
    pub fn number_or_zero(v: Option<&Value>) -> f64 {
        let n = number(v);
        if n.is_nan() || n == 0.0 {
            0.0
        } else {
            n
        }
    }

    /// JS `String(value)`; `Infinity`/`NaN` keep their JS spelling so the stored
    /// KV string stays readable by both runtimes.
    pub fn number_to_string(n: f64) -> String {
        if n.is_nan() {
            return "NaN".into();
        }
        if n.is_infinite() {
            return if n.is_sign_negative() {
                "-Infinity".into()
            } else {
                "Infinity".into()
            };
        }
        format!("{n}")
    }

    /// JS `String(value)` for the scalars the admin forms send.
    pub fn string(v: Option<&Value>) -> String {
        match v {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|i| match i {
                    Value::Null => String::new(),
                    other => string(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".into(),
        }
    }

    /// JS `String(value || '')` — falsy input yields an empty string.
    pub fn string_or_empty(v: Option<&Value>) -> String {
        if truthy(v) {
            string(v)
        } else {
            String::new()
        }
    }

    fn number_from_str(raw: &str) -> f64 {
        let t = raw.trim();
        if t.is_empty() {
            return 0.0;
        }
        match t {
            "Infinity" | "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => t.parse::<f64>().unwrap_or(f64::NAN),
        }
    }
}

fn clamp(n: f64, min: f64, max: f64) -> f64 {
    n.max(min).min(max)
}

/// Node guard shared by economy + exchange: only objects (or `null`) are valid.
/// `null` behaves as `{}` (`body ?? {}`), so every field falls back to default.
fn require_object_payload(
    payload: &Value,
) -> Result<Option<&serde_json::Map<String, Value>>, PlayerReadError> {
    match payload {
        Value::Null => Ok(None),
        Value::Object(m) => Ok(Some(m)),
        _ => Err(PlayerReadError::bad(ERR_INVALID_PAYLOAD)),
    }
}

fn field<'a>(body: Option<&'a serde_json::Map<String, Value>>, key: &str) -> Option<&'a Value> {
    body.and_then(|m| m.get(key))
}

#[derive(Debug, Clone, PartialEq)]
pub struct EconomySettingsPersistPlan {
    pub tax: f64,
    pub band: f64,
    pub black_market_enabled: i32,
    pub hardware_market_enabled: i32,
}

/// Node `coerceTax`.
fn coerce_tax(raw: Option<&Value>) -> f64 {
    clamp(js::number_or_zero(raw), TAX_MIN, TAX_MAX)
}

/// Node `coerceBand` — non-finite input falls back to the stored band, then 20.
fn coerce_band(raw: Option<&Value>, previous_or_default: f64) -> f64 {
    let mut band = js::number(raw);
    if !band.is_finite() {
        band = previous_or_default;
    }
    if !band.is_finite() {
        band = BAND_DEFAULT;
    }
    clamp(band, BAND_MIN, BAND_MAX)
}

/// Node `planEconomySettingsPersist` minus the DB read (see `previous_band`).
pub fn plan_economy_settings_persist(
    payload: &Value,
    previous_band: f64,
) -> Result<EconomySettingsPersistPlan, PlayerReadError> {
    let body = require_object_payload(payload)?;
    Ok(EconomySettingsPersistPlan {
        tax: coerce_tax(field(body, "marketTaxPercent")),
        band: coerce_band(field(body, "blackMarketPriceBandPercent"), previous_band),
        black_market_enabled: i32::from(js::truthy(field(body, "blackMarketEnabled"))),
        hardware_market_enabled: i32::from(js::truthy(field(body, "hardwareMarketEnabled"))),
    })
}

/// Node only reads the previous band when the incoming value is not finite.
pub fn economy_needs_previous_band(payload: &Value) -> bool {
    let Value::Object(body) = payload else {
        return false;
    };
    !js::number(body.get("blackMarketPriceBandPercent")).is_finite()
}

async fn load_previous_band(pool: &Pool) -> Result<f64, PlayerReadError> {
    let conn = pool.get().await?;
    let row = conn
        .query_opt(ECONOMY_PREVIOUS_BAND_SQL, &[&ECONOMY_SETTINGS_ROW_ID])
        .await?;
    let stored = row
        .as_ref()
        .and_then(|r| {
            r.try_get::<_, Option<f64>>("black_market_price_band_percent")
                .ok()
                .flatten()
        })
        .filter(|v| v.is_finite());
    Ok(stored.unwrap_or(BAND_DEFAULT))
}

/// Node writes the KV flags as `'1'` / `'0'` strings.
fn flag_kv(on: bool) -> &'static str {
    if on {
        "1"
    } else {
        "0"
    }
}

async fn upsert_kv<C: GenericClient>(
    client: &C,
    entries: &[(&str, String)],
) -> Result<(), PlayerReadError> {
    for (key, value) in entries {
        let params: [&(dyn ToSql + Sync); 2] = [key, value];
        client.execute(KV_UPSERT_SQL, &params).await?;
    }
    Ok(())
}

pub async fn run_persist_economy_settings(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    // Non-object payloads never reach the DB: the check below is false for them
    // and `plan_economy_settings_persist` then rejects, like the Node service.
    let previous_band = if economy_needs_previous_band(payload) {
        load_previous_band(pool).await?
    } else {
        BAND_DEFAULT
    };
    let plan = plan_economy_settings_persist(payload, previous_band)?;

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    upsert_kv(
        &tx,
        &[
            (
                "hardware_market_enabled",
                flag_kv(plan.hardware_market_enabled != 0).to_string(),
            ),
            (
                "black_market_enabled",
                flag_kv(plan.black_market_enabled != 0).to_string(),
            ),
            ("market_tax_percent", js::number_to_string(plan.tax)),
            (
                "black_market_price_band_percent",
                js::number_to_string(plan.band),
            ),
        ],
    )
    .await?;
    tx.execute(
        ECONOMY_ROW_UPSERT_SQL,
        &[
            &ECONOMY_SETTINGS_ROW_ID,
            &plan.black_market_enabled,
            &plan.hardware_market_enabled,
            &plan.tax,
            &plan.band,
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(json!({}))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeSettingsPersistPlan {
    pub min: f64,
    pub fee: f64,
}

/// Node `planExchangeSettingsPersist`.
pub fn plan_exchange_settings_persist(
    payload: &Value,
) -> Result<ExchangeSettingsPersistPlan, PlayerReadError> {
    let body = require_object_payload(payload)?;
    let min = js::number_or_zero(field(body, "minExchangeAmount")).max(EXCHANGE_FLOOR);
    let fee = clamp(
        js::number_or_zero(field(body, "exchangeFeePercent")),
        EXCHANGE_FLOOR,
        EXCHANGE_FEE_MAX,
    );
    Ok(ExchangeSettingsPersistPlan { min, fee })
}

pub async fn run_persist_exchange_settings(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let plan = plan_exchange_settings_persist(payload)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    upsert_kv(
        &tx,
        &[
            ("exchange_min_usdc", js::number_to_string(plan.min)),
            ("exchange_fee_percent", js::number_to_string(plan.fee)),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(json!({}))
}

/// Node `planMonetizationSettingsPersist` — non-object payloads read as `{}`.
pub fn plan_monetization_settings_persist(payload: &Value) -> Vec<(&'static str, String)> {
    let empty = serde_json::Map::new();
    let body = match payload {
        Value::Object(m) => m,
        _ => &empty,
    };
    let reward = match body.get("applixirRewardMessage") {
        Some(Value::String(s)) => s.clone(),
        _ => DEFAULT_APPLIXIR_REWARD_MESSAGE.to_string(),
    };
    let secret = match body.get("applixirCallbackSecret") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    vec![
        (
            "applixir_enabled",
            flag_kv(js::truthy(body.get("applixirEnabled"))).to_string(),
        ),
        (
            "applixir_site_id",
            js::string_or_empty(body.get("applixirSiteId")),
        ),
        (
            "applixir_zone_id",
            js::string_or_empty(body.get("applixirZoneId")),
        ),
        (
            "applixir_account_id",
            js::string_or_empty(body.get("applixirAccountId")),
        ),
        ("applixir_reward_message", reward),
        ("applixir_callback_secret", secret),
        (
            "ezoic_enabled",
            flag_kv(js::truthy(body.get("ezoicEnabled"))).to_string(),
        ),
        (
            "ezoic_publisher_id",
            js::string_or_empty(body.get("ezoicPublisherId")),
        ),
        ("ezoic_app_id", js::string_or_empty(body.get("ezoicAppId"))),
        (
            "ezoic_placeholder_id",
            js::string_or_empty(body.get("ezoicPlaceholderId")),
        ),
    ]
}

pub async fn run_persist_monetization_settings(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let entries = plan_monetization_settings_persist(payload);
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    upsert_kv(&tx, &entries).await?;
    tx.commit().await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_paths_match_genesis_api_client() {
        assert_eq!(
            ECONOMY_SETTINGS_PERSIST_PATH,
            "/v1/settings/economy/persist"
        );
        assert_eq!(
            EXCHANGE_SETTINGS_PERSIST_PATH,
            "/v1/settings/exchange/persist"
        );
        assert_eq!(
            MONETIZATION_SETTINGS_PERSIST_PATH,
            "/v1/settings/monetization/persist"
        );
    }

    #[test]
    fn js_truthiness_matches_node() {
        assert!(!js::truthy(None));
        assert!(!js::truthy(Some(&json!(null))));
        assert!(!js::truthy(Some(&json!(false))));
        assert!(!js::truthy(Some(&json!(0))));
        assert!(!js::truthy(Some(&json!(""))));
        // `"0"` and `[]` are truthy in JS — the admin panel relies on it.
        assert!(js::truthy(Some(&json!("0"))));
        assert!(js::truthy(Some(&json!([]))));
        assert!(js::truthy(Some(&json!({}))));
        assert!(js::truthy(Some(&json!(true))));
        assert!(js::truthy(Some(&json!(1))));
    }

    #[test]
    fn js_number_matches_node() {
        assert!(js::number(None).is_nan());
        assert_eq!(js::number(Some(&json!(null))), 0.0);
        assert_eq!(js::number(Some(&json!(true))), 1.0);
        assert_eq!(js::number(Some(&json!("  12.5 "))), 12.5);
        assert_eq!(js::number(Some(&json!(""))), 0.0);
        assert!(js::number(Some(&json!("abc"))).is_nan());
        assert_eq!(js::number(Some(&json!([]))), 0.0);
        assert_eq!(js::number(Some(&json!([5]))), 5.0);
        assert!(js::number(Some(&json!([1, 2]))).is_nan());
        assert!(js::number(Some(&json!({}))).is_nan());
        assert_eq!(js::number_or_zero(Some(&json!("abc"))), 0.0);
        assert_eq!(js::number_or_zero(None), 0.0);
    }

    #[test]
    fn js_number_to_string_matches_node() {
        assert_eq!(js::number_to_string(0.0), "0");
        assert_eq!(js::number_to_string(20.0), "20");
        assert_eq!(js::number_to_string(2.5), "2.5");
        assert_eq!(js::number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js::number_to_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js::number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn economy_plan_clamps_and_flags() {
        let plan = plan_economy_settings_persist(
            &json!({
                "marketTaxPercent": 150,
                "blackMarketPriceBandPercent": 500,
                "blackMarketEnabled": true,
                "hardwareMarketEnabled": false
            }),
            BAND_DEFAULT,
        )
        .unwrap();
        assert_eq!(plan.tax, TAX_MAX);
        assert_eq!(plan.band, BAND_MAX);
        assert_eq!(plan.black_market_enabled, 1);
        assert_eq!(plan.hardware_market_enabled, 0);
    }

    #[test]
    fn economy_plan_negative_clamps_to_min() {
        let plan = plan_economy_settings_persist(
            &json!({ "marketTaxPercent": -5, "blackMarketPriceBandPercent": -1 }),
            BAND_DEFAULT,
        )
        .unwrap();
        assert_eq!(plan.tax, TAX_MIN);
        assert_eq!(plan.band, BAND_MIN);
    }

    #[test]
    fn economy_plan_invalid_band_reuses_previous() {
        let previous = 42.0;
        let plan =
            plan_economy_settings_persist(&json!({ "marketTaxPercent": 3 }), previous).unwrap();
        assert_eq!(plan.band, previous);
        assert!(economy_needs_previous_band(
            &json!({ "marketTaxPercent": 3 })
        ));
        assert!(!economy_needs_previous_band(
            &json!({ "blackMarketPriceBandPercent": 10 })
        ));
        // JS `Number(null) === 0` is finite, so no previous lookup happens.
        assert!(!economy_needs_previous_band(
            &json!({ "blackMarketPriceBandPercent": null })
        ));
    }

    #[test]
    fn economy_plan_null_payload_is_defaults() {
        let plan = plan_economy_settings_persist(&Value::Null, BAND_DEFAULT).unwrap();
        assert_eq!(plan.tax, 0.0);
        assert_eq!(plan.band, BAND_DEFAULT);
        assert_eq!(plan.black_market_enabled, 0);
        assert_eq!(plan.hardware_market_enabled, 0);
    }

    #[test]
    fn economy_plan_rejects_array_and_scalar() {
        for bad in [json!([1, 2]), json!(7), json!("x"), json!(true)] {
            let err = plan_economy_settings_persist(&bad, BAND_DEFAULT).unwrap_err();
            assert_eq!(err.http_status, 400);
            assert_eq!(err.error, ERR_INVALID_PAYLOAD);
        }
    }

    #[test]
    fn exchange_plan_clamps_fee_and_floors_min() {
        let plan = plan_exchange_settings_persist(&json!({
            "minExchangeAmount": -3,
            "exchangeFeePercent": 400
        }))
        .unwrap();
        assert_eq!(plan.min, EXCHANGE_FLOOR);
        assert_eq!(plan.fee, EXCHANGE_FEE_MAX);

        let plan = plan_exchange_settings_persist(&json!({
            "minExchangeAmount": "2.5",
            "exchangeFeePercent": "1.5"
        }))
        .unwrap();
        assert_eq!(plan.min, 2.5);
        assert_eq!(plan.fee, 1.5);
    }

    #[test]
    fn exchange_plan_rejects_array() {
        let err = plan_exchange_settings_persist(&json!([])).unwrap_err();
        assert_eq!(err.http_status, 400);
        assert_eq!(err.error, ERR_INVALID_PAYLOAD);
    }

    #[test]
    fn monetization_plan_keys_and_defaults() {
        let entries = plan_monetization_settings_persist(&json!({
            "applixirEnabled": 1,
            "applixirSiteId": 77,
            "ezoicEnabled": false
        }));
        let by_key: std::collections::HashMap<&str, String> = entries.into_iter().collect();
        assert_eq!(by_key["applixir_enabled"], "1");
        assert_eq!(by_key["applixir_site_id"], "77");
        assert_eq!(by_key["applixir_zone_id"], "");
        assert_eq!(
            by_key["applixir_reward_message"],
            DEFAULT_APPLIXIR_REWARD_MESSAGE
        );
        assert_eq!(by_key["applixir_callback_secret"], "");
        assert_eq!(by_key["ezoic_enabled"], "0");
        assert_eq!(by_key["ezoic_placeholder_id"], "");
    }

    #[test]
    fn monetization_plan_keeps_explicit_strings() {
        let entries = plan_monetization_settings_persist(&json!({
            "applixirRewardMessage": "",
            "applixirCallbackSecret": "s3cret"
        }));
        let by_key: std::collections::HashMap<&str, String> = entries.into_iter().collect();
        // `typeof '' === 'string'` in Node, so an empty message is stored as-is.
        assert_eq!(by_key["applixir_reward_message"], "");
        assert_eq!(by_key["applixir_callback_secret"], "s3cret");
    }

    #[test]
    fn monetization_plan_non_object_is_all_defaults() {
        let entries = plan_monetization_settings_persist(&json!([1, 2]));
        let by_key: std::collections::HashMap<&str, String> = entries.into_iter().collect();
        assert_eq!(by_key.len(), 10);
        assert_eq!(by_key["applixir_enabled"], "0");
        assert_eq!(by_key["ezoic_enabled"], "0");
        assert_eq!(
            by_key["applixir_reward_message"],
            DEFAULT_APPLIXIR_REWARD_MESSAGE
        );
    }
}
