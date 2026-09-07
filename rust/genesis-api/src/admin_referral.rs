//! Admin referral program reports (`/api/admin/referrals/*`).
//!
//! Replaces `server/modules/admin/referral/` (Express). `require_admin` gates
//! `Super` (route table in [`crate::admin_auth`]) — parity with the Node module,
//! which had no tab rule. All the SQL runs in `genesis-mining-worker`
//! (`admin_referral.rs`); `network-delete` is the destructive cascade
//! (DECISIONS.md #43) and passes `superAdmin` / `actorId` through for its guard.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
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

const P_SUMMARY: &str = "/api/admin/referrals/summary";
const P_COMMISSIONS: &str = "/api/admin/referrals/commissions";
const P_LINKS: &str = "/api/admin/referrals/links";
const P_EXPORT_CSV: &str = "/api/admin/referrals/export.csv";
const P_LOOKUP: &str = "/api/admin/referrals/lookup";
const P_NETWORK_BLOCK: &str = "/api/admin/referrals/network-block";
const P_NETWORK_DELETE: &str = "/api/admin/referrals/network-delete";

const W_SUMMARY: &str = "/v1/admin/referrals/summary";
const W_COMMISSIONS: &str = "/v1/admin/referrals/commissions";
const W_LINKS: &str = "/v1/admin/referrals/links";
const W_EXPORT_CSV: &str = "/v1/admin/referrals/export-csv";
const W_LOOKUP: &str = "/v1/admin/referrals/lookup";
const W_NETWORK_BLOCK: &str = "/v1/admin/referrals/network-block";
const W_NETWORK_DELETE: &str = "/v1/admin/referrals/network-delete";

const MS_PER_DAY: i64 = 86_400_000;

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// Node `parseDateMs`: number ms or a `YYYY-MM-DD` UTC date.
fn parse_date_ms(raw: Option<&str>) -> Option<i64> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse::<i64>().ok();
    }
    if is_ymd(s) {
        return Some(days_from_civil(s[0..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?) * MS_PER_DAY);
    }
    None
}

#[derive(Debug, Default, Deserialize)]
struct Q {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default, rename = "startDate")]
    start_date: Option<String>,
    #[serde(default, rename = "endDate")]
    end_date: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    referred: Option<String>,
    #[serde(default, rename = "minCommission")]
    min_commission: Option<String>,
    #[serde(default, rename = "maxCommission")]
    max_commission: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

fn n_i64(s: &Option<String>) -> Option<i64> {
    s.as_deref().and_then(|x| x.trim().parse::<i64>().ok())
}
fn n_f64(s: &Option<String>) -> Option<f64> {
    s.as_deref().and_then(|x| x.trim().parse::<f64>().ok())
}

async fn require_super(state: &AppState, headers: &HeaderMap, method: &Method) -> Result<crate::admin_auth::AdminCtx, Response> {
    require_admin(state, headers, method, P_SUMMARY).await
}

async fn summary(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_super(&state, &headers, &Method::GET).await {
        return e;
    }
    forward_mining(&state, W_SUMMARY, json!({})).await
}

fn commissions_body(q: &Q) -> Value {
    json!({
        "page": n_i64(&q.page),
        "limit": n_i64(&q.limit),
        "startMs": parse_date_ms(q.start_date.as_deref()),
        "endMs": parse_date_ms(q.end_date.as_deref()),
        "referrer": q.referrer,
        "referred": q.referred,
        "minCommission": n_f64(&q.min_commission),
        "maxCommission": n_f64(&q.max_commission),
        "q": q.q,
    })
}

async fn commissions(State(state): State<Arc<AppState>>, headers: HeaderMap, Query(q): Query<Q>) -> Response {
    if let Err(e) = require_super(&state, &headers, &Method::GET).await {
        return e;
    }
    forward_mining(&state, W_COMMISSIONS, commissions_body(&q)).await
}

async fn links(State(state): State<Arc<AppState>>, headers: HeaderMap, Query(q): Query<Q>) -> Response {
    if let Err(e) = require_super(&state, &headers, &Method::GET).await {
        return e;
    }
    forward_mining(
        &state,
        W_LINKS,
        json!({ "page": n_i64(&q.page), "limit": n_i64(&q.limit), "q": q.q }),
    )
    .await
}

async fn export_csv(State(state): State<Arc<AppState>>, headers: HeaderMap, Query(q): Query<Q>) -> Response {
    if let Err(e) = require_super(&state, &headers, &Method::GET).await {
        return e;
    }
    let w = match post_mining(&state.cfg, &state.http, W_EXPORT_CSV, &commissions_body(&q)).await {
        Ok(w) => w,
        Err(e) => return json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    };
    if w.status != 0 && w.status != 200 {
        return json_status(w.status, w.body);
    }
    let csv = w.body.get("csv").and_then(Value::as_str).unwrap_or("").to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"referral-commissions-{now}.csv\""),
        )
        .body(Body::from(csv))
        .unwrap()
        .into_response()
}

#[derive(Debug, Default, Deserialize)]
struct LookupQ {
    #[serde(default)]
    q: Option<String>,
}

async fn lookup(State(state): State<Arc<AppState>>, headers: HeaderMap, Query(q): Query<LookupQ>) -> Response {
    if let Err(e) = require_super(&state, &headers, &Method::GET).await {
        return e;
    }
    forward_mining(&state, W_LOOKUP, json!({ "q": q.q })).await
}

async fn network_block(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_NETWORK_BLOCK).await {
        return e;
    }
    forward_mining(&state, W_NETWORK_BLOCK, body).await
}

async fn network_delete(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_NETWORK_DELETE).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let mut payload = body;
    if let Value::Object(ref mut m) = payload {
        m.insert("superAdmin".into(), json!(ctx.is_super_admin));
        m.insert("actorId".into(), json!(ctx.user_id));
    }
    forward_mining(&state, W_NETWORK_DELETE, payload).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_SUMMARY, get(summary))
        .route(P_COMMISSIONS, get(commissions))
        .route(P_LINKS, get(links))
        .route(P_EXPORT_CSV, get(export_csv))
        .route(P_LOOKUP, get(lookup))
        .route(P_NETWORK_BLOCK, post(network_block))
        .route(P_NETWORK_DELETE, post(network_delete))
}
