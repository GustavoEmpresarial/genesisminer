//! Roleta / Wheel **admin editor** — ports `server/modules/wheel/services/admin.ts`
//! (Express, deleted). Admin auth stays in `genesis-api` (`admin_wheel.rs`,
//! tab `games`); this owns `wheel_prizes` / `wheel_config` / `wheel_players`.

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use super::errors::WheelError;

pub const WHEEL_ADMIN_PRIZES_PATH: &str = "/v1/wheel/admin/prizes";
pub const WHEEL_ADMIN_PRIZES_REPLACE_PATH: &str = "/v1/wheel/admin/prizes/replace";
pub const WHEEL_ADMIN_RUNTIME_CONFIG_PATH: &str = "/v1/wheel/admin/runtime-config";
pub const WHEEL_ADMIN_RUNTIME_CONFIG_SET_PATH: &str = "/v1/wheel/admin/runtime-config/set";
pub const WHEEL_ADMIN_PLAYERS_PATH: &str = "/v1/wheel/admin/players";
pub const WHEEL_ADMIN_PLAYERS_ADD_PATH: &str = "/v1/wheel/admin/players/add";

const WHEEL_CONFIG_ROW_ID: i32 = 1;
const DEFAULT_TIER: &str = "BASIC";
const TIER_MAX_LENGTH: usize = 32;
const CURRENCY_MAX_LENGTH: usize = 12;
const MIN_SPIN_PRICE_USDC: f64 = 0.10;

// ---------------------------------------------------------------------------
// Prizes
// ---------------------------------------------------------------------------

pub async fn run_admin_wheel_prizes_list(pool: &Pool) -> Result<Value, WheelError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT id, label, weight, color, item_id, is_active, tier
               FROM wheel_prizes ORDER BY id ASC",
            &[],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let is_active: Option<i32> = r.try_get("is_active").ok().flatten();
            let tier: Option<String> = r.try_get("tier").ok().flatten();
            let item_id: Option<String> = r.try_get("item_id").ok().flatten();
            json!({
                "id": r.get::<_, String>("id"),
                "label": r.get::<_, String>("label"),
                "color": r.try_get::<_, Option<String>>("color").ok().flatten(),
                "weight": r.get::<_, i32>("weight"),
                "itemId": item_id.unwrap_or_default(),
                "isActive": is_active.unwrap_or(1),
                "tier": tier.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| DEFAULT_TIER.to_string()),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub async fn run_admin_wheel_prizes_replace(pool: &Pool, body: &Value) -> Result<Value, WheelError> {
    let items = body
        .get("prizes")
        .and_then(Value::as_array)
        .ok_or_else(|| WheelError::bad("Invalid prize list"))?;

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    tx.execute("DELETE FROM wheel_prizes", &[]).await?;
    for item in items {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let label = item.get("label").and_then(Value::as_str).unwrap_or("").to_string();
        let color = item.get("color").and_then(Value::as_str).unwrap_or("").to_string();
        let weight = item
            .get("weight")
            .and_then(|v| v.as_f64())
            .map(|f| f as i32)
            .unwrap_or(0);
        let item_id: Option<String> = item
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let is_active = match item.get("isActive") {
            Some(Value::Bool(false)) => 0,
            Some(Value::Number(n)) if n.as_i64() == Some(0) => 0,
            _ => 1,
        };
        let tier: String = item
            .get("tier")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(TIER_MAX_LENGTH).collect())
            .unwrap_or_else(|| DEFAULT_TIER.to_string());
        tx.execute(
            "INSERT INTO wheel_prizes (id, label, weight, color, item_id, is_active, tier)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[&id, &label, &weight, &color, &item_id, &is_active, &tier],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Runtime config (wheel_config row id = 1)
// ---------------------------------------------------------------------------

pub async fn run_admin_wheel_runtime_config_get(pool: &Pool) -> Result<Value, WheelError> {
    let client = pool.get().await?;
    let row = client
        .query_opt(
            "SELECT spin_price_usdc::double precision AS spin_price_usdc,
                    min_spin_price_usdc::double precision AS min_spin_price_usdc,
                    currency, is_enabled, max_spins_per_request, daily_limit,
                    cooldown_seconds, starts_at, ends_at, updated_at
               FROM wheel_config WHERE id = $1",
            &[&WHEEL_CONFIG_ROW_ID],
        )
        .await?;
    let Some(r) = row else {
        return Err(WheelError::not_found("wheel_config não encontrada"));
    };
    let starts_at: Option<i64> = r.try_get("starts_at").ok().flatten();
    let ends_at: Option<i64> = r.try_get("ends_at").ok().flatten();
    let daily_limit: Option<i32> = r.try_get("daily_limit").ok().flatten();
    Ok(json!({
        "spinPriceUsdc": r.get::<_, f64>("spin_price_usdc"),
        "minSpinPriceUsdc": r.get::<_, f64>("min_spin_price_usdc"),
        "currency": r.get::<_, String>("currency"),
        "isEnabled": r.get::<_, i32>("is_enabled") == 1,
        "maxSpinsPerRequest": r.get::<_, i32>("max_spins_per_request"),
        "dailyLimit": daily_limit,
        "cooldownSeconds": r.get::<_, i32>("cooldown_seconds"),
        "startsAtMs": starts_at.map(|v| v.to_string()),
        "endsAtMs": ends_at.map(|v| v.to_string()),
        "updatedAtMs": r.get::<_, i64>("updated_at").to_string(),
    }))
}

fn value_to_f64(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub async fn run_admin_wheel_runtime_config_set(pool: &Pool, body: &Value) -> Result<Value, WheelError> {
    let spin_raw = value_to_f64(body.get("spinPriceUsdc"));
    let Some(spin) = spin_raw else {
        return Err(WheelError::bad("spinPriceUsdc obrigatório"));
    };
    let min = value_to_f64(body.get("minSpinPriceUsdc")).unwrap_or(spin);
    if spin + 1e-9 < MIN_SPIN_PRICE_USDC || min + 1e-9 < MIN_SPIN_PRICE_USDC {
        return Err(WheelError::unprocessable("Preço mínimo permitido: 0.10 USDC"));
    }
    let is_enabled = match body.get("isEnabled") {
        Some(Value::Bool(false)) => 0,
        Some(Value::Number(n)) if n.as_i64() == Some(0) => 0,
        _ => 1,
    };
    let max_spins = value_to_f64(body.get("maxSpinsPerRequest"))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as i32)
        .unwrap_or(1);
    let daily_limit: Option<i32> = match body.get("dailyLimit") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        other => value_to_f64(other).map(|n| n.floor().max(0.0) as i32),
    };
    let cooldown = value_to_f64(body.get("cooldownSeconds"))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.floor() as i32)
        .unwrap_or(0);
    let currency: String = body
        .get("currency")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(CURRENCY_MAX_LENGTH).collect())
        .unwrap_or_else(|| "USDC".to_string());
    let now_ms = now_ms();
    let spin_s = format!("{spin}");
    let min_s = format!("{min}");

    let client = pool.get().await?;
    client
        .execute(
            "INSERT INTO wheel_config
                (id, spin_price_usdc, min_spin_price_usdc, currency, is_enabled,
                 max_spins_per_request, daily_limit, cooldown_seconds,
                 starts_at, ends_at, updated_at, metadata_json)
             VALUES ($1, $2::text::numeric, $3::text::numeric, $4, $5, $6, $7, $8,
                     NULL, NULL, $9, NULL)
             ON CONFLICT (id) DO UPDATE SET
                spin_price_usdc = $2::text::numeric,
                min_spin_price_usdc = $3::text::numeric,
                is_enabled = $5,
                max_spins_per_request = $6,
                daily_limit = $7,
                cooldown_seconds = $8,
                updated_at = $9",
            &[
                &WHEEL_CONFIG_ROW_ID,
                &spin_s,
                &min_s,
                &currency,
                &is_enabled,
                &max_spins,
                &daily_limit,
                &cooldown,
                &now_ms,
            ],
        )
        .await?;
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Players allowlist
// ---------------------------------------------------------------------------

pub async fn run_admin_wheel_players_list(pool: &Pool) -> Result<Value, WheelError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT username, added_at FROM wheel_players ORDER BY added_at DESC",
            &[],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| json!({ "username": r.get::<_, String>("username"), "added_at": r.get::<_, i64>("added_at") }))
        .collect();
    Ok(Value::Array(out))
}

pub async fn run_admin_wheel_players_add(pool: &Pool, body: &Value) -> Result<Value, WheelError> {
    let username = body
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if username.is_empty() {
        return Err(WheelError::bad("Username required"));
    }
    let now_ms = now_ms();
    let client = pool.get().await?;
    client
        .execute(
            "INSERT INTO wheel_players (username, added_at) VALUES ($1, $2)
             ON CONFLICT (username) DO UPDATE SET added_at = $2",
            &[&username, &now_ms],
        )
        .await?;
    Ok(json!({ "ok": true }))
}

pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(WHEEL_ADMIN_PRIZES_PATH, "/v1/wheel/admin/prizes");
        assert_eq!(
            WHEEL_ADMIN_RUNTIME_CONFIG_SET_PATH,
            "/v1/wheel/admin/runtime-config/set"
        );
    }
}
