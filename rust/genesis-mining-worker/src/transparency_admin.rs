//! Admin CRUD for `transparency_entries` — Node `server/modules/admin/transparency`.
//!
//! Single-table create / update / delete. Validation mirrors Node
//! `planCreateTransparencyEntry` / `planUpdateTransparencyEntry`; the returned
//! DTO shape is `player_reads::transparency::map_entry` (same as the public GET).

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use crate::player_reads::transparency::map_entry;
use crate::player_reads::PlayerReadError;

pub const TRANSPARENCY_ADMIN_CREATE_PATH: &str = "/v1/transparency/admin/create";
pub const TRANSPARENCY_ADMIN_UPDATE_PATH: &str = "/v1/transparency/admin/update";
pub const TRANSPARENCY_ADMIN_DELETE_PATH: &str = "/v1/transparency/admin/delete";

/// Node `TRANSPARENCY_TITLE_MAX` / `_BODY_MAX` / `_LINK_MAX`.
const TITLE_MAX: usize = 300;
const BODY_MAX: usize = 8000;
const LINK_MAX: usize = 2048;
/// Node `TRANSPARENCY_CATEGORIES`.
const CATEGORIES: [&str; 4] = ["pool", "expense", "investment", "other"];

const RETURNING: &str = "id, category, title, body,
        amount_usdc::double precision AS amount_usdc,
        link_url, sort_order, created_at, updated_at";

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
        sort_order: parse_sort_order(b.get("sortOrder")),
    })
}

struct Existing {
    category: String,
    title: String,
    body: Option<String>,
    amount_usdc: Option<f64>,
    link_url: Option<String>,
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
                    (category, title, body, amount_usdc, link_url, sort_order, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
                 RETURNING {RETURNING}"
            ),
            &[
                &plan.category,
                &plan.title,
                &plan.body,
                &plan.amount_usdc,
                &plan.link_url,
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
                    link_url, sort_order
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
        sort_order: existing_row.get::<_, i32>("sort_order"),
    };
    let plan = plan_update(body, &existing)?;
    let row = conn
        .query_one(
            &format!(
                "UPDATE transparency_entries
                    SET category = $2, title = $3, body = $4, amount_usdc = $5,
                        link_url = $6, sort_order = $7, updated_at = $8
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
