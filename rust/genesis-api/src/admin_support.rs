//! Admin support tickets (`/api/admin/support-tickets*`, `/api/admin/support/*`).
//!
//! Replaces `server/modules/support/controllers/admin.controller.ts` (Express).
//! `require_admin` gates on tab `support` (route table in [`crate::admin_auth`]);
//! the full payloads are built in `genesis-mining-worker`. Player `/api/support/*`
//! stays in [`crate::player`].

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{FromRequest, Multipart, Path, Query, State};
use axum::http::{HeaderMap, Method, Request};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;
use crate::player::{is_multipart, parse_support_multipart, SUPPORT_MULTIPART_BODY_LIMIT_BYTES};
use crate::session::json_status;

const ADMIN_SUPPORT_TICKETS_PATH: &str = "/api/admin/support-tickets";
const ADMIN_SUPPORT_STATUS_PATH: &str = "/api/admin/support-tickets/status";
const ADMIN_SUPPORT_REPLY_PATH: &str = "/api/admin/support-tickets/reply";
const ADMIN_SUPPORT_USER_HISTORY_PATH: &str = "/api/admin/support/user-history";
const ADMIN_SUPPORT_TICKET_PATH: &str = "/api/admin/support/tickets/{ticket_id}";
/// Legacy (Node-era) detail path — kept so stale admin browser bundles that
/// still call `/api/admin/support-tickets/<id>` don't 404.
const ADMIN_SUPPORT_TICKET_LEGACY_PATH: &str = "/api/admin/support-tickets/{ticket_id}";

// genesis-mining-worker twins.
const W_TICKETS: &str = "/v1/support/admin/tickets-payload";
const W_TICKET: &str = "/v1/support/admin/ticket-payload";
const W_USER_HISTORY: &str = "/v1/support/admin/user-history-payload";
const W_STATUS: &str = "/v1/support/admin/status";
const W_REPLY: &str = "/v1/support/admin-reply";

const TICKET_ID_MAX_LENGTH: usize = 80;

#[derive(Debug, Default, Deserialize)]
struct LimitQ {
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UserHistoryQ {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn tickets(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitQ>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, ADMIN_SUPPORT_TICKETS_PATH).await {
        return e;
    }
    let limit = q.limit.as_deref().and_then(|s| s.trim().parse::<i64>().ok());
    forward_mining(&state, W_TICKETS, json!({ "limit": limit })).await
}

async fn ticket_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, "/api/admin/support/tickets/x").await
    {
        return e;
    }
    let ticket_id: String = ticket_id.trim().chars().take(TICKET_ID_MAX_LENGTH).collect();
    if ticket_id.is_empty() {
        return json_status(400, json!({ "ok": false, "error": "Pedido inválido." }));
    }
    forward_mining(&state, W_TICKET, json!({ "ticketId": ticket_id })).await
}

async fn user_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<UserHistoryQ>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::GET, ADMIN_SUPPORT_USER_HISTORY_PATH).await
    {
        return e;
    }
    let email = q.email.unwrap_or_default();
    if email.trim().is_empty() {
        return json_status(
            400,
            json!({ "ok": false, "error": "Informe um email para buscar." }),
        );
    }
    let page = q.page.as_deref().and_then(|s| s.trim().parse::<i64>().ok());
    let limit = q.limit.as_deref().and_then(|s| s.trim().parse::<i64>().ok());
    forward_mining(
        &state,
        W_USER_HISTORY,
        json!({ "email": email, "page": page, "limit": limit }),
    )
    .await
}

async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, ADMIN_SUPPORT_STATUS_PATH).await {
        return e;
    }
    let id = body.get("id").and_then(Value::as_str).unwrap_or("").trim();
    if id.is_empty() {
        return json_status(400, json!({ "error": "id obrigatório." }));
    }
    let status = body.get("status").and_then(Value::as_str).unwrap_or("open");
    forward_mining(&state, W_STATUS, json!({ "id": id, "status": status })).await
}

async fn reply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, ADMIN_SUPPORT_REPLY_PATH).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let admin_id = ctx.user_id;

    if !is_multipart(&headers) {
        return json_status(
            400,
            json!({ "error": "multipart/form-data obrigatório.", "code": "UPLOAD" }),
        );
    }
    let multipart = match Multipart::from_request(request, &state).await {
        Ok(m) => m,
        Err(e) => return json_status(400, json!({ "error": e.to_string(), "code": "UPLOAD" })),
    };
    let (_subject, message, _idem, ticket_id_raw, attachments) =
        match parse_support_multipart(&state, admin_id, "support-reply", multipart).await {
            Ok(v) => v,
            Err(e) => return e,
        };
    let ticket_id = ticket_id_raw
        .unwrap_or_default()
        .trim()
        .chars()
        .take(TICKET_ID_MAX_LENGTH)
        .collect::<String>();
    if ticket_id.is_empty() {
        return json_status(400, json!({ "error": "ticketId obrigatório." }));
    }
    if message.trim().chars().count() < 3 && attachments.is_empty() {
        return json_status(
            400,
            json!({ "error": "Escreva uma mensagem (mín. 3 caracteres) ou anexe ficheiros." }),
        );
    }
    let payload = json!({
        "replyId": uuid::Uuid::new_v4().to_string(),
        "ticketId": ticket_id,
        "adminUserId": admin_id,
        "message": message,
        "attachmentsJson": serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".into()),
        "createdAt": now_ms(),
    });
    forward_mining(&state, W_REPLY, payload).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(ADMIN_SUPPORT_TICKETS_PATH, get(tickets))
        // nginx 301-redirects `/api/admin/support-tickets` -> `.../support-tickets/`
        // (a `location ^~ /api/admin/support-tickets/` block for the reply upload
        // limit); serve the list on the slashed path too so the browser's
        // followed redirect lands on 200 instead of the fallback 404.
        .route("/api/admin/support-tickets/", get(tickets))
        .route(ADMIN_SUPPORT_STATUS_PATH, post(status))
        .route(
            ADMIN_SUPPORT_REPLY_PATH,
            post(reply).layer(axum::extract::DefaultBodyLimit::max(
                SUPPORT_MULTIPART_BODY_LIMIT_BYTES,
            )),
        )
        .route(ADMIN_SUPPORT_USER_HISTORY_PATH, get(user_history))
        .route(ADMIN_SUPPORT_TICKET_PATH, get(ticket_detail))
        .route(ADMIN_SUPPORT_TICKET_LEGACY_PATH, get(ticket_detail))
}
