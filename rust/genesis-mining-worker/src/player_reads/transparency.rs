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
    let cash = load_player_cash_flows(&conn, now).await.unwrap_or_default();
    let snap = compute_transparency_health(&health_entries, now, &cash);
    let mut body =
        serde_json::to_value(&snap).map_err(|e| PlayerReadError::internal(e.to_string()))?;
    if let Value::Object(ref mut m) = body {
        m.insert("floor".into(), json!(TRANSPARENCY_HEALTH_FLOOR));
        m.insert("computedAt".into(), json!(now));
    }
    Ok(body)
}

/// Season window start for the health cash-flows — `2026-09-01T00:00:00Z`
/// (matches the client copy: "depósitos on-chain … desde 01/09/2026 00:00 UTC").
/// `SELECT (extract(epoch FROM timestamptz '2026-09-01 00:00:00+00')*1000)::bigint`.
const HEALTH_SEASON_START_MS: i64 = 1_788_220_800_000;
/// BRT is UTC-3 — same offset `genesis_core::transparency::health` uses for "day".
const BRT_OFFSET_MS: i64 = 3 * genesis_core::time::MS_PER_HOUR as i64;

/// On-chain USDC in/out since the season start, plus today's (BRT) slice.
/// deposits = `user_deposit_history`; withdrawals = paid (`completed`) `withdrawal_requests`.
async fn load_player_cash_flows<C: GenericClient>(
    conn: &C,
    now_ms: i64,
) -> Result<PlayerCashFlows, PlayerReadError> {
    let local = now_ms - BRT_OFFSET_MS;
    let brt_today_start =
        local.div_euclid(genesis_core::time::MS_PER_DAY as i64) * genesis_core::time::MS_PER_DAY as i64
            + BRT_OFFSET_MS;

    let dep = conn
        .query_one(
            "SELECT COALESCE(SUM(amount_usdc), 0)::float8 AS total,
                    COALESCE(SUM(amount_usdc) FILTER (WHERE created_at >= $2), 0)::float8 AS day_total
               FROM user_deposit_history
              WHERE created_at >= $1",
            &[&HEALTH_SEASON_START_MS, &brt_today_start],
        )
        .await?;
    let wd = conn
        .query_one(
            "SELECT COALESCE(SUM(amount_usdc), 0)::float8 AS total,
                    COALESCE(SUM(amount_usdc) FILTER (WHERE created_at >= $2), 0)::float8 AS day_total
               FROM withdrawal_requests
              WHERE status = 'completed' AND created_at >= $1",
            &[&HEALTH_SEASON_START_MS, &brt_today_start],
        )
        .await?;

    Ok(PlayerCashFlows {
        deposits_usdc: Some(dep.get::<_, f64>("total")),
        withdrawals_usdc: Some(wd.get::<_, f64>("total")),
        day_deposits_usdc: Some(dep.get::<_, f64>("day_total")),
        day_withdrawals_usdc: Some(wd.get::<_, f64>("day_total")),
    })
}

async fn load_entries<C: GenericClient>(conn: &C) -> Result<Vec<Value>, PlayerReadError> {
    let rows = conn
        .query(
            "SELECT id, category, title, body,
                    amount_usdc::double precision AS amount_usdc,
                    link_url, period_ym, sort_order, created_at, updated_at
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
    // `period_ym` is optional and only present after the column migration; tolerate
    // its absence so the reader keeps working on an un-migrated DB.
    if let Ok(Some(ym)) = r.try_get::<_, Option<String>>("period_ym") {
        let ym = ym.trim();
        if !ym.is_empty() {
            obj.insert("periodYm".into(), json!(ym));
        }
    }
    obj.insert("sortOrder".into(), json!(i32_cell(r, "sort_order")));
    obj.insert("createdAt".into(), json!(i64_cell(r, "created_at")));
    obj.insert("updatedAt".into(), json!(i64_cell(r, "updated_at")));
    Value::Object(obj)
}
