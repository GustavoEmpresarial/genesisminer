//! Admin "Distribuição Mining" reports — ports
//! `server/modules/admin/mining-distribution/` (Express): overview KPIs, per-coin
//! breakdown, timeline, paginated credits ledger + CSV export, per-user summary,
//! and the `mining_distribution_daily` rollup rebuild.
//!
//! All reads hit `mining_block_history` (DDL-created, not in prisma) directly and
//! degrade to empty/zero if the table is absent (`42P01`), like the Node service.

use chrono::{Datelike, TimeZone, Utc};
use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::error::SqlState;
use tokio_postgres::types::ToSql;
use tokio_postgres::Row;

use crate::player_reads::PlayerReadError;

pub const MINING_DIST_OVERVIEW_PATH: &str = "/v1/admin/mining-dist/overview";
pub const MINING_DIST_BY_COIN_PATH: &str = "/v1/admin/mining-dist/by-coin";
pub const MINING_DIST_TIMELINE_PATH: &str = "/v1/admin/mining-dist/timeline";
pub const MINING_DIST_CREDITS_PATH: &str = "/v1/admin/mining-dist/credits";
pub const MINING_DIST_CREDITS_CSV_PATH: &str = "/v1/admin/mining-dist/credits-csv";
pub const MINING_DIST_USER_SUMMARY_PATH: &str = "/v1/admin/mining-dist/user-summary";
pub const MINING_DIST_REBUILD_ROLLUPS_PATH: &str = "/v1/admin/mining-dist/rebuild-rollups";

const MS_PER_DAY: i64 = 86_400_000;
const SECONDS_PER_DAY: f64 = 86_400.0;
const PERCENT: f64 = 100.0;
const MAX_LEDGER_RANGE_DAYS: i64 = 93;
const MAX_LEDGER_RANGE_MS: i64 = MAX_LEDGER_RANGE_DAYS * MS_PER_DAY;
const MAX_EXPORT_ROWS: i64 = 50_000;
const LEDGER_LIMIT_MAX: i64 = 100;
const LEDGER_PAGE_MAX: i64 = 99_999;
const DEFAULT_ROLLUP_DAYS_BACK: i64 = 45;

fn is_undefined_table(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&SqlState::UNDEFINED_TABLE)
}

fn utc_day_start_ms(ts: i64) -> i64 {
    let dt = Utc.timestamp_millis_opt(ts).single().unwrap_or_else(Utc::now);
    Utc.with_ymd_and_hms(dt.year(), dt.month(), dt.day(), 0, 0, 0)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(ts)
}
fn ymd_from_ms(ts: i64) -> String {
    Utc.timestamp_millis_opt(ts)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}
fn days_between_utc(from_ms: i64, to_ms: i64) -> i64 {
    let a = utc_day_start_ms(from_ms);
    let b = utc_day_start_ms(to_ms);
    (((b - a) as f64 / MS_PER_DAY as f64).round() as i64 + 1).max(1)
}

fn f64_col(r: &Row, c: &str) -> f64 {
    r.try_get::<_, Option<f64>>(c).ok().flatten().unwrap_or(0.0)
}
fn i64_col(r: &Row, c: &str) -> i64 {
    if let Ok(v) = r.try_get::<_, i64>(c) {
        return v;
    }
    if let Ok(v) = r.try_get::<_, i32>(c) {
        return i64::from(v);
    }
    r.try_get::<_, Option<i64>>(c).ok().flatten().unwrap_or(0)
}
fn str_col(r: &Row, c: &str) -> String {
    r.try_get::<_, Option<String>>(c).ok().flatten().unwrap_or_default()
}
fn opt_str_col(r: &Row, c: &str) -> Value {
    match r.try_get::<_, Option<String>>(c).ok().flatten() {
        Some(s) => json!(s),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRequest {
    #[serde(default)]
    pub custom_from: Option<i64>,
    #[serde(default)]
    pub custom_to: Option<i64>,
}

async fn aggregate(pool: &Pool, from_ms: i64, to_ms: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let row = conn
        .query_one(
            "SELECT COALESCE(SUM(h.amount_coins),0)::float8 AS total_coins,
                    COALESCE(SUM(h.amount_usd),0)::float8 AS total_usd,
                    COUNT(*)::bigint AS credit_rows,
                    COUNT(DISTINCT h.user_id)::bigint AS unique_users
               FROM mining_block_history h
              WHERE h.window_end_ms >= $1 AND h.window_end_ms <= $2",
            &[&from_ms, &to_ms],
        )
        .await;
    match row {
        Ok(r) => Ok(json!({
            "totalCoins": f64_col(&r, "total_coins"),
            "totalUsd": f64_col(&r, "total_usd"),
            "creditRows": i64_col(&r, "credit_rows"),
            "uniqueUsers": i64_col(&r, "unique_users"),
        })),
        Err(e) if is_undefined_table(&e) => Ok(empty_totals()),
        Err(e) => Err(e.into()),
    }
}

fn empty_totals() -> Value {
    json!({ "totalCoins": 0.0, "totalUsd": 0.0, "creditRows": 0, "uniqueUsers": 0 })
}

fn period(label: &str, from_ms: i64, to_ms: i64, totals: Value) -> Value {
    let mut o = totals;
    if let Value::Object(ref mut m) = o {
        m.insert("label".into(), json!(label));
        m.insert("fromMs".into(), json!(from_ms));
        m.insert("toMs".into(), json!(to_ms));
    }
    o
}

pub async fn run_overview(pool: &Pool, req: OverviewRequest) -> Result<Value, PlayerReadError> {
    let now = Utc::now().timestamp_millis();
    let today_start = utc_day_start_ms(now);
    let last7_start = today_start - 6 * MS_PER_DAY;
    let last30_start = today_start - 29 * MS_PER_DAY;

    let today = aggregate(pool, today_start, now).await?;
    let last7 = aggregate(pool, last7_start, now).await?;
    let last30 = aggregate(pool, last30_start, now).await?;

    let custom = match (req.custom_from, req.custom_to) {
        (Some(f), Some(t)) if t >= f => {
            Some(period("custom", f, t, aggregate(pool, f, t).await?))
        }
        _ => None,
    };

    Ok(json!({
        "generatedAtMs": now,
        "timezone": "UTC",
        "periods": {
            "today": period("today", today_start, now, today),
            "last7Days": period("last7Days", last7_start, now, last7),
            "last30Days": period("last30Days", last30_start, now, last30),
            "custom": custom,
        }
    }))
}

// ---------------------------------------------------------------------------
// by-coin
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeRequest {
    pub from_ms: i64,
    pub to_ms: i64,
}

pub async fn run_by_coin(pool: &Pool, req: RangeRequest) -> Result<Value, PlayerReadError> {
    let (from_ms, to_ms) = (req.from_ms, req.to_ms);
    let conn = pool.get().await?;
    let rows = match conn
        .query(
            "SELECT h.coin_id,
                    COALESCE(c.symbol, h.coin_id) AS symbol,
                    COALESCE(c.name, h.coin_id) AS name,
                    c.block_reward, c.block_time,
                    COALESCE(SUM(h.amount_coins),0)::float8 AS total_coins,
                    COALESCE(SUM(h.amount_usd),0)::float8 AS total_usd,
                    COUNT(*)::bigint AS credit_rows,
                    COUNT(DISTINCT h.user_id)::bigint AS unique_users
               FROM mining_block_history h
               LEFT JOIN mining_coins c ON c.id = h.coin_id
              WHERE h.window_end_ms >= $1 AND h.window_end_ms <= $2
              GROUP BY h.coin_id, c.symbol, c.name, c.block_reward, c.block_time
              ORDER BY total_usd DESC, total_coins DESC",
            &[&from_ms, &to_ms],
        )
        .await
    {
        Ok(r) => r,
        Err(e) if is_undefined_table(&e) => {
            return Ok(json!({ "fromMs": from_ms, "toMs": to_ms, "rows": [], "totals": empty_totals() }));
        }
        Err(e) => return Err(e.into()),
    };

    let day_count = days_between_utc(from_ms, to_ms) as f64;
    let mut total_usd_all = 0.0f64;
    let mut mapped: Vec<Value> = Vec::with_capacity(rows.len());
    let (mut t_coins, mut t_usd, mut t_rows) = (0.0f64, 0.0f64, 0i64);
    for r in &rows {
        let total_usd = f64_col(r, "total_usd");
        let total_coins = f64_col(r, "total_coins");
        let credit_rows = i64_col(r, "credit_rows");
        total_usd_all += total_usd;
        t_coins += total_coins;
        t_usd += total_usd;
        t_rows += credit_rows;
        let block_reward = f64_col(r, "block_reward");
        let block_time = f64_col(r, "block_time");
        let (theo, util) = if block_reward > 0.0 && block_time > 0.0 {
            let theo = block_reward * (SECONDS_PER_DAY / block_time) * day_count;
            let util = if theo > 0.0 {
                Some(total_coins / theo * PERCENT)
            } else {
                None
            };
            (Some(theo), util)
        } else {
            (None, None)
        };
        mapped.push(json!({
            "coinId": str_col(r, "coin_id"),
            "symbol": str_col(r, "symbol"),
            "name": str_col(r, "name"),
            "totalCoins": total_coins,
            "totalUsd": total_usd,
            "creditRows": credit_rows,
            "uniqueUsers": i64_col(r, "unique_users"),
            "pctOfTotalUsd": 0.0,
            "theoreticalEmissionCoins": theo,
            "emissionUtilizationPct": util,
        }));
    }
    for m in &mut mapped {
        let usd = m["totalUsd"].as_f64().unwrap_or(0.0);
        m["pctOfTotalUsd"] = json!(if total_usd_all > 0.0 {
            usd / total_usd_all * PERCENT
        } else {
            0.0
        });
    }

    Ok(json!({
        "fromMs": from_ms,
        "toMs": to_ms,
        "rows": mapped,
        "totals": { "totalCoins": t_coins, "totalUsd": t_usd, "creditRows": t_rows, "uniqueUsers": 0 },
    }))
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRequest {
    pub from_ms: i64,
    pub to_ms: i64,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    pub coin_id: Option<String>,
}

pub async fn run_timeline(pool: &Pool, req: TimelineRequest) -> Result<Value, PlayerReadError> {
    let bucket = if req.bucket.as_deref() == Some("week") {
        "week"
    } else {
        "day"
    };
    let coin = req.coin_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let conn = pool.get().await?;
    let sql = format!(
        "SELECT (EXTRACT(EPOCH FROM date_trunc('{bucket}', to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')) * 1000)::bigint AS bucket_start_ms,
                COALESCE(SUM(h.amount_coins),0)::float8 AS total_coins,
                COALESCE(SUM(h.amount_usd),0)::float8 AS total_usd,
                COUNT(*)::bigint AS credit_rows,
                COUNT(DISTINCT h.user_id)::bigint AS unique_users
           FROM mining_block_history h
          WHERE h.window_end_ms >= $1 AND h.window_end_ms <= $2 {coin_clause}
          GROUP BY bucket_start ORDER BY bucket_start ASC",
        coin_clause = if coin.is_some() { "AND h.coin_id = $3" } else { "" }
    );
    let params: Vec<&(dyn ToSql + Sync)> = if let Some(c) = coin.as_ref() {
        vec![&req.from_ms, &req.to_ms, c]
    } else {
        vec![&req.from_ms, &req.to_ms]
    };
    let rows = match conn.query(&sql, &params).await {
        Ok(r) => r,
        Err(e) if is_undefined_table(&e) => {
            return Ok(json!({ "bucket": bucket, "rows": [] }));
        }
        Err(e) => return Err(e.into()),
    };
    let mapped: Vec<Value> = rows
        .iter()
        .map(|r| {
            let ms = i64_col(r, "bucket_start_ms");
            json!({
                "bucketStartMs": ms,
                "bucketLabel": ymd_from_ms(ms),
                "totalCoins": f64_col(r, "total_coins"),
                "totalUsd": f64_col(r, "total_usd"),
                "creditRows": i64_col(r, "credit_rows"),
                "uniqueUsers": i64_col(r, "unique_users"),
            })
        })
        .collect();
    Ok(json!({ "bucket": bucket, "rows": mapped }))
}

// ---------------------------------------------------------------------------
// credits ledger + CSV
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditsRequest {
    pub from_ms: i64,
    pub to_ms: i64,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub coin_id: Option<String>,
    #[serde(default)]
    pub room_id: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

fn validate_range(from_ms: i64, to_ms: i64, for_export: bool) -> Option<String> {
    if to_ms < from_ms {
        return Some("Intervalo de datas inválido (from/to).".into());
    }
    if to_ms - from_ms > MAX_LEDGER_RANGE_MS {
        return Some(if for_export {
            format!("Intervalo máximo de {MAX_LEDGER_RANGE_DAYS} dias para exportação.")
        } else {
            format!("Intervalo máximo de {MAX_LEDGER_RANGE_DAYS} dias no ledger.")
        });
    }
    None
}

/// Builds the shared WHERE and its bind params. `$1..$2` are from/to; extra
/// binds are appended and their placeholder indices returned inline.
struct CreditsWhere {
    sql: String,
    // owned bind values (kept alive by the caller)
    user_id: Option<i32>,
    coin_id: Option<String>,
    room_id: Option<String>,
    like: Option<String>,
    q_lower: Option<String>,
}

fn build_credits_where(req: &CreditsRequest) -> CreditsWhere {
    let mut sql = String::from("h.window_end_ms >= $1 AND h.window_end_ms <= $2");
    let mut n = 2;
    let user_id = req.user_id.and_then(|v| i32::try_from(v).ok());
    let coin_id = req.coin_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let room_id = req.room_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let q_norm = req
        .q
        .as_deref()
        .map(|s| s.replace('%', "").trim().to_lowercase())
        .filter(|s| !s.is_empty());

    if user_id.is_some() {
        n += 1;
        sql.push_str(&format!(" AND h.user_id = ${n}"));
    }
    if coin_id.is_some() {
        n += 1;
        sql.push_str(&format!(" AND h.coin_id = ${n}"));
    }
    if room_id.is_some() {
        n += 1;
        sql.push_str(&format!(" AND h.room_id = ${n}"));
    }
    let (like, q_lower) = if let Some(q) = q_norm {
        let like = format!("%{q}%");
        let a = n + 1;
        let b = n + 2;
        sql.push_str(&format!(
            " AND (LOWER(COALESCE(u.username,'')) LIKE ${a} OR LOWER(COALESCE(u.email,'')) LIKE ${a} OR u.id::text = ${b})"
        ));
        (Some(like), Some(q))
    } else {
        (None, None)
    };
    CreditsWhere { sql, user_id, coin_id, room_id, like, q_lower }
}

fn credits_params<'a>(
    from_ms: &'a i64,
    to_ms: &'a i64,
    w: &'a CreditsWhere,
) -> Vec<&'a (dyn ToSql + Sync)> {
    let mut p: Vec<&(dyn ToSql + Sync)> = vec![from_ms, to_ms];
    if let Some(ref v) = w.user_id {
        p.push(v);
    }
    if let Some(ref v) = w.coin_id {
        p.push(v);
    }
    if let Some(ref v) = w.room_id {
        p.push(v);
    }
    if let Some(ref v) = w.like {
        p.push(v);
    }
    if let Some(ref v) = w.q_lower {
        p.push(v);
    }
    p
}

const LEDGER_SELECT: &str = "h.id, h.user_id, u.username, u.email, h.coin_id, c.symbol AS coin_symbol,
     h.room_id, h.window_start_ms, h.window_end_ms, h.credit_blocks, h.amount_coins, h.amount_usd,
     h.user_hash_hps, h.network_hashrate, h.block_reward, h.block_time, h.created_at";

fn map_ledger_row(r: &Row) -> Value {
    json!({
        "id": i64_col(r, "id").to_string(),
        "userId": i64_col(r, "user_id"),
        "username": opt_str_col(r, "username"),
        "email": opt_str_col(r, "email"),
        "coinId": str_col(r, "coin_id"),
        "coinSymbol": opt_str_col(r, "coin_symbol"),
        "roomId": opt_str_col(r, "room_id"),
        "windowStartMs": i64_col(r, "window_start_ms"),
        "windowEndMs": i64_col(r, "window_end_ms"),
        "creditBlocks": i64_col(r, "credit_blocks"),
        "amountCoins": f64_col(r, "amount_coins"),
        "amountUsd": f64_col(r, "amount_usd"),
        "userHashHps": f64_col(r, "user_hash_hps"),
        "networkHashrate": f64_col(r, "network_hashrate"),
        "blockReward": f64_col(r, "block_reward"),
        "blockTime": f64_col(r, "block_time"),
        "createdAtMs": i64_col(r, "created_at"),
    })
}

pub async fn run_credits(pool: &Pool, req: CreditsRequest) -> Result<Value, PlayerReadError> {
    if let Some(msg) = validate_range(req.from_ms, req.to_ms, false) {
        return Err(PlayerReadError::bad(msg));
    }
    let limit = req.limit.unwrap_or(50).clamp(1, LEDGER_LIMIT_MAX);
    let page = req.page.unwrap_or(1).clamp(1, LEDGER_PAGE_MAX);
    let offset = (page - 1) * limit;

    let w = build_credits_where(&req);
    let conn = pool.get().await?;
    let params = credits_params(&req.from_ms, &req.to_ms, &w);

    let count_sql = format!(
        "SELECT COUNT(*)::bigint AS total FROM mining_block_history h LEFT JOIN users u ON u.id = h.user_id WHERE {}",
        w.sql
    );
    let total = match conn.query_one(&count_sql, &params).await {
        Ok(r) => i64_col(&r, "total"),
        Err(e) if is_undefined_table(&e) => {
            return Ok(json!({ "total": 0, "page": page, "limit": limit, "rows": [] }));
        }
        Err(e) => return Err(e.into()),
    };

    let rows_sql = format!(
        "SELECT {LEDGER_SELECT}
           FROM mining_block_history h
           LEFT JOIN users u ON u.id = h.user_id
           LEFT JOIN mining_coins c ON c.id = h.coin_id
          WHERE {}
          ORDER BY h.window_end_ms DESC, h.id DESC
          LIMIT {limit} OFFSET {offset}",
        w.sql
    );
    let rows = conn.query(&rows_sql, &params).await?;
    Ok(json!({
        "total": total,
        "page": page,
        "limit": limit,
        "rows": rows.iter().map(map_ledger_row).collect::<Vec<_>>(),
    }))
}

fn csv_cell(s: &str) -> String {
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
fn iso_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

pub async fn run_credits_csv(pool: &Pool, req: CreditsRequest) -> Result<Value, PlayerReadError> {
    if let Some(msg) = validate_range(req.from_ms, req.to_ms, true) {
        return Err(PlayerReadError::bad(msg));
    }
    let w = build_credits_where(&req);
    let conn = pool.get().await?;
    let params = credits_params(&req.from_ms, &req.to_ms, &w);
    let sql = format!(
        "SELECT h.id, h.user_id, u.username, u.email, h.coin_id, c.symbol AS coin_symbol, h.room_id,
                h.window_start_ms, h.window_end_ms, h.credit_blocks, h.amount_coins, h.amount_usd,
                h.user_hash_hps, h.network_hashrate, h.created_at
           FROM mining_block_history h
           LEFT JOIN users u ON u.id = h.user_id
           LEFT JOIN mining_coins c ON c.id = h.coin_id
          WHERE {}
          ORDER BY h.window_end_ms DESC, h.id DESC
          LIMIT {}",
        w.sql,
        MAX_EXPORT_ROWS + 1
    );
    let rows = match conn.query(&sql, &params).await {
        Ok(r) => r,
        Err(e) if is_undefined_table(&e) => {
            return Ok(json!({ "csv": header_line(), "rowsWritten": 0, "truncated": false }));
        }
        Err(e) => return Err(e.into()),
    };
    let truncated = rows.len() as i64 > MAX_EXPORT_ROWS;
    let take = if truncated {
        MAX_EXPORT_ROWS as usize
    } else {
        rows.len()
    };

    let mut out = String::from(header_line());
    for r in rows.iter().take(take) {
        let cells = [
            i64_col(r, "id").to_string(),
            i64_col(r, "user_id").to_string(),
            str_col(r, "username"),
            str_col(r, "email"),
            str_col(r, "coin_id"),
            str_col(r, "coin_symbol"),
            str_col(r, "room_id"),
            iso_ms(i64_col(r, "window_start_ms")),
            iso_ms(i64_col(r, "window_end_ms")),
            i64_col(r, "credit_blocks").to_string(),
            f64_col(r, "amount_coins").to_string(),
            f64_col(r, "amount_usd").to_string(),
            f64_col(r, "user_hash_hps").to_string(),
            f64_col(r, "network_hashrate").to_string(),
            iso_ms(i64_col(r, "created_at")),
        ];
        out.push_str(
            &cells
                .iter()
                .map(|c| csv_cell(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    Ok(json!({ "csv": out, "rowsWritten": take, "truncated": truncated }))
}

fn header_line() -> &'static str {
    "id,user_id,username,email,coin_id,coin_symbol,room_id,window_start_utc,window_end_utc,credit_blocks,amount_coins,amount_usd,user_hash_hps,network_hashrate,created_at_utc\n"
}

// ---------------------------------------------------------------------------
// user summary
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummaryRequest {
    pub user_id: i64,
    pub from_ms: i64,
    pub to_ms: i64,
}

pub async fn run_user_summary(pool: &Pool, req: UserSummaryRequest) -> Result<Value, PlayerReadError> {
    if let Some(msg) = validate_range(req.from_ms, req.to_ms, false) {
        return Err(PlayerReadError::bad(msg));
    }
    let uid = i32::try_from(req.user_id).map_err(|_| PlayerReadError::bad("userId inválido."))?;
    let conn = pool.get().await?;
    let rows = match conn
        .query(
            "SELECT h.coin_id, COALESCE(c.symbol, h.coin_id) AS symbol, COALESCE(c.name, h.coin_id) AS name,
                    COALESCE(SUM(h.amount_coins),0)::float8 AS total_coins,
                    COALESCE(SUM(h.amount_usd),0)::float8 AS total_usd,
                    COUNT(*)::bigint AS credit_rows
               FROM mining_block_history h
               LEFT JOIN mining_coins c ON c.id = h.coin_id
              WHERE h.user_id = $1 AND h.window_end_ms >= $2 AND h.window_end_ms <= $3
              GROUP BY h.coin_id, c.symbol, c.name
              ORDER BY total_usd DESC",
            &[&uid, &req.from_ms, &req.to_ms],
        )
        .await
    {
        Ok(r) => r,
        Err(e) if is_undefined_table(&e) => {
            return Ok(json!({
                "userId": req.user_id, "fromMs": req.from_ms, "toMs": req.to_ms,
                "totals": { "totalCoins": 0.0, "totalUsd": 0.0, "creditRows": 0, "uniqueUsers": 1 },
                "byCoin": [],
            }));
        }
        Err(e) => return Err(e.into()),
    };
    let mut total_usd_all = 0.0f64;
    let mut by_coin: Vec<Value> = rows
        .iter()
        .map(|r| {
            let usd = f64_col(r, "total_usd");
            total_usd_all += usd;
            json!({
                "coinId": str_col(r, "coin_id"),
                "symbol": str_col(r, "symbol"),
                "name": str_col(r, "name"),
                "totalCoins": f64_col(r, "total_coins"),
                "totalUsd": usd,
                "creditRows": i64_col(r, "credit_rows"),
                "uniqueUsers": 1,
                "pctOfTotalUsd": 0.0,
                "theoreticalEmissionCoins": Value::Null,
                "emissionUtilizationPct": Value::Null,
            })
        })
        .collect();
    for m in &mut by_coin {
        let usd = m["totalUsd"].as_f64().unwrap_or(0.0);
        m["pctOfTotalUsd"] = json!(if total_usd_all > 0.0 {
            usd / total_usd_all * PERCENT
        } else {
            0.0
        });
    }
    let mut totals = aggregate(pool, req.from_ms, req.to_ms).await?;
    if let Value::Object(ref mut mo) = totals {
        mo.insert("uniqueUsers".into(), json!(1));
    }
    Ok(json!({
        "userId": req.user_id, "fromMs": req.from_ms, "toMs": req.to_ms,
        "totals": totals, "byCoin": by_coin,
    }))
}

// ---------------------------------------------------------------------------
// rebuild rollups
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildRollupsRequest {
    #[serde(default)]
    pub from_day: Option<String>,
    #[serde(default)]
    pub to_day: Option<String>,
    #[serde(default)]
    pub days_back: Option<i64>,
}

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
}

pub async fn run_rebuild_rollups(
    pool: &Pool,
    req: RebuildRollupsRequest,
) -> Result<Value, PlayerReadError> {
    let (from_ymd, to_ymd) = match (req.from_day.as_deref(), req.to_day.as_deref()) {
        (Some(f), Some(t)) if is_ymd(f) && is_ymd(t) => (f.to_string(), t.to_string()),
        _ => {
            let days_back = req.days_back.filter(|d| *d > 0).unwrap_or(DEFAULT_ROLLUP_DAYS_BACK);
            let now = Utc::now().timestamp_millis();
            let to_ymd = ymd_from_ms(now);
            let from_ms = utc_day_start_ms(now) - (days_back - 1) * MS_PER_DAY;
            (ymd_from_ms(from_ms), to_ymd)
        }
    };

    let conn = pool.get().await?;
    let n = match conn
        .execute(
            "INSERT INTO mining_distribution_daily
                (day_utc, coin_id, total_coins, total_usd, credit_rows, unique_users, updated_at)
             SELECT (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date AS day_utc,
                    h.coin_id,
                    COALESCE(SUM(h.amount_coins),0)::float8,
                    COALESCE(SUM(h.amount_usd),0)::float8,
                    COUNT(*)::int,
                    COUNT(DISTINCT h.user_id)::int,
                    (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
               FROM mining_block_history h
              WHERE (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date >= $1::date
                AND (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date <= $2::date
              GROUP BY day_utc, h.coin_id
             ON CONFLICT (day_utc, coin_id) DO UPDATE SET
                total_coins = EXCLUDED.total_coins,
                total_usd = EXCLUDED.total_usd,
                credit_rows = EXCLUDED.credit_rows,
                unique_users = EXCLUDED.unique_users,
                updated_at = EXCLUDED.updated_at",
            &[&from_ymd, &to_ymd],
        )
        .await
    {
        Ok(n) => n as i64,
        Err(e) if is_undefined_table(&e) => 0,
        Err(e) => return Err(e.into()),
    };
    let ymd_ms = |ymd: &str| -> i64 {
        chrono::NaiveDate::parse_from_str(ymd, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|dt| dt.and_utc().timestamp_millis())
            .unwrap_or(0)
    };
    let from_ms = ymd_ms(&from_ymd);
    let to_ms = ymd_ms(&to_ymd);
    let days_processed = if from_ms > 0 && to_ms > 0 {
        (((utc_day_start_ms(to_ms) - utc_day_start_ms(from_ms)) as f64 / MS_PER_DAY as f64).round()
            as i64
            + 1)
        .max(0)
    } else {
        0
    };
    Ok(json!({ "ok": true, "daysProcessed": days_processed, "rowsUpserted": n }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ymd_and_ranges() {
        assert!(is_ymd("2026-09-07"));
        assert!(!is_ymd("2026-9-7"));
        assert_eq!(days_between_utc(0, MS_PER_DAY), 2);
        assert_eq!(days_between_utc(0, 0), 1);
    }

    #[test]
    fn range_validation() {
        assert!(validate_range(10, 5, false).is_some());
        assert!(validate_range(0, MAX_LEDGER_RANGE_MS + 1, false).is_some());
        assert!(validate_range(0, MS_PER_DAY, false).is_none());
    }

    #[test]
    fn csv_escaping() {
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("x\"y"), "\"x\"\"y\"");
        assert_eq!(csv_cell("plain"), "plain");
    }

    #[test]
    fn paths_stable() {
        assert_eq!(MINING_DIST_OVERVIEW_PATH, "/v1/admin/mining-dist/overview");
    }
}
