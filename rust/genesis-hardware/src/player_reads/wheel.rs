//! Wheel state + history — Node `GET /api/wheel/{state,history}`.

use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::pg_types::pg_user_id;
use crate::wheel::paid_spin::{
    DECIMAL_FIXED_DIGITS, DEFAULT_COOLDOWN_SECONDS, DEFAULT_MAX_SPINS_PER_REQUEST,
    DEFAULT_WHEEL_CONFIG_ID,
};

use super::{
    f64_cell, i32_cell, i64_cell, opt_f64_cell, opt_i32_cell, opt_string_cell, string_cell,
    PlayerReadError,
};

/// Node `HISTORY_STATE_TAKE`.
const HISTORY_STATE_TAKE: i64 = 8;
/// Node `HISTORY_DEFAULT_LIMIT`.
const HISTORY_DEFAULT_LIMIT: i64 = 20;
/// Node `HISTORY_MAX_LIMIT`.
const HISTORY_MAX_LIMIT: i64 = 50;
/// Node `UNIFORM_UI_WEIGHT`.
const UNIFORM_UI_WEIGHT: i32 = 1;
/// Node `SPIN_ID_MAX_LENGTH`.
const SPIN_ID_MAX_LENGTH: usize = 80;
const BLOCKED_FLAG: i32 = 1;
const CURRENCY_USDC: &str = "USDC";
const REWARD_NOT_GRANTED: i32 = 0;
const ROLETA_TYPE_PREFIX: &str = "roleta_%";
const ROLETA_TRIGGER: &str = "roleta_code";

const _: () = assert!(HISTORY_STATE_TAKE == 8);
const _: () = assert!(HISTORY_DEFAULT_LIMIT == 20);
const _: () = assert!(HISTORY_MAX_LIMIT == 50);
const _: () = assert!(UNIFORM_UI_WEIGHT == 1);
const _: () = assert!(SPIN_ID_MAX_LENGTH == 80);

const SELECT_CONFIG_SQL: &str = "SELECT id,
            spin_price_usdc::double precision AS spin_price_usdc,
            min_spin_price_usdc::double precision AS min_spin_price_usdc,
            currency, is_enabled, max_spins_per_request, daily_limit, cooldown_seconds,
            starts_at, ends_at
     FROM wheel_config WHERE id = $1";

const SELECT_PRIZES_SQL: &str = "SELECT wp.id,
           wp.label AS stored_label,
           wp.weight::double precision AS weight,
           wp.color,
           wp.item_id,
           u.name AS upgrade_name,
           u.image AS upgrade_image
    FROM wheel_prizes wp
    LEFT JOIN upgrades u ON u.id = wp.item_id
    WHERE COALESCE(wp.is_active, 1) = 1
      AND UPPER(TRIM(COALESCE(wp.tier, 'BASIC'))) IN ('BASIC', 'COMMON')
      AND UPPER(TRIM(COALESCE(wp.tier, 'BASIC'))) NOT IN ('LEGACY', 'PREMIUM', 'EPIC', 'LEGENDARY', 'RARE')
    ORDER BY wp.id ASC";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub spin_id: Option<String>,
}

pub async fn run_wheel_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    require_active_user(&conn, user_id).await?;
    let uid = pg_user_id(user_id)?;
    let cfg = load_runtime_config(&conn).await?;
    let prizes = load_prizes_for_api(&conn).await?;
    let gs = conn
        .query_opt(
            "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let usdc = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);
    let pend = conn
        .query_opt(
            "SELECT won_item_id FROM wheel_paid_pending WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let legacy_paid_pending = pend
        .as_ref()
        .and_then(|r| opt_string_cell(r, "won_item_id"))
        .map(|id| json!({ "wonItemId": id }));
    let recent = conn
        .query(
            "SELECT id, kind, won_item_id, charged_usdc::double precision AS charged_usdc, status, created_at
               FROM wheel_spins WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &HISTORY_STATE_TAKE],
        )
        .await?;
    let history = map_history(&conn, &recent).await?;
    let is_enabled = cfg
        .get("isEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let spin_price = cfg
        .get("spinPriceUsdc")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Ok(json!({
        "ok": true,
        "config": cfg,
        "paidWheelEnabled": is_enabled,
        "spinPriceUsdc": spin_price,
        "usdcBalance": usdc,
        "legacyPaidPending": legacy_paid_pending,
        "prizes": prizes,
        "history": history,
        "notice": "A roleta entrega apenas recompensas básicas de baixo impacto. O sorteio e o preço são definidos no servidor.",
    }))
}

pub async fn run_wheel_history(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    require_active_user(&conn, user_id).await?;
    let uid = pg_user_id(user_id)?;
    let lim = clamp_limit(limit);
    let rows = conn
        .query(
            "SELECT id, kind, won_item_id, charged_usdc::double precision AS charged_usdc, status, created_at
               FROM wheel_spins WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let history = map_history(&conn, &rows).await?;
    Ok(json!({ "ok": true, "history": history, "limit": lim }))
}

pub async fn run_wheel_spin(
    pool: &Pool,
    user_id: i64,
    spin_id: &str,
) -> Result<Value, PlayerReadError> {
    let spin = spin_id.trim();
    if spin.is_empty() || spin.len() > SPIN_ID_MAX_LENGTH {
        return Err(PlayerReadError::bad("Invalid spinId."));
    }
    let conn = pool.get().await?;
    require_active_user(&conn, user_id).await?;
    let uid = pg_user_id(user_id)?;
    let r = conn
        .query_opt(
            "SELECT id, kind, code, won_item_id, box_id,
                    charged_usdc::double precision AS charged_usdc, status, created_at
               FROM wheel_spins
              WHERE id = $1 AND user_id = $2",
            &[&spin, &uid],
        )
        .await?;
    let Some(r) = r else {
        return Err(PlayerReadError::not_found("Spin not found."));
    };
    let won = string_cell(&r, "won_item_id");
    let prize = conn
        .query_opt(
            "SELECT wp.label AS stored_label, u.name AS upgrade_name
               FROM wheel_prizes wp
               LEFT JOIN upgrades u ON u.id = wp.item_id
              WHERE wp.item_id = $1
              LIMIT 1",
            &[&won],
        )
        .await?;
    let label = prize
        .as_ref()
        .and_then(|p| {
            opt_string_cell(p, "upgrade_name").or_else(|| opt_string_cell(p, "stored_label"))
        })
        .unwrap_or_else(|| won.clone());
    Ok(json!({
        "spin": {
            "spinId": string_cell(&r, "id"),
            "kind": string_cell(&r, "kind"),
            "code": opt_string_cell(&r, "code"),
            "wonItemId": won,
            "label": label,
            "boxId": opt_string_cell(&r, "box_id"),
            "chargedUsdc": opt_f64_cell(&r, "charged_usdc"),
            "status": string_cell(&r, "status"),
            "createdAtMs": i64_cell(&r, "created_at").to_string(),
        }
    }))
}

pub async fn run_roleta_pending_code(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    require_active_user(&conn, user_id).await?;
    let uid = pg_user_id(user_id)?;
    let row = conn
        .query_opt(
            "SELECT r.code
               FROM promo_code_redemptions r
               INNER JOIN promo_codes p ON p.code = r.code
               LEFT JOIN loot_boxes lb ON lb.id = p.loot_box_id
              WHERE r.user_id = $1
                AND COALESCE(r.reward_granted, 1) = $2
                AND (p.type LIKE $3 OR lb.trigger = $4)
              ORDER BY r.redeemed_at DESC NULLS LAST
              LIMIT 1",
            &[
                &uid,
                &REWARD_NOT_GRANTED,
                &ROLETA_TYPE_PREFIX,
                &ROLETA_TRIGGER,
            ],
        )
        .await?;
    let code = row
        .as_ref()
        .and_then(|r| opt_string_cell(r, "code"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(json!({ "code": code }))
}

fn clamp_limit(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n >= 1 => n.min(HISTORY_MAX_LIMIT),
        _ => HISTORY_DEFAULT_LIMIT,
    }
}

async fn require_active_user<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<(), PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let row = client
        .query_opt("SELECT is_blocked FROM users WHERE id = $1", &[&uid])
        .await?;
    let Some(u) = row else {
        return Err(PlayerReadError::not_found("User not found."));
    };
    if i32_cell(&u, "is_blocked") == BLOCKED_FLAG {
        return Err(PlayerReadError::forbidden("Account blocked."));
    }
    Ok(())
}

async fn load_runtime_config<C: GenericClient>(client: &C) -> Result<Value, PlayerReadError> {
    let row = client
        .query_opt(SELECT_CONFIG_SQL, &[&DEFAULT_WHEEL_CONFIG_ID])
        .await?;
    let Some(c) = row else {
        return Ok(json!({
            "spinPriceUsdc": 0.0,
            "currency": CURRENCY_USDC,
            "isEnabled": false,
            "minSpinPriceUsdc": 0.0,
            "maxSpinsPerRequest": DEFAULT_MAX_SPINS_PER_REQUEST,
            "dailyLimit": Value::Null,
            "cooldownSeconds": DEFAULT_COOLDOWN_SECONDS,
            "startsAtMs": Value::Null,
            "endsAtMs": Value::Null,
        }));
    };
    let spin = round_fixed(f64_cell(&c, "spin_price_usdc"));
    let min_p = round_fixed(f64_cell(&c, "min_spin_price_usdc"));
    let eff = if spin > min_p { spin } else { min_p };
    Ok(json!({
        "spinPriceUsdc": eff,
        "currency": opt_string_cell(&c, "currency").unwrap_or_else(|| CURRENCY_USDC.to_string()),
        "isEnabled": i32_cell(&c, "is_enabled") == 1,
        "minSpinPriceUsdc": min_p,
        "maxSpinsPerRequest": opt_i32_cell(&c, "max_spins_per_request").unwrap_or(DEFAULT_MAX_SPINS_PER_REQUEST),
        "dailyLimit": opt_i32_cell(&c, "daily_limit"),
        "cooldownSeconds": opt_i32_cell(&c, "cooldown_seconds").unwrap_or(DEFAULT_COOLDOWN_SECONDS),
        "startsAtMs": opt_i64_as_string(&c, "starts_at"),
        "endsAtMs": opt_i64_as_string(&c, "ends_at"),
    }))
}

async fn load_prizes_for_api<C: GenericClient>(client: &C) -> Result<Vec<Value>, PlayerReadError> {
    let rows = client.query(SELECT_PRIZES_SQL, &[]).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let live = opt_string_cell(r, "upgrade_name");
            let stored = string_cell(r, "stored_label");
            json!({
                "id": string_cell(r, "id"),
                "label": live.unwrap_or(stored),
                "color": opt_string_cell(r, "color"),
                "weight": UNIFORM_UI_WEIGHT,
                "itemId": string_cell(r, "item_id"),
                "image": opt_string_cell(r, "upgrade_image"),
            })
        })
        .collect())
}

async fn map_history<C: GenericClient>(
    client: &C,
    rows: &[tokio_postgres::Row],
) -> Result<Vec<Value>, PlayerReadError> {
    let ids: Vec<String> = rows
        .iter()
        .map(|r| string_cell(r, "won_item_id"))
        .filter(|s| !s.is_empty())
        .collect();
    let prize_map = if ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        let prize_rows = client
            .query(
                "SELECT DISTINCT ON (wp.item_id)
                        wp.id, wp.label AS stored_label, wp.item_id, u.name AS upgrade_name
                   FROM wheel_prizes wp
                   LEFT JOIN upgrades u ON u.id = wp.item_id
                  WHERE wp.item_id = ANY($1::text[])
                  ORDER BY wp.item_id, wp.id",
                &[&ids],
            )
            .await?;
        let mut m = std::collections::HashMap::new();
        for r in &prize_rows {
            let item_id = string_cell(r, "item_id");
            let label = opt_string_cell(r, "upgrade_name")
                .unwrap_or_else(|| string_cell(r, "stored_label"));
            m.insert(item_id, label);
        }
        m
    };
    Ok(rows
        .iter()
        .map(|r| {
            let won = string_cell(r, "won_item_id");
            let charged = r.try_get::<_, Option<f64>>("charged_usdc").ok().flatten();
            json!({
                "spinId": string_cell(r, "id"),
                "kind": string_cell(r, "kind"),
                "wonItemId": won,
                "label": prize_map.get(&won).cloned().unwrap_or(won.clone()),
                "chargedUsdc": charged,
                "status": string_cell(r, "status"),
                "createdAtMs": i64_as_string(r, "created_at"),
            })
        })
        .collect())
}

fn round_fixed(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let factor = 10f64.powi(DECIMAL_FIXED_DIGITS);
    (v * factor).round() / factor
}

fn i64_as_string(row: &tokio_postgres::Row, col: &str) -> String {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v.to_string();
    }
    String::new()
}

fn opt_i64_as_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return Some(v.to_string());
    }
    None
}
