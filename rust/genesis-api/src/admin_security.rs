//! Admin "Segurança e Auditoria" panel (`/api/admin/security/*`,
//! `/api/admin/device-fingerprints`).
//!
//! Replaces `server/modules/admin/{security-stats,security-bulk,device-fingerprint}/`.
//! `require_admin` gates tab `security` for the reads; the three destructive
//! bulk-write endpoints (`bulk-tools/config` POST, `inactive-block/apply`,
//! `force-password-reset/apply`) resolve to `Super` in [`crate::admin_auth`].
//! All SQL runs in `genesis-mining-worker` (`admin_security.rs`); the two
//! `.../apply` calls also hit `genesis-auth` there to wipe sessions.
//!
//! `user-activity` (the shared per-user audit subsystem) is NOT part of this
//! panel migration and stays on Express.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;

const P_STATS: &str = "/api/admin/security/stats";
const P_BLACKLIST: &str = "/api/admin/security/blacklist";
const P_BLACKLIST_ITEM: &str = "/api/admin/security/blacklist/{ip}";
const P_FINGERPRINTS: &str = "/api/admin/device-fingerprints";
const P_BULK_CONFIG: &str = "/api/admin/security/bulk-tools/config";
const P_INACTIVE_PREVIEW: &str = "/api/admin/security/inactive-block/preview";
const P_INACTIVE_APPLY: &str = "/api/admin/security/inactive-block/apply";
const P_PWRESET_PREVIEW: &str = "/api/admin/security/force-password-reset/preview";
const P_PWRESET_APPLY: &str = "/api/admin/security/force-password-reset/apply";

const W_STATS: &str = "/v1/admin/security/stats";
const W_BLACKLIST_ADD: &str = "/v1/admin/security/blacklist/add";
const W_BLACKLIST_REMOVE: &str = "/v1/admin/security/blacklist/remove";
const W_FINGERPRINTS: &str = "/v1/admin/security/device-fingerprints";
const W_BULK_CONFIG_GET: &str = "/v1/admin/security/bulk/config-get";
const W_BULK_CONFIG_SET: &str = "/v1/admin/security/bulk/config-set";
const W_INACTIVE_PREVIEW: &str = "/v1/admin/security/bulk/inactive-preview";
const W_INACTIVE_APPLY: &str = "/v1/admin/security/bulk/inactive-apply";
const W_PWRESET_PREVIEW: &str = "/v1/admin/security/bulk/pwreset-preview";
const W_PWRESET_APPLY: &str = "/v1/admin/security/bulk/pwreset-apply";

#[derive(Debug, Default, Deserialize)]
struct SectionQ {
    #[serde(default)]
    section: Option<String>,
}

async fn stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SectionQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_STATS).await {
        return e;
    }
    forward_mining(&state, W_STATS, json!({ "section": q.section.unwrap_or_default() })).await
}

async fn blacklist_add(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_BLACKLIST).await {
        return e;
    }
    forward_mining(&state, W_BLACKLIST_ADD, body).await
}

async fn blacklist_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ip): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, "/api/admin/security/blacklist/x").await {
        return e;
    }
    forward_mining(&state, W_BLACKLIST_REMOVE, json!({ "ip": ip })).await
}

#[derive(Debug, Default, Deserialize)]
struct FpQ {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
    #[serde(default, rename = "eventType")]
    event_type: Option<String>,
    #[serde(default, rename = "userId")]
    user_id: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

fn n(s: &Option<String>) -> Option<i64> {
    s.as_deref().and_then(|x| x.trim().parse::<i64>().ok())
}

async fn fingerprints(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FpQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_FINGERPRINTS).await {
        return e;
    }
    forward_mining(
        &state,
        W_FINGERPRINTS,
        json!({
            "limit": n(&q.limit),
            "offset": n(&q.offset),
            "eventType": q.event_type,
            "userId": n(&q.user_id),
            "q": q.q,
        }),
    )
    .await
}

async fn bulk_config_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_BULK_CONFIG).await {
        return e;
    }
    forward_mining(&state, W_BULK_CONFIG_GET, json!({})).await
}

async fn bulk_config_set(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_BULK_CONFIG).await {
        return e;
    }
    forward_mining(&state, W_BULK_CONFIG_SET, body).await
}

#[derive(Debug, Default, Deserialize)]
struct DaysQ {
    #[serde(default)]
    days: Option<String>,
}

async fn inactive_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<DaysQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_INACTIVE_PREVIEW).await {
        return e;
    }
    forward_mining(&state, W_INACTIVE_PREVIEW, json!({ "days": n(&q.days) })).await
}

/// The client sends only `{ days }`; the worker requires the confirm phrase, so
/// inject it here (the route is `Super`-gated and the UI shows a confirm dialog).
async fn inactive_apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_INACTIVE_APPLY).await {
        return e;
    }
    let mut payload = body;
    if let Value::Object(ref mut m) = payload {
        m.insert("confirm".into(), json!("BLOQUEAR"));
    } else {
        payload = json!({ "confirm": "BLOQUEAR" });
    }
    forward_mining(&state, W_INACTIVE_APPLY, payload).await
}

async fn pwreset_preview(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_PWRESET_PREVIEW).await {
        return e;
    }
    forward_mining(&state, W_PWRESET_PREVIEW, json!({})).await
}

async fn pwreset_apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_PWRESET_APPLY).await {
        return e;
    }
    let mut payload = body;
    if let Value::Object(ref mut m) = payload {
        m.insert("confirm".into(), json!("REDEFINIR"));
    } else {
        payload = json!({ "confirm": "REDEFINIR" });
    }
    forward_mining(&state, W_PWRESET_APPLY, payload).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_STATS, get(stats))
        .route(P_BLACKLIST, post(blacklist_add))
        .route(P_BLACKLIST_ITEM, axum::routing::delete(blacklist_remove))
        .route(P_FINGERPRINTS, get(fingerprints))
        .route(P_BULK_CONFIG, get(bulk_config_get).post(bulk_config_set))
        .route(P_INACTIVE_PREVIEW, get(inactive_preview))
        .route(P_INACTIVE_APPLY, post(inactive_apply))
        .route(P_PWRESET_PREVIEW, get(pwreset_preview))
        .route(P_PWRESET_APPLY, post(pwreset_apply))
}
