//! Paid wheel spin — USDC debit + roll + grant unopened box + history/idem in one TX.
//!
//! Mirrors Node `paidWheelSpinAtomicInTransaction` in `server/modules/wheel/services/spin.ts`.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use serde_json::json;
use uuid::Uuid;

use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{
    assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH,
    TX_BUY_TIMEOUT_MS,
};
use crate::pg_types::pg_user_id;
use crate::shop::checkout::compute_advisory_lock_key64;

use super::errors::{
    WheelError, ERR_COOLDOWN, ERR_DAILY_LIMIT, ERR_GAME_STATE_NOT_FOUND,
    ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_INSUFFICIENT_USDC_SPIN, ERR_INVALID_SESSION,
    ERR_INVALID_SPIN_PRICE, ERR_INVALID_WEIGHTS, ERR_NO_PRIZES, ERR_PAID_WHEEL_DISABLED,
    ERR_PAID_WHEEL_ENDED, ERR_PAID_WHEEL_NOT_YET, ERR_WHEEL_CONFIG, HTTP_BAD_REQUEST,
};

/// Node `WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC`.
pub const WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC: f64 = 0.10;
/// Node `WHEEL_DEFAULT_SPIN_PRICE_USDC`.
pub const WHEEL_DEFAULT_SPIN_PRICE_USDC: f64 = 1.0;
/// Node `DEFAULT_WHEEL_CONFIG_ID`.
pub const DEFAULT_WHEEL_CONFIG_ID: i32 = 1;
/// Node `DEFAULT_MAX_SPINS_PER_REQUEST`.
pub const DEFAULT_MAX_SPINS_PER_REQUEST: i32 = 1;
/// Node `DEFAULT_COOLDOWN_SECONDS`.
pub const DEFAULT_COOLDOWN_SECONDS: i32 = 0;
/// Node `DECIMAL_FIXED_DIGITS`.
pub const DECIMAL_FIXED_DIGITS: i32 = 6;
/// Node `DISPLAY_NAME_MAX_LENGTH`.
pub const DISPLAY_NAME_MAX_LENGTH: usize = 200;
/// Node `MS_PER_SECOND`.
pub const MS_PER_SECOND: f64 = 1000.0;
/// Node spin idempotency scope.
pub const PAID_SPIN_SCOPE: &str = "paid_spin";
/// Node `MIN_PROBABILITY` / `MIN_QTY` in `ensureRoletaRewardBoxItem`.
pub const ROLETA_MIN_PROBABILITY: f64 = 100.0;
pub const ROLETA_MIN_QTY: i32 = 1;
/// Node prize trigger.
pub const ROLETA_REWARD_TRIGGER: &str = "roleta_reward";
pub const ROLETA_REWARD_ICON: &str = "🎁";
pub const DISPLAY_NAME_FALLBACK: &str = "Prêmio";

pub const WHEEL_PAID_SPIN_PATH: &str = "/v1/wheel/paid-spin";

const ADVISORY_LOCK_BIGINT_SQL: &str = "SELECT pg_advisory_xact_lock($1::bigint)";
const SELECT_IDEM_SQL: &str =
    "SELECT response_json FROM wheel_idempotency WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3";
const UPSERT_IDEM_SQL: &str = "INSERT INTO wheel_idempotency (user_id, scope, idempotency_key, response_json, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, scope, idempotency_key) DO UPDATE SET response_json = EXCLUDED.response_json, created_at = EXCLUDED.created_at";
const SELECT_SPIN_BY_IDEM_SQL: &str =
    "SELECT id, won_item_id, box_id, charged_usdc::double precision AS charged_usdc
     FROM wheel_spins WHERE user_id = $1 AND idempotency_key = $2 AND kind = 'paid' LIMIT 1";
const SELECT_USDC_SQL: &str =
    "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1";
const SELECT_USDC_FOR_UPDATE_SQL: &str =
    "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
// `$2` is a bound f64 — cast it `::float8::numeric` (concrete source type) so
// tokio-postgres infers the param as float8, not numeric (which it can't
// serialize an f64 into: "error serializing parameter 1").
const PAY_USDC_SQL: &str = "UPDATE game_states
    SET usdc = (COALESCE(usdc::numeric, 0) - $2::float8::numeric)::double precision,
        last_updated_at = $3,
        server_updated_at = $3
    WHERE user_id = $1 AND (COALESCE(usdc::numeric, 0) >= $2::float8::numeric)
    RETURNING usdc::double precision AS usdc";
const SELECT_CONFIG_SQL: &str = "SELECT id,
            spin_price_usdc::double precision AS spin_price_usdc,
            min_spin_price_usdc::double precision AS min_spin_price_usdc,
            currency, is_enabled, max_spins_per_request, daily_limit, cooldown_seconds,
            starts_at, ends_at
     FROM wheel_config WHERE id = $1";
const INSERT_CONFIG_SQL: &str = "INSERT INTO wheel_config (
        id, spin_price_usdc, currency, is_enabled, min_spin_price_usdc,
        max_spins_per_request, daily_limit, cooldown_seconds, starts_at, ends_at, updated_at, metadata_json
     ) VALUES ($1, $2, 'USDC', 1, $2, $3, NULL, $4, NULL, NULL, $5, NULL)
     ON CONFLICT (id) DO NOTHING";
const SELECT_PENDING_SQL: &str =
    "SELECT won_item_id FROM wheel_paid_pending WHERE user_id = $1 FOR UPDATE";
const DELETE_PENDING_SQL: &str = "DELETE FROM wheel_paid_pending WHERE user_id = $1";
const COUNT_DAILY_SPINS_SQL: &str = "SELECT COUNT(*)::bigint AS c FROM wheel_spins
     WHERE user_id = $1 AND kind = 'paid' AND created_at >= $2";
const SELECT_LAST_SPIN_SQL: &str =
    "SELECT created_at FROM wheel_spins WHERE user_id = $1 AND kind = 'paid' ORDER BY created_at DESC LIMIT 1";
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
const SELECT_PRIZE_BY_ITEM_SQL: &str = "SELECT wp.id,
           wp.label AS stored_label,
           wp.weight::double precision AS weight,
           wp.color,
           wp.item_id,
           u.name AS upgrade_name,
           u.image AS upgrade_image
    FROM wheel_prizes wp
    LEFT JOIN upgrades u ON u.id = wp.item_id
    WHERE wp.item_id = $1
    LIMIT 1";
const SELECT_LOOT_BOX_BY_REWARD_SQL: &str =
    "SELECT id FROM loot_boxes WHERE trigger = $1 AND description = $2 LIMIT 1";
const SELECT_UPGRADE_NAME_SQL: &str = "SELECT name FROM upgrades WHERE id = $1 LIMIT 1";
const INSERT_LOOT_BOX_SQL: &str =
    "INSERT INTO loot_boxes (id, name, description, price, trigger, icon)
     VALUES ($1, $2, $3, 0, $4, $5)";
const SELECT_LOOT_BOX_ITEM_SQL: &str =
    "SELECT id, probability::double precision AS probability, min_qty, max_qty
     FROM loot_box_items WHERE box_id = $1 AND item_id = $2 AND item_type = 'item' LIMIT 1";
const UPDATE_LOOT_BOX_ITEM_SQL: &str =
    "UPDATE loot_box_items SET probability = $2, min_qty = $3, max_qty = $4 WHERE id = $1";
const INSERT_LOOT_BOX_ITEM_SQL: &str =
    "INSERT INTO loot_box_items (box_id, item_type, item_id, min_qty, max_qty, probability)
     VALUES ($1, 'item', $2, $3, $3, $4)";
const SELECT_BOX_NAME_SQL: &str = "SELECT name FROM loot_boxes WHERE id = $1";
const UPSERT_UNOPENED_SQL: &str =
    "INSERT INTO unopened_boxes (user_id, box_id, qty) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, box_id) DO UPDATE SET qty = unopened_boxes.qty + 1";
const INSERT_SPIN_SQL: &str = "INSERT INTO wheel_spins (
        id, user_id, kind, code, won_item_id, box_id, charged_usdc, status, idempotency_key, created_at
     ) VALUES ($1, $2, 'paid', NULL, $3, $4, $5::float8::numeric, 'completed', $6, $7)";

#[derive(Debug, Clone)]
pub struct WheelPrizeDto {
    pub id: String,
    pub label: String,
    pub weight: f64,
    pub color: Option<String>,
    pub item_id: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PaidSpinOutcome {
    pub spin_id: String,
    pub won_item_id: String,
    pub item: Option<WheelPrizeDto>,
    pub new_usdc: f64,
    pub charged_usdc: f64,
    pub box_id: String,
    pub box_name: String,
    pub idempotent_replay: bool,
}

fn market_to_wheel(e: MarketError) -> WheelError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => WheelError::Domain {
            status,
            error,
            code,
        },
        MarketError::Transport(err) => WheelError::Transport(err),
    }
}

fn normalize_idem_key(raw: &str) -> Result<String, WheelError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(WheelError::bad(ERR_IDEMPOTENCY_KEY_REQUIRED));
    }
    Ok(key)
}

fn round_usdc(v: f64) -> f64 {
    let factor = 10f64.powi(DECIMAL_FIXED_DIGITS);
    (v * factor).round() / factor
}

fn sanitize_display_name(raw: &str, max_chars: usize) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| {
            let u = *c as u32;
            u >= 0x20 && *c != '<' && *c != '>'
        })
        .collect();
    let trimmed = cleaned.trim();
    // Char-safe truncate (Node `slice(0, maxLen)`); never `String::truncate` on byte len.
    let s: String = if trimmed.chars().count() > max_chars {
        trimmed.chars().take(max_chars).collect()
    } else {
        trimmed.to_string()
    };
    if s.is_empty() {
        DISPLAY_NAME_FALLBACK.to_string()
    } else {
        s
    }
}

fn utc_day_start_ms(now_ms: i64) -> i64 {
    let day_ms = genesis_core::time::MS_PER_DAY as i64;
    now_ms.div_euclid(day_ms) * day_ms
}

pub(crate) fn map_prize_row(row: &tokio_postgres::Row) -> WheelPrizeDto {
    let stored_label: String = row.get("stored_label");
    let upgrade_name: Option<String> = row.get("upgrade_name");
    let label = upgrade_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(stored_label.as_str())
        .to_string();
    let upgrade_image: Option<String> = row.get("upgrade_image");
    let image = upgrade_image
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let color: Option<String> = row.get("color");
    let item_id: Option<String> = row.get("item_id");
    WheelPrizeDto {
        id: row.get("id"),
        label,
        weight: row.get("weight"),
        color,
        item_id: item_id.unwrap_or_default(),
        image,
    }
}

fn random_unit() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    let u = u64::from_le_bytes(bytes);
    (u as f64) / (u64::MAX as f64)
}

pub(crate) fn pick_weighted_prize(prizes: &[WheelPrizeDto]) -> Result<&WheelPrizeDto, WheelError> {
    let weights: Vec<f64> = prizes
        .iter()
        .map(|p| {
            if p.weight.is_finite() && p.weight >= 0.0 {
                p.weight
            } else {
                0.0
            }
        })
        .collect();
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return Err(WheelError::internal(ERR_INVALID_WEIGHTS));
    }
    let mut r = random_unit() * total;
    for (i, w) in weights.iter().enumerate() {
        if r < *w {
            return Ok(&prizes[i]);
        }
        r -= w;
    }
    Ok(prizes.last().expect("non-empty prizes"))
}

/// Eligible prizes for promo roll (same SQL as paid spin).
pub(crate) async fn load_prizes_eligible_for_roll<C: GenericClient>(
    client: &C,
) -> Result<Vec<WheelPrizeDto>, WheelError> {
    let rows = client
        .query(SELECT_PRIZES_SQL, &[])
        .await
        .map_err(WheelError::transport)?;
    Ok(rows.iter().map(map_prize_row).collect())
}

pub(crate) async fn query_prize_by_item_id<C: GenericClient>(
    client: &C,
    item_id: &str,
) -> Result<Option<WheelPrizeDto>, WheelError> {
    let rows = client
        .query(SELECT_PRIZE_BY_ITEM_SQL, &[&item_id])
        .await
        .map_err(WheelError::transport)?;
    Ok(rows.first().map(map_prize_row))
}

fn resolve_effective_paid_spin_price(spin_price: f64, min_from_config: f64) -> f64 {
    let mut eff = if spin_price > min_from_config {
        spin_price
    } else {
        min_from_config
    };
    if eff < WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC {
        eff = WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC;
    }
    eff
}

async fn set_wheel_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), WheelError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WheelError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WheelError::transport)?;
    Ok(())
}

async fn ensure_roleta_reward_box_item<C: GenericClient>(
    client: &C,
    box_id: &str,
    won_item_id: &str,
) -> Result<(), WheelError> {
    let rows = client
        .query(SELECT_LOOT_BOX_ITEM_SQL, &[&box_id, &won_item_id])
        .await
        .map_err(WheelError::transport)?;
    if let Some(row) = rows.first() {
        let id: i32 = row.get("id");
        let prob: f64 = row.get("probability");
        let min_qty: i32 = row.get("min_qty");
        let max_qty: i32 = row.get("max_qty");
        let prob_ok = prob > 0.0;
        let min_ok = min_qty >= ROLETA_MIN_QTY;
        let max_ok = max_qty >= min_qty.max(ROLETA_MIN_QTY);
        if prob_ok && min_ok && max_ok {
            return Ok(());
        }
        let new_prob = if prob_ok {
            prob
        } else {
            ROLETA_MIN_PROBABILITY
        };
        let new_min = if min_ok { min_qty } else { ROLETA_MIN_QTY };
        let new_max = if max_ok {
            max_qty
        } else {
            ROLETA_MIN_QTY.max(min_qty)
        };
        client
            .execute(
                UPDATE_LOOT_BOX_ITEM_SQL,
                &[&id, &new_prob, &new_min, &new_max],
            )
            .await
            .map_err(WheelError::transport)?;
        return Ok(());
    }
    client
        .execute(
            INSERT_LOOT_BOX_ITEM_SQL,
            &[
                &box_id,
                &won_item_id,
                &ROLETA_MIN_QTY,
                &ROLETA_MIN_PROBABILITY,
            ],
        )
        .await
        .map_err(WheelError::transport)?;
    Ok(())
}

pub(crate) async fn grant_wheel_prize_unopened_box<C: GenericClient>(
    client: &C,
    user_id: i64,
    won_item_id: &str,
) -> Result<(String, String), WheelError> {
    let uid_pg = pg_user_id(user_id).map_err(WheelError::transport)?;
    let desc = format!("reward_for_{won_item_id}");
    let existing = client
        .query(
            SELECT_LOOT_BOX_BY_REWARD_SQL,
            &[&ROLETA_REWARD_TRIGGER, &desc],
        )
        .await
        .map_err(WheelError::transport)?;

    let prize_box_id = if let Some(row) = existing.first() {
        let id: String = row.get("id");
        id
    } else {
        let prize_box_id = Uuid::new_v4().to_string();
        let upg = client
            .query(SELECT_UPGRADE_NAME_SQL, &[&won_item_id])
            .await
            .map_err(WheelError::transport)?;
        let raw_name: String = upg
            .first()
            .map(|r| r.get::<_, String>("name"))
            .unwrap_or_else(|| won_item_id.to_string());
        let item_name = sanitize_display_name(&raw_name, DISPLAY_NAME_MAX_LENGTH);
        let box_name = format!("Prêmio: {item_name}");
        client
            .execute(
                INSERT_LOOT_BOX_SQL,
                &[
                    &prize_box_id,
                    &box_name,
                    &desc,
                    &ROLETA_REWARD_TRIGGER,
                    &ROLETA_REWARD_ICON,
                ],
            )
            .await
            .map_err(WheelError::transport)?;
        prize_box_id
    };

    ensure_roleta_reward_box_item(client, &prize_box_id, won_item_id).await?;

    let box_rows = client
        .query(SELECT_BOX_NAME_SQL, &[&prize_box_id])
        .await
        .map_err(WheelError::transport)?;
    let box_name_raw: String = box_rows
        .first()
        .map(|r| r.get::<_, String>("name"))
        .unwrap_or_else(|| DISPLAY_NAME_FALLBACK.to_string());
    let box_name = sanitize_display_name(&box_name_raw, DISPLAY_NAME_MAX_LENGTH);

    client
        .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &prize_box_id])
        .await
        .map_err(WheelError::transport)?;

    Ok((prize_box_id, box_name))
}

async fn load_wheel_config<C: GenericClient>(
    client: &C,
    now_ms: i64,
) -> Result<tokio_postgres::Row, WheelError> {
    let rows = client
        .query(SELECT_CONFIG_SQL, &[&DEFAULT_WHEEL_CONFIG_ID])
        .await
        .map_err(WheelError::transport)?;
    if let Some(row) = rows.into_iter().next() {
        return Ok(row);
    }
    client
        .execute(
            INSERT_CONFIG_SQL,
            &[
                &DEFAULT_WHEEL_CONFIG_ID,
                &WHEEL_DEFAULT_SPIN_PRICE_USDC,
                &DEFAULT_MAX_SPINS_PER_REQUEST,
                &DEFAULT_COOLDOWN_SECONDS,
                &now_ms,
            ],
        )
        .await
        .map_err(WheelError::transport)?;
    let rows = client
        .query(SELECT_CONFIG_SQL, &[&DEFAULT_WHEEL_CONFIG_ID])
        .await
        .map_err(WheelError::transport)?;
    rows.into_iter()
        .next()
        .ok_or_else(|| WheelError::internal(ERR_WHEEL_CONFIG))
}

fn prize_to_json(p: &WheelPrizeDto) -> serde_json::Value {
    json!({
        "id": p.id,
        "label": p.label,
        "weight": p.weight,
        "color": p.color,
        "item_id": p.item_id,
        "image": p.image,
    })
}

fn outcome_to_json(out: &PaidSpinOutcome) -> Result<String, WheelError> {
    let item = out.item.as_ref().map(prize_to_json);
    serde_json::to_string(&json!({
        "spinId": out.spin_id,
        "wonItemId": out.won_item_id,
        "item": item,
        "newUsdc": out.new_usdc,
        "chargedUsdc": out.charged_usdc,
        "boxId": out.box_id,
        "boxName": out.box_name,
        "idempotentReplay": out.idempotent_replay,
    }))
    .map_err(WheelError::transport)
}

fn parse_cached_outcome(raw: &str) -> Option<PaidSpinOutcome> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let spin_id = v.get("spinId")?.as_str()?.to_string();
    let won_item_id = v.get("wonItemId")?.as_str()?.to_string();
    if spin_id.is_empty() || won_item_id.is_empty() {
        return None;
    }
    let item = v.get("item").and_then(|it| {
        if it.is_null() {
            return None;
        }
        Some(WheelPrizeDto {
            id: it.get("id")?.as_str()?.to_string(),
            label: it.get("label")?.as_str()?.to_string(),
            weight: it.get("weight")?.as_f64()?,
            color: it.get("color").and_then(|c| c.as_str().map(str::to_string)),
            item_id: it.get("item_id")?.as_str()?.to_string(),
            image: it.get("image").and_then(|c| c.as_str().map(str::to_string)),
        })
    });
    Some(PaidSpinOutcome {
        spin_id,
        won_item_id,
        item,
        new_usdc: v.get("newUsdc")?.as_f64()?,
        charged_usdc: v.get("chargedUsdc")?.as_f64()?,
        box_id: v.get("boxId")?.as_str()?.to_string(),
        box_name: v.get("boxName")?.as_str()?.to_string(),
        idempotent_replay: true,
    })
}

pub async fn paid_spin(
    pool: &Pool,
    user_id: i64,
    idempotency_key: &str,
    server_now_ms: Option<i64>,
) -> Result<PaidSpinOutcome, WheelError> {
    if user_id <= 0 {
        return Err(WheelError::unauthorized(ERR_INVALID_SESSION));
    }
    let idem_key = normalize_idem_key(idempotency_key)?;
    let now_ms = server_now_ms
        .filter(|n| *n > 0)
        .unwrap_or_else(current_unix_ms);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(WheelError::transport)?;
    set_wheel_tx_timeouts(&tx).await?;
    match paid_spin_on_tx(&tx, user_id, &idem_key, now_ms).await {
        Ok(v) => {
            tx.commit().await.map_err(WheelError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn paid_spin_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    idem_key: &str,
    now_ms: i64,
) -> Result<PaidSpinOutcome, WheelError> {
    assert_active_user(client, user_id)
        .await
        .map_err(market_to_wheel)?;
    let uid_pg = pg_user_id(user_id).map_err(WheelError::transport)?;

    let lock_key = compute_advisory_lock_key64(user_id, PAID_SPIN_SCOPE, idem_key);
    client
        .execute(ADVISORY_LOCK_BIGINT_SQL, &[&lock_key])
        .await
        .map_err(WheelError::transport)?;

    let idem_rows = client
        .query(SELECT_IDEM_SQL, &[&uid_pg, &PAID_SPIN_SCOPE, &idem_key])
        .await
        .map_err(WheelError::transport)?;
    if let Some(row) = idem_rows.first() {
        let raw: String = row.get("response_json");
        if let Some(cached) = parse_cached_outcome(&raw) {
            return Ok(cached);
        }
    }

    let spin_rows = client
        .query(SELECT_SPIN_BY_IDEM_SQL, &[&uid_pg, &idem_key])
        .await
        .map_err(WheelError::transport)?;
    if let Some(spin) = spin_rows.first() {
        let spin_id: String = spin.get("id");
        let won_item_id: Option<String> = spin.get("won_item_id");
        if let Some(won) = won_item_id.filter(|s| !s.is_empty()) {
            let prize_rows = client
                .query(SELECT_PRIZE_BY_ITEM_SQL, &[&won])
                .await
                .map_err(WheelError::transport)?;
            let item = prize_rows.first().map(map_prize_row);
            let gs = client
                .query(SELECT_USDC_SQL, &[&uid_pg])
                .await
                .map_err(WheelError::transport)?;
            let new_usdc: f64 = gs.first().map(|r| r.get::<_, f64>("usdc")).unwrap_or(0.0);
            let charged: Option<f64> = spin.get("charged_usdc");
            let box_id: Option<String> = spin.get("box_id");
            let box_id = box_id.unwrap_or_default();
            let box_name = if box_id.is_empty() {
                DISPLAY_NAME_FALLBACK.to_string()
            } else {
                let bn = client
                    .query(SELECT_BOX_NAME_SQL, &[&box_id])
                    .await
                    .map_err(WheelError::transport)?;
                let raw: String = bn
                    .first()
                    .map(|r| r.get::<_, String>("name"))
                    .unwrap_or_else(|| DISPLAY_NAME_FALLBACK.to_string());
                sanitize_display_name(&raw, DISPLAY_NAME_MAX_LENGTH)
            };
            return Ok(PaidSpinOutcome {
                spin_id,
                won_item_id: won,
                item,
                new_usdc,
                charged_usdc: charged.unwrap_or(0.0),
                box_id,
                box_name,
                idempotent_replay: true,
            });
        }
    }

    let cfg = load_wheel_config(client, now_ms).await?;
    let is_enabled: i32 = cfg.get("is_enabled");
    if is_enabled != 1 {
        return Err(WheelError::unprocessable(ERR_PAID_WHEEL_DISABLED));
    }
    let starts_at: Option<i64> = cfg.get("starts_at");
    let ends_at: Option<i64> = cfg.get("ends_at");
    if let Some(starts) = starts_at {
        if now_ms < starts {
            return Err(WheelError::unprocessable(ERR_PAID_WHEEL_NOT_YET));
        }
    }
    if let Some(ends) = ends_at {
        if now_ms > ends {
            return Err(WheelError::unprocessable(ERR_PAID_WHEEL_ENDED));
        }
    }

    let pend = client
        .query(SELECT_PENDING_SQL, &[&uid_pg])
        .await
        .map_err(WheelError::transport)?;
    if !pend.is_empty() {
        let legacy_won: Option<String> = pend[0].get("won_item_id");
        if let Some(legacy) = legacy_won
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            let _ = grant_wheel_prize_unopened_box(client, user_id, &legacy).await?;
        }
        client
            .execute(DELETE_PENDING_SQL, &[&uid_pg])
            .await
            .map_err(WheelError::transport)?;
    }

    let spin_price: f64 = cfg.get("spin_price_usdc");
    let min_price: f64 = cfg.get("min_spin_price_usdc");
    let price_num = round_usdc(resolve_effective_paid_spin_price(spin_price, min_price));
    if !price_num.is_finite() || price_num < WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC {
        return Err(WheelError::unprocessable(ERR_INVALID_SPIN_PRICE));
    }

    let daily_limit: Option<i32> = cfg.get("daily_limit");
    if let Some(limit) = daily_limit {
        if limit > 0 {
            let day_start = utc_day_start_ms(now_ms);
            let cnt = client
                .query(COUNT_DAILY_SPINS_SQL, &[&uid_pg, &day_start])
                .await
                .map_err(WheelError::transport)?;
            let c: i64 = cnt.first().map(|r| r.get("c")).unwrap_or(0);
            if c >= i64::from(limit) {
                return Err(WheelError::unprocessable(ERR_DAILY_LIMIT));
            }
        }
    }

    let cooldown: Option<i32> = cfg.get("cooldown_seconds");
    let cd = cooldown.unwrap_or(DEFAULT_COOLDOWN_SECONDS);
    if cd > 0 {
        let last_rows = client
            .query(SELECT_LAST_SPIN_SQL, &[&uid_pg])
            .await
            .map_err(WheelError::transport)?;
        if let Some(last) = last_rows.first() {
            let created_at: i64 = last.get("created_at");
            let elapsed_sec = (now_ms - created_at) as f64 / MS_PER_SECOND;
            if elapsed_sec < f64::from(cd) {
                return Err(WheelError::unprocessable(ERR_COOLDOWN));
            }
        }
    }

    let gs_rows = client
        .query(SELECT_USDC_FOR_UPDATE_SQL, &[&uid_pg])
        .await
        .map_err(WheelError::transport)?;
    let Some(gs) = gs_rows.first() else {
        return Err(WheelError::domain(
            HTTP_BAD_REQUEST,
            ERR_GAME_STATE_NOT_FOUND,
        ));
    };
    let bal: f64 = gs.get("usdc");
    if bal < price_num {
        return Err(WheelError::unprocessable(ERR_INSUFFICIENT_USDC_SPIN));
    }

    let pay_rows = client
        .query(PAY_USDC_SQL, &[&uid_pg, &price_num, &now_ms])
        .await
        .map_err(WheelError::transport)?;
    let Some(pay) = pay_rows.first() else {
        return Err(WheelError::unprocessable(ERR_INSUFFICIENT_USDC_SPIN));
    };
    let new_usdc: f64 = pay.get("usdc");

    let prize_rows = client
        .query(SELECT_PRIZES_SQL, &[])
        .await
        .map_err(WheelError::transport)?;
    if prize_rows.is_empty() {
        return Err(WheelError::internal(ERR_NO_PRIZES));
    }
    let prizes: Vec<WheelPrizeDto> = prize_rows.iter().map(map_prize_row).collect();
    let selected = pick_weighted_prize(&prizes)?;
    let spin_id = Uuid::new_v4().to_string();

    let (box_id, box_name) =
        grant_wheel_prize_unopened_box(client, user_id, &selected.item_id).await?;

    client
        .execute(
            INSERT_SPIN_SQL,
            &[
                &spin_id,
                &uid_pg,
                &selected.item_id,
                &box_id,
                &price_num,
                &idem_key,
                &now_ms,
            ],
        )
        .await
        .map_err(WheelError::transport)?;

    let out = PaidSpinOutcome {
        spin_id,
        won_item_id: selected.item_id.clone(),
        item: Some(selected.clone()),
        new_usdc,
        charged_usdc: price_num,
        box_id,
        box_name,
        idempotent_replay: false,
    };
    let response_json = outcome_to_json(&out)?;
    client
        .execute(
            UPSERT_IDEM_SQL,
            &[
                &uid_pg,
                &PAID_SPIN_SCOPE,
                &idem_key,
                &response_json,
                &now_ms,
            ],
        )
        .await
        .map_err(WheelError::transport)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_price_respects_absolute_floor() {
        assert_eq!(
            resolve_effective_paid_spin_price(0.05, 0.05),
            WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC
        );
        assert_eq!(resolve_effective_paid_spin_price(1.5, 1.0), 1.5);
        assert_eq!(resolve_effective_paid_spin_price(0.5, 1.0), 1.0);
    }

    #[test]
    fn utc_day_start_aligned() {
        let day_ms = genesis_core::time::MS_PER_DAY as i64;
        let noon = day_ms + day_ms / 2;
        let start = utc_day_start_ms(noon);
        assert_eq!(start % day_ms, 0);
        assert!(start <= noon);
        assert!(noon - start < day_ms);
    }

    #[test]
    fn pay_sql_fail_closed_on_balance() {
        assert!(PAY_USDC_SQL.contains("usdc::numeric, 0) >= $2"));
        assert!(INSERT_SPIN_SQL.contains("wheel_spins"));
        assert!(UPSERT_IDEM_SQL.contains("wheel_idempotency"));
    }

    #[test]
    fn sanitize_strips_control_and_angles() {
        assert_eq!(sanitize_display_name("<b>Hi\x00</b>", 200), "bHi/b");
    }

    #[test]
    fn sanitize_truncates_multibyte_on_char_boundary() {
        // "Prêmio" = P r ê m i o — ê is multi-byte UTF-8; byte truncate at 3 would panic.
        let name = "Prêmio Extra Long Name That Exceeds";
        let out = sanitize_display_name(name, 6);
        assert_eq!(out, "Prêmio");
        assert_eq!(out.chars().count(), 6);
        // Accented cluster mid-string: take 4 chars ending on ê.
        assert_eq!(sanitize_display_name("cafézinho", 4), "café");
        assert!(!sanitize_display_name("日本語名", 2).is_empty());
        assert_eq!(sanitize_display_name("日本語名", 2).chars().count(), 2);
    }
}
