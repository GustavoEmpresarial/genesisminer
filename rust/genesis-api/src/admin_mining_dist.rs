//! Admin "Distribuição Mining" reports
//! (`/api/admin/mining-distribution/*`).
//!
//! Replaces `server/modules/admin/mining-distribution/` (Express). `require_admin`
//! gates on tab `reports` (route table in [`crate::admin_auth`]); all the SQL
//! runs in `genesis-mining-worker` (`admin_mining_dist.rs`). Query-string date
//! parsing (ms | `YYYY-MM-DD` UTC | free ISO) stays here so the 400 bodies match.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, Response as HttpResponse, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;
use crate::session::json_status;
use crate::workers::{post_mining, worker_infra_status, worker_unavailable_body};

const P_OVERVIEW: &str = "/api/admin/mining-distribution/overview";
const P_BY_COIN: &str = "/api/admin/mining-distribution/by-coin";
const P_TIMELINE: &str = "/api/admin/mining-distribution/timeline";
const P_CREDITS: &str = "/api/admin/mining-distribution/credits";
const P_CREDITS_CSV: &str = "/api/admin/mining-distribution/credits/export.csv";
const P_USER_SUMMARY: &str = "/api/admin/mining-distribution/users/{user_id}/summary";
const P_REBUILD: &str = "/api/admin/mining-distribution/rebuild-rollups";

const W_OVERVIEW: &str = "/v1/admin/mining-dist/overview";
const W_BY_COIN: &str = "/v1/admin/mining-dist/by-coin";
const W_TIMELINE: &str = "/v1/admin/mining-dist/timeline";
const W_CREDITS: &str = "/v1/admin/mining-dist/credits";
const W_CREDITS_CSV: &str = "/v1/admin/mining-dist/credits-csv";
const W_USER_SUMMARY: &str = "/v1/admin/mining-dist/user-summary";
const W_REBUILD: &str = "/v1/admin/mining-dist/rebuild-rollups";

const MS_PER_DAY: i64 = 86_400_000;
const REBUILD_COOLDOWN_MS: i64 = 60_000;

static LAST_REBUILD_MS: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

/// Node `parseDistributionDateMs`: number ms or `YYYY-MM-DD` (UTC midnight).
/// (The Mining-Distribution panel only ever sends those two forms.)
fn parse_date_ms(raw: Option<&str>) -> Option<i64> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse::<i64>().ok();
    }
    if is_ymd(s) {
        let y: i64 = s[0..4].parse().ok()?;
        let m: i64 = s[5..7].parse().ok()?;
        let d: i64 = s[8..10].parse().ok()?;
        return Some(days_from_civil(y, m, d) * MS_PER_DAY);
    }
    None
}

/// Howard Hinnant's algorithm — days since 1970-01-01 for a civil (UTC) date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn utc_day_start_ms(ts: i64) -> i64 {
    ts - ts.rem_euclid(MS_PER_DAY)
}
fn utc_day_end_ms(ts: i64) -> i64 {
    utc_day_start_ms(ts) + MS_PER_DAY - 1
}

/// Resolve a `to`-style param: if the raw text is `YYYY-MM-DD`, snap to the end
/// of that UTC day (Node `utcDayEndMsFromTs`); otherwise the parsed value.
fn resolve_to(raw: Option<&str>) -> Option<i64> {
    let v = parse_date_ms(raw)?;
    Some(if raw.map(str::trim).map(is_ymd).unwrap_or(false) {
        utc_day_end_ms(v)
    } else {
        v
    })
}

#[derive(Debug, Default, Deserialize)]
struct Q {
    #[serde(default)]
    from: Option<String>,
    #[serde(default, rename = "fromMs")]
    from_ms: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default, rename = "toMs")]
    to_ms: Option<String>,
    #[serde(default, rename = "customFrom")]
    custom_from: Option<String>,
    #[serde(default, rename = "customTo")]
    custom_to: Option<String>,
    #[serde(default)]
    bucket: Option<String>,
    #[serde(default, rename = "coinId")]
    coin_id: Option<String>,
    #[serde(default, rename = "roomId")]
    room_id: Option<String>,
    #[serde(default, rename = "userId")]
    user_id: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

impl Q {
    fn range(&self) -> Option<(i64, i64)> {
        let from = parse_date_ms(self.from.as_deref().or(self.from_ms.as_deref()))?;
        let to = resolve_to(self.to.as_deref().or(self.to_ms.as_deref()))?;
        Some((from, to))
    }
}

fn missing_range() -> Response {
    json_status(
        400,
        json!({ "error": "Parâmetros from e to obrigatórios (ms ou YYYY-MM-DD UTC)." }),
    )
}

async fn gate(state: &AppState, headers: &HeaderMap, method: &Method) -> Result<(), Response> {
    require_admin(state, headers, method, P_OVERVIEW).await.map(|_| ())
}

async fn overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    forward_mining(
        &state,
        W_OVERVIEW,
        json!({
            "customFrom": parse_date_ms(q.custom_from.as_deref()),
            "customTo": resolve_to(q.custom_to.as_deref()),
        }),
    )
    .await
}

async fn by_coin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    let Some((from, to)) = q.range() else {
        return missing_range();
    };
    forward_mining(&state, W_BY_COIN, json!({ "fromMs": from, "toMs": to })).await
}

async fn timeline(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    let Some((from, to)) = q.range() else {
        return missing_range();
    };
    forward_mining(
        &state,
        W_TIMELINE,
        json!({
            "fromMs": from, "toMs": to,
            "bucket": if q.bucket.as_deref() == Some("week") { "week" } else { "day" },
            "coinId": q.coin_id,
        }),
    )
    .await
}

fn credits_payload(q: &Q, from: i64, to: i64) -> Value {
    json!({
        "fromMs": from, "toMs": to,
        "userId": q.user_id.as_deref().and_then(|s| s.trim().parse::<i64>().ok()),
        "coinId": q.coin_id,
        "roomId": q.room_id,
        "q": q.q,
        "page": q.page.as_deref().and_then(|s| s.trim().parse::<i64>().ok()),
        "limit": q.limit.as_deref().and_then(|s| s.trim().parse::<i64>().ok()),
    })
}

async fn credits(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    let Some((from, to)) = q.range() else {
        return missing_range();
    };
    forward_mining(&state, W_CREDITS, credits_payload(&q, from, to)).await
}

async fn credits_csv(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    let Some((from, to)) = q.range() else {
        return missing_range();
    };
    let w = match post_mining(&state.cfg, &state.http, W_CREDITS_CSV, &credits_payload(&q, from, to))
        .await
    {
        Ok(w) => w,
        Err(e) => return json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    };
    if w.status != 0 && w.status != 200 {
        return json_status(w.status, w.body);
    }
    let mut csv = w
        .body
        .get("csv")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if w.body.get("truncated").and_then(Value::as_bool) == Some(true) {
        let n = w.body.get("rowsWritten").and_then(Value::as_i64).unwrap_or(0);
        csv.push_str(&format!("# AVISO: exportação limitada a {n} linhas.\n"));
    }
    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"mining-credits-export.csv\"",
        )
        .body(Body::from(csv))
        .unwrap()
        .into_response()
}

async fn user_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Query(q): Query<Q>,
) -> Response {
    if let Err(e) = gate(&state, &headers, &Method::GET).await {
        return e;
    }
    let Some(uid) = user_id.trim().parse::<i64>().ok().filter(|n| *n > 0) else {
        return json_status(400, json!({ "error": "userId inválido." }));
    };
    let Some((from, to)) = q.range() else {
        return missing_range();
    };
    forward_mining(
        &state,
        W_USER_SUMMARY,
        json!({ "userId": uid, "fromMs": from, "toMs": to }),
    )
    .await
}

async fn rebuild_rollups(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_REBUILD).await {
        return e;
    }
    let now = now_ms();
    let last = LAST_REBUILD_MS.load(Ordering::Relaxed);
    if now - last < REBUILD_COOLDOWN_MS {
        return json_status(
            429,
            json!({ "error": "Aguarde 60 segundos entre reconstruções de rollup." }),
        );
    }
    LAST_REBUILD_MS.store(now, Ordering::Relaxed);
    forward_mining(
        &state,
        W_REBUILD,
        json!({
            "fromDay": body.get("fromDay").and_then(Value::as_str),
            "toDay": body.get("toDay").and_then(Value::as_str),
            "daysBack": body.get("daysBack").and_then(Value::as_i64),
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(parse_date_ms(Some("1970-01-01")), Some(0));
        assert_eq!(parse_date_ms(Some("1970-01-02")), Some(MS_PER_DAY));
        // 2024-02-29 is a valid leap day → 19782 days after epoch.
        assert_eq!(parse_date_ms(Some("2024-02-29")), Some(19_782 * MS_PER_DAY));
        assert_eq!(parse_date_ms(Some("1717200000000")), Some(1_717_200_000_000));
        assert_eq!(parse_date_ms(Some("  ")), None);
        assert_eq!(parse_date_ms(Some("nope")), None);
        // a `to` given as YYYY-MM-DD snaps to 23:59:59.999
        assert_eq!(resolve_to(Some("1970-01-01")), Some(MS_PER_DAY - 1));
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_OVERVIEW, get(overview))
        .route(P_BY_COIN, get(by_coin))
        .route(P_TIMELINE, get(timeline))
        .route(P_CREDITS, get(credits))
        .route(P_CREDITS_CSV, get(credits_csv))
        .route(P_USER_SUMMARY, get(user_summary))
        .route(P_REBUILD, post(rebuild_rollups))
}
