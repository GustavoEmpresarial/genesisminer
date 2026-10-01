//! Admin CRUD for `transparency_entries` — Node `server/modules/admin/transparency`.
//!
//! Single-table create / update / delete. Validation mirrors Node
//! `planCreateTransparencyEntry` / `planUpdateTransparencyEntry`; the returned
//! DTO shape is `player_reads::transparency::map_entry` (same as the public GET).

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use genesis_core::{HealthPeriodScope, HealthSettings};

use crate::player_reads::transparency::{load_health_settings, map_entry};
use crate::player_reads::PlayerReadError;

pub const TRANSPARENCY_ADMIN_CREATE_PATH: &str = "/v1/transparency/admin/create";
pub const TRANSPARENCY_ADMIN_UPDATE_PATH: &str = "/v1/transparency/admin/update";
pub const TRANSPARENCY_ADMIN_DELETE_PATH: &str = "/v1/transparency/admin/delete";

/// Node `TRANSPARENCY_TITLE_MAX` / `_BODY_MAX` / `_LINK_MAX`.
const TITLE_MAX: usize = 300;
const BODY_MAX: usize = 8000;
const LINK_MAX: usize = 2048;
/// Node `TRANSPARENCY_CATEGORIES` — `trade` is the income/"lucro" side of the
/// portal ledger (counts like `pool`); `expense` is the outflow/"prejuízo" side.
const CATEGORIES: [&str; 5] = ["pool", "trade", "expense", "investment", "other"];

const RETURNING: &str = "id, category, title, body,
        amount_usdc::double precision AS amount_usdc,
        link_url, period_ym, sort_order, created_at, updated_at";

/// Month-ledger key `YYYY-MM` (01-12), else `NULL` (standing / "Geral").
fn parse_period_ym(v: Option<&Value>) -> Option<String> {
    let s = match v {
        Some(Value::String(s)) => s.trim().to_string(),
        _ => return None,
    };
    if s.is_empty() || s == "geral" || s == "standing" {
        return None;
    }
    let b = s.as_bytes();
    if b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5].is_ascii_digit()
        && b[6].is_ascii_digit()
    {
        if let Ok(mm) = s[5..7].parse::<u32>() {
            if (1..=12).contains(&mm) {
                return Some(s);
            }
        }
    }
    None
}

fn bad(msg: &str) -> PlayerReadError {
    PlayerReadError::bad(msg)
}

fn obj(body: &Value) -> serde_json::Map<String, Value> {
    match body {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    }
}

/// Node `parseSortOrder`: `Math.floor(Number(x)) || 0`.
fn parse_sort_order(v: Option<&Value>) -> i32 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    if !n.is_finite() {
        return 0;
    }
    let f = n.floor();
    if f == 0.0 || f.abs() > i32::MAX as f64 {
        0
    } else {
        f as i32
    }
}

/// Node string coercion + trim for a text field (`String(x).trim()`).
fn str_field(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// Node amount parse: `null` / `""` → `None`; else `Number()` and reject NaN.
fn parse_amount(v: &Value) -> Result<Option<f64>, PlayerReadError> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| bad("Valor USDC inválido")),
        Value::Number(n) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .map(Some)
            .ok_or_else(|| bad("Valor USDC inválido")),
        _ => Err(bad("Valor USDC inválido")),
    }
}

struct WritePlan {
    category: String,
    title: String,
    body: Option<String>,
    amount_usdc: Option<f64>,
    link_url: Option<String>,
    period_ym: Option<String>,
    sort_order: i32,
}

fn plan_create(body: &Value) -> Result<WritePlan, PlayerReadError> {
    let b = obj(body);
    let category = b
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !CATEGORIES.contains(&category.as_str()) {
        return Err(bad("Categoria inválida"));
    }
    let title = b.get("title").map(str_field).unwrap_or_default();
    if title.is_empty() {
        return Err(bad("Título obrigatório"));
    }
    if title.chars().count() > TITLE_MAX {
        return Err(bad("Título longo demais"));
    }
    let desc = match b.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(v) => str_field(v),
    };
    if desc.chars().count() > BODY_MAX {
        return Err(bad("Descrição longa demais"));
    }
    let amount_usdc = match b.get("amountUsdc") {
        None => None,
        Some(v) => parse_amount(v)?,
    };
    let link = match b.get("linkUrl") {
        None | Some(Value::Null) => String::new(),
        Some(v) => str_field(v),
    };
    if link.chars().count() > LINK_MAX {
        return Err(bad("Link longo demais"));
    }
    Ok(WritePlan {
        category,
        title,
        body: (!desc.is_empty()).then_some(desc),
        amount_usdc,
        link_url: (!link.is_empty()).then_some(link),
        period_ym: parse_period_ym(b.get("periodYm")),
        sort_order: parse_sort_order(b.get("sortOrder")),
    })
}

struct Existing {
    category: String,
    title: String,
    body: Option<String>,
    amount_usdc: Option<f64>,
    link_url: Option<String>,
    period_ym: Option<String>,
    sort_order: i32,
}

fn plan_update(body: &Value, existing: &Existing) -> Result<WritePlan, PlayerReadError> {
    let b = obj(body);

    let category = match b.get("category") {
        None | Some(Value::Null) => existing.category.clone(),
        Some(v) => {
            let c = v.as_str().unwrap_or_default().to_string();
            if !CATEGORIES.contains(&c.as_str()) {
                return Err(bad("Categoria inválida"));
            }
            c
        }
    };

    let title = match b.get("title") {
        None | Some(Value::Null) => existing.title.clone(),
        Some(v) => {
            let t = str_field(v);
            if t.is_empty() {
                return Err(bad("Título obrigatório"));
            }
            if t.chars().count() > TITLE_MAX {
                return Err(bad("Título longo demais"));
            }
            t
        }
    };

    let body_val = match b.get("body") {
        None => existing.body.clone(),
        Some(Value::Null) => None,
        Some(v) => {
            let s = str_field(v);
            if s.chars().count() > BODY_MAX {
                return Err(bad("Descrição longa demais"));
            }
            (!s.is_empty()).then_some(s)
        }
    };

    let amount_val = match b.get("amountUsdc") {
        None => existing.amount_usdc,
        Some(v) => parse_amount(v)?,
    };

    let link_val = match b.get("linkUrl") {
        None => existing.link_url.clone(),
        Some(Value::Null) => None,
        Some(v) => {
            let s = str_field(v);
            if s.chars().count() > LINK_MAX {
                return Err(bad("Link longo demais"));
            }
            (!s.is_empty()).then_some(s)
        }
    };

    let period_val = match b.get("periodYm") {
        None => existing.period_ym.clone(),
        Some(Value::Null) => None,
        some => parse_period_ym(some),
    };

    let sort_order = match b.get("sortOrder") {
        None => existing.sort_order,
        some => parse_sort_order(some),
    };

    Ok(WritePlan {
        category,
        title,
        body: body_val,
        amount_usdc: amount_val,
        link_url: link_val,
        period_ym: period_val,
        sort_order,
    })
}

pub async fn run_transparency_create(
    pool: &Pool,
    body: &Value,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    let plan = plan_create(body)?;
    let conn = pool.get().await?;
    let row = conn
        .query_one(
            &format!(
                "INSERT INTO transparency_entries
                    (category, title, body, amount_usdc, link_url, period_ym, sort_order, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
                 RETURNING {RETURNING}"
            ),
            &[
                &plan.category,
                &plan.title,
                &plan.body,
                &plan.amount_usdc,
                &plan.link_url,
                &plan.period_ym,
                &plan.sort_order,
                &now_ms,
            ],
        )
        .await?;
    Ok(map_entry(&row))
}

pub async fn run_transparency_update(
    pool: &Pool,
    id: i32,
    body: &Value,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    if id < 1 {
        return Err(bad("ID inválido"));
    }
    let conn = pool.get().await?;
    let existing_row = conn
        .query_opt(
            "SELECT category, title, body,
                    amount_usdc::double precision AS amount_usdc,
                    link_url, period_ym, sort_order
               FROM transparency_entries WHERE id = $1",
            &[&id],
        )
        .await?
        .ok_or_else(|| PlayerReadError::not_found("Registro não encontrado"))?;
    let existing = Existing {
        category: existing_row.get::<_, String>("category"),
        title: existing_row.get::<_, String>("title"),
        body: existing_row.get::<_, Option<String>>("body"),
        amount_usdc: existing_row.get::<_, Option<f64>>("amount_usdc"),
        link_url: existing_row.get::<_, Option<String>>("link_url"),
        period_ym: existing_row.get::<_, Option<String>>("period_ym"),
        sort_order: existing_row.get::<_, i32>("sort_order"),
    };
    let plan = plan_update(body, &existing)?;
    let row = conn
        .query_one(
            &format!(
                "UPDATE transparency_entries
                    SET category = $2, title = $3, body = $4, amount_usdc = $5,
                        link_url = $6, period_ym = $7, sort_order = $8, updated_at = $9
                  WHERE id = $1
                  RETURNING {RETURNING}"
            ),
            &[
                &id,
                &plan.category,
                &plan.title,
                &plan.body,
                &plan.amount_usdc,
                &plan.link_url,
                &plan.period_ym,
                &plan.sort_order,
                &now_ms,
            ],
        )
        .await?;
    Ok(map_entry(&row))
}

pub async fn run_transparency_delete(pool: &Pool, id: i32) -> Result<Value, PlayerReadError> {
    if id < 1 {
        return Err(bad("ID inválido"));
    }
    let conn = pool.get().await?;
    let n = conn
        .execute("DELETE FROM transparency_entries WHERE id = $1", &[&id])
        .await?;
    if n == 0 {
        return Err(PlayerReadError::not_found("Registro não encontrado"));
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_requires_valid_category_and_title() {
        assert!(plan_create(&json!({ "category": "nope", "title": "x" })).is_err());
        assert!(plan_create(&json!({ "category": "pool", "title": "  " })).is_err());
        let p = plan_create(&json!({ "category": "pool", "title": " Fundo ", "amountUsdc": "12.5" }))
            .unwrap();
        assert_eq!(p.title, "Fundo");
        assert_eq!(p.amount_usdc, Some(12.5));
        assert_eq!(p.body, None);
    }

    #[test]
    fn update_is_partial() {
        let existing = Existing {
            category: "pool".into(),
            title: "Old".into(),
            body: Some("b".into()),
            amount_usdc: Some(1.0),
            link_url: None,
            period_ym: None,
            sort_order: 3,
        };
        let p = plan_update(&json!({ "title": "New" }), &existing).unwrap();
        assert_eq!(p.title, "New");
        assert_eq!(p.category, "pool");
        assert_eq!(p.body.as_deref(), Some("b"));
        assert_eq!(p.sort_order, 3);
        let cleared = plan_update(&json!({ "body": null, "amountUsdc": "" }), &existing).unwrap();
        assert_eq!(cleared.body, None);
        assert_eq!(cleared.amount_usdc, None);
    }

    #[test]
    fn sort_order_coercion() {
        assert_eq!(parse_sort_order(Some(&json!(4.9))), 4);
        assert_eq!(parse_sort_order(Some(&json!("7"))), 7);
        assert_eq!(parse_sort_order(Some(&json!("x"))), 0);
        assert_eq!(parse_sort_order(None), 0);
    }
}

// ---------------------------------------------------------------------------
// Health index knobs (`transparency_health_settings`, single row id = 1)
// ---------------------------------------------------------------------------

pub const TRANSPARENCY_ADMIN_HEALTH_GET_PATH: &str = "/v1/transparency/admin/health-settings/get";
pub const TRANSPARENCY_ADMIN_HEALTH_UPDATE_PATH: &str =
    "/v1/transparency/admin/health-settings/update";

/// Weights must add up to a whole; float noise from the UI is tolerated.
const WEIGHT_SUM_EPSILON: f64 = 1e-3;
/// Sanity bound for `season_start_ms` — 2020-01-01 .. 2100-01-01.
const SEASON_MIN_MS: i64 = 1_577_836_800_000;
const SEASON_MAX_MS: i64 = 4_102_444_800_000;

fn settings_to_json(s: &HealthSettings, updated_at: i64, updated_by: Option<&str>) -> Value {
    json!({
        "weightInflow": s.weight_inflow,
        "weightRent": s.weight_rent,
        "weightLedger": s.weight_ledger,
        "floor": s.floor,
        "seasonStartMs": s.season_start_ms,
        "periodScope": s.period_scope.as_str(),
        "countUndated": s.count_undated,
        "overrideEnabled": s.override_enabled,
        "overrideValue": s.override_value,
        "updatedAt": updated_at,
        "updatedBy": updated_by,
    })
}

fn req_f64(m: &serde_json::Map<String, Value>, key: &str, label: &str) -> Result<f64, PlayerReadError> {
    let v = match m.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    };
    let n = v.ok_or_else(|| bad(&format!("{label} em falta ou inválido")))?;
    if !n.is_finite() {
        return Err(bad(&format!("{label} tem de ser um número finito")));
    }
    Ok(n)
}

fn req_i32(m: &serde_json::Map<String, Value>, key: &str, label: &str) -> Result<i32, PlayerReadError> {
    let n = req_f64(m, key, label)?;
    if n.fract() != 0.0 {
        return Err(bad(&format!("{label} tem de ser inteiro")));
    }
    Ok(n as i32)
}

fn req_bool(m: &serde_json::Map<String, Value>, key: &str, label: &str) -> Result<bool, PlayerReadError> {
    match m.get(key) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) => match s.trim() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(bad(&format!("{label} inválido"))),
        },
        _ => Err(bad(&format!("{label} em falta"))),
    }
}

/// Whitelist parse — nothing outside these keys reaches the table, so a stray field in
/// the request body can never become a column write.
fn plan_health_settings(body: &Value) -> Result<HealthSettings, PlayerReadError> {
    let m = obj(body);

    let weight_inflow = req_f64(&m, "weightInflow", "Peso 'quanto entra'")?;
    let weight_rent = req_f64(&m, "weightRent", "Peso 'rentabilização'")?;
    let weight_ledger = req_f64(&m, "weightLedger", "Peso 'portal'")?;
    for (w, label) in [
        (weight_inflow, "Peso 'quanto entra'"),
        (weight_rent, "Peso 'rentabilização'"),
        (weight_ledger, "Peso 'portal'"),
    ] {
        if !(0.0..=1.0).contains(&w) {
            return Err(bad(&format!("{label} tem de estar entre 0 e 1")));
        }
    }
    let sum = weight_inflow + weight_rent + weight_ledger;
    if (sum - 1.0).abs() > WEIGHT_SUM_EPSILON {
        return Err(bad(&format!(
            "Os três pesos têm de somar 1 (somam {sum:.3})"
        )));
    }

    let floor = req_i32(&m, "floor", "Piso")?;
    if !(0..=100).contains(&floor) {
        return Err(bad("Piso tem de estar entre 0 e 100"));
    }

    let season_start_ms = req_f64(&m, "seasonStartMs", "Início da temporada")? as i64;
    if !(SEASON_MIN_MS..=SEASON_MAX_MS).contains(&season_start_ms) {
        return Err(bad("Início da temporada fora de um intervalo plausível"));
    }

    let period_scope = match m.get("periodScope").and_then(|v| v.as_str()) {
        Some(s) => HealthPeriodScope::parse(s)
            .ok_or_else(|| bad("Âmbito de período inválido (season | all_time | current_month)"))?,
        None => return Err(bad("Âmbito de período em falta")),
    };

    let count_undated = req_bool(&m, "countUndated", "Contar lançamentos sem período")?;
    let override_enabled = req_bool(&m, "overrideEnabled", "Fixar saúde à mão")?;

    let override_value = match m.get("overrideValue") {
        Some(Value::Null) | None => None,
        _ => Some(req_i32(&m, "overrideValue", "Valor fixado")?),
    };
    if let Some(v) = override_value {
        if !(0..=100).contains(&v) {
            return Err(bad("Valor fixado tem de estar entre 0 e 100"));
        }
    }
    if override_enabled && override_value.is_none() {
        return Err(bad("Para fixar a saúde é preciso indicar o valor"));
    }

    Ok(HealthSettings {
        weight_inflow,
        weight_rent,
        weight_ledger,
        floor,
        season_start_ms,
        period_scope,
        count_undated,
        override_enabled,
        override_value,
    })
}

/// Actor injected by `genesis-api` after `require_admin`; any client-supplied value is
/// ignored there, so this can be trusted as the operator's id.
fn actor_of(body: &Value) -> Option<String> {
    match obj(body).get("actorUserId") {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

pub async fn run_transparency_health_settings_get(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let settings = load_health_settings(&conn).await;
    let meta = conn
        .query_opt(
            "SELECT updated_at, updated_by FROM transparency_health_settings WHERE id = 1",
            &[],
        )
        .await
        .ok()
        .flatten();
    let (updated_at, updated_by) = match meta {
        Some(r) => (
            r.try_get::<_, i64>("updated_at").unwrap_or(0),
            r.try_get::<_, Option<String>>("updated_by").unwrap_or(None),
        ),
        None => (0, None),
    };
    Ok(settings_to_json(&settings, updated_at, updated_by.as_deref()))
}

pub async fn run_transparency_health_settings_update(
    pool: &Pool,
    body: &Value,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    let next = plan_health_settings(body)?;
    let actor = actor_of(body);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;

    let before = load_health_settings(&tx).await;
    let before_json = settings_to_json(&before, 0, None);

    tx.execute(
        "INSERT INTO transparency_health_settings
            (id, weight_inflow, weight_rent, weight_ledger, floor_score, season_start_ms,
             period_scope, count_undated, override_enabled, override_value, updated_at, updated_by)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
            weight_inflow = EXCLUDED.weight_inflow,
            weight_rent = EXCLUDED.weight_rent,
            weight_ledger = EXCLUDED.weight_ledger,
            floor_score = EXCLUDED.floor_score,
            season_start_ms = EXCLUDED.season_start_ms,
            period_scope = EXCLUDED.period_scope,
            count_undated = EXCLUDED.count_undated,
            override_enabled = EXCLUDED.override_enabled,
            override_value = EXCLUDED.override_value,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by",
        &[
            &next.weight_inflow,
            &next.weight_rent,
            &next.weight_ledger,
            &next.floor,
            &next.season_start_ms,
            &next.period_scope.as_str(),
            &next.count_undated,
            &next.override_enabled,
            &next.override_value,
            &now_ms,
            &actor,
        ],
    )
    .await?;

    let after_json = settings_to_json(&next, now_ms, actor.as_deref());
    tx.execute(
        "INSERT INTO transparency_health_settings_audit
            (changed_at, changed_by, before_json, after_json)
         VALUES ($1, $2, $3, $4)",
        &[&now_ms, &actor, &before_json, &after_json],
    )
    .await?;

    tx.commit().await?;
    Ok(after_json)
}
