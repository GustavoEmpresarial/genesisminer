//! Public transparency — Node `GET /api/transparency` + `/api/transparency/health`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::{
    compute_transparency_health, PlayerCashFlows, TransparencyHealthEntry,
    TRANSPARENCY_HEALTH_FLOOR,
};
use serde_json::{json, Value};

use super::{f64_cell, i32_cell, i64_cell, now_ms, opt_string, string_cell, PlayerReadError};

pub async fn run_transparency_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let items = load_entries(&conn).await?;
    Ok(json!({ "items": items }))
}

pub async fn run_transparency_health(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let items = load_entries(&conn).await?;
    let mut health_entries = Vec::new();
    for e in &items {
        health_entries.push(TransparencyHealthEntry {
            category: e
                .get("category")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            amount_usdc: e.get("amountUsdc").and_then(|v| v.as_f64()),
            created_at: e.get("createdAt").and_then(|v| v.as_f64()).or_else(|| {
                e.get("createdAt")
                    .and_then(|v| v.as_i64())
                    .map(|n| n as f64)
            }),
        });
    }
    let now = now_ms();
    let snap = compute_transparency_health(&health_entries, now, &PlayerCashFlows::default());
    let mut body =
        serde_json::to_value(&snap).map_err(|e| PlayerReadError::internal(e.to_string()))?;
    if let Value::Object(ref mut m) = body {
        m.insert("floor".into(), json!(TRANSPARENCY_HEALTH_FLOOR));
        m.insert("computedAt".into(), json!(now));
    }
    Ok(body)
}

async fn load_entries<C: GenericClient>(conn: &C) -> Result<Vec<Value>, PlayerReadError> {
    let rows = conn
        .query(
            "SELECT id, category, title, body,
                    amount_usdc::double precision AS amount_usdc,
                    link_url, sort_order, created_at, updated_at
               FROM transparency_entries
              ORDER BY sort_order ASC, id ASC",
            &[],
        )
        .await?;
    Ok(rows.iter().map(map_entry).collect())
}

pub(crate) fn map_entry(r: &tokio_postgres::Row) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("id".into(), json!(i32_cell(r, "id")));
    obj.insert("category".into(), json!(string_cell(r, "category")));
    obj.insert("title".into(), json!(string_cell(r, "title")));
    if let Some(body) = opt_string(r, "body") {
        obj.insert("body".into(), json!(body));
    }
    if let Ok(Some(amt)) = r.try_get::<_, Option<f64>>("amount_usdc") {
        if amt.is_finite() {
            obj.insert("amountUsdc".into(), json!(amt));
        }
    } else {
        let amt = f64_cell(r, "amount_usdc");
        if amt != 0.0 {
            obj.insert("amountUsdc".into(), json!(amt));
        }
    }
    if let Some(link) = opt_string(r, "link_url") {
        obj.insert("linkUrl".into(), json!(link));
    }
    obj.insert("sortOrder".into(), json!(i32_cell(r, "sort_order")));
    obj.insert("createdAt".into(), json!(i64_cell(r, "created_at")));
    obj.insert("updatedAt".into(), json!(i64_cell(r, "updated_at")));
    Value::Object(obj)
}
