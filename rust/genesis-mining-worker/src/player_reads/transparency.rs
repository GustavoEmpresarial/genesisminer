//! Public transparency — Node `GET /api/transparency` + `/api/transparency/health`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::{
    compute_transparency_health_with, HealthPeriodScope, HealthSettings, PlayerCashFlows,
    TransparencyHealthEntry,
};
use serde_json::{json, Value};
use tracing::warn;

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
            period_ym: e
                .get("periodYm")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    let now = now_ms();
    let settings = load_health_settings(&conn).await;
    let cash = load_player_cash_flows(&conn, now, settings.season_start_ms)
        .await
        .unwrap_or_default();
    let snap = compute_transparency_health_with(&health_entries, now, &cash, &settings);
    let mut body =
        serde_json::to_value(&snap).map_err(|e| PlayerReadError::internal(e.to_string()))?;
    if let Value::Object(ref mut m) = body {
        m.insert("floor".into(), json!(settings.effective_floor()));
        m.insert("computedAt".into(), json!(now));
    }
    // Deliberately NOT exposed here: override_enabled / override_value / weights.
    // This endpoint is public; the admin panel reads them from the admin settings route.
    Ok(body)
}

/// Single-row knobs (`id = 1`). Any failure — missing table on an un-migrated DB, bad
/// row — degrades to the historical defaults and logs, rather than 500-ing a public page.
pub(crate) async fn load_health_settings<C: GenericClient>(conn: &C) -> HealthSettings {
    let row = conn
        .query_opt(
            "SELECT weight_inflow::float8   AS weight_inflow,
                    weight_rent::float8     AS weight_rent,
                    weight_ledger::float8   AS weight_ledger,
                    floor_score,
                    season_start_ms,
                    period_scope,
                    count_undated,
                    override_enabled,
                    override_value
               FROM transparency_health_settings
              WHERE id = 1",
            &[],
        )
        .await;

    let row = match row {
        Ok(Some(r)) => r,
        Ok(None) => return HealthSettings::default(),
        Err(e) => {
            warn!(
                event = "transparency_health_settings_read_failed",
                err = %e,
                "falling back to default health settings"
            );
            return HealthSettings::default();
        }
    };

    let d = HealthSettings::default();
    HealthSettings {
        weight_inflow: row.try_get::<_, f64>("weight_inflow").unwrap_or(d.weight_inflow),
        weight_rent: row.try_get::<_, f64>("weight_rent").unwrap_or(d.weight_rent),
        weight_ledger: row.try_get::<_, f64>("weight_ledger").unwrap_or(d.weight_ledger),
        floor: row.try_get::<_, i32>("floor_score").unwrap_or(d.floor),
        season_start_ms: row
            .try_get::<_, i64>("season_start_ms")
            .unwrap_or(d.season_start_ms),
        period_scope: row
            .try_get::<_, String>("period_scope")
            .ok()
            .and_then(|s| HealthPeriodScope::parse(&s))
            .unwrap_or(d.period_scope),
        count_undated: row.try_get::<_, bool>("count_undated").unwrap_or(d.count_undated),
        override_enabled: row
            .try_get::<_, bool>("override_enabled")
            .unwrap_or(d.override_enabled),
        override_value: row.try_get::<_, Option<i32>>("override_value").unwrap_or(None),
    }
}

/// BRT is UTC-3 — same offset `genesis_core::transparency::health` uses for "day".
const BRT_OFFSET_MS: i64 = 3 * genesis_core::time::MS_PER_HOUR as i64;

/// On-chain USDC in/out since `season_start_ms`, plus today's (BRT) slice.
/// deposits = `user_deposit_history`; withdrawals = paid (`completed`) `withdrawal_requests`.
/// The window comes from `transparency_health_settings` so it stays in step with the
/// period scope applied to published entries — mixing the two is what broke the index.
async fn load_player_cash_flows<C: GenericClient>(
    conn: &C,
    now_ms: i64,
    season_start_ms: i64,
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
            &[&season_start_ms, &brt_today_start],
        )
        .await?;
    let wd = conn
        .query_one(
            "SELECT COALESCE(SUM(amount_usdc), 0)::float8 AS total,
                    COALESCE(SUM(amount_usdc) FILTER (WHERE created_at >= $2), 0)::float8 AS day_total
               FROM withdrawal_requests
              WHERE status = 'completed' AND created_at >= $1",
            &[&season_start_ms, &brt_today_start],
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
