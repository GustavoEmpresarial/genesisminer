//! Support ticket list / get / state / archive / reopen / admin reads.
//!
//! Mirrors Node `ticket-model.ts` + `buildSupportStatePayload` — the full player
//! `/api/support/state` payload (email hint, limits, ticket DTOs) is built here.

use deadpool_postgres::{GenericClient, Pool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::Row;

use crate::support::TICKET_ID_MAX_LENGTH;

/// Node `SUMMARIES_MAX_LIMIT`.
const SUMMARIES_MAX_LIMIT: i64 = 100;
/// Node `ADMIN_TICKETS_MAX_LIMIT`.
const ADMIN_TICKETS_MAX_LIMIT: i64 = 300;
/// Node `USER_HISTORY_MAX_LIMIT`.
const USER_HISTORY_MAX_LIMIT: i64 = 200;
/// Node `ADMIN_TICKETS_DEFAULT_LIMIT`.
const ADMIN_TICKETS_DEFAULT_LIMIT: i64 = 100;
/// Node `listUserSupportTicketHistorySummaries` default = `SUMMARIES_MAX_LIMIT`.
const USER_HISTORY_DEFAULT_LIMIT: i64 = SUMMARIES_MAX_LIMIT;
/// Node ticket `status` archived.
const TICKET_STATUS_ARCHIVED: &str = "archived";
/// Node ticket `status` open.
const TICKET_STATUS_OPEN: &str = "open";
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_NOT_FOUND`.
const HTTP_NOT_FOUND: u16 = 404;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;
/// Minimum LIMIT / OFFSET clamp floor.
const LIMIT_MIN: i64 = 1;
const _: () = assert!(SUMMARIES_MAX_LIMIT == 100);
const _: () = assert!(ADMIN_TICKETS_MAX_LIMIT == 300);
const _: () = assert!(USER_HISTORY_MAX_LIMIT == 200);
const _: () = assert!(ADMIN_TICKETS_DEFAULT_LIMIT == 100);
const _: () = assert!(USER_HISTORY_DEFAULT_LIMIT == 100);

pub const SUPPORT_LIST_MINE_PATH: &str = "/v1/support/list-mine";
pub const SUPPORT_GET_PATH: &str = "/v1/support/get";
pub const SUPPORT_STATE_PATH: &str = "/v1/support/state";
pub const SUPPORT_ARCHIVE_PATH: &str = "/v1/support/archive";
pub const SUPPORT_REOPEN_PATH: &str = "/v1/support/reopen";
pub const SUPPORT_ADMIN_LIST_PATH: &str = "/v1/support/admin/list";
pub const SUPPORT_ADMIN_GET_PATH: &str = "/v1/support/admin/get";
pub const SUPPORT_ADMIN_HISTORY_PATH: &str = "/v1/support/admin/history";
pub const SUPPORT_ADMIN_STATS_PATH: &str = "/v1/support/admin/stats";
pub const SUPPORT_TICKET_FOR_PLAYER_PATH: &str = "/v1/support/ticket-for-player";
pub const SUPPORT_ATTACHMENT_REFERENCED_PATH: &str = "/v1/support/attachment-referenced";

const SUMMARY_SELECT: &str = "SELECT t.id, t.subject, t.status, t.created_at,
        (SELECT COUNT(*)::int FROM support_ticket_replies r WHERE r.ticket_id = t.id) AS admin_reply_count,
        COALESCE((SELECT MAX(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id = t.id), 0) AS last_admin_at,
        COALESCE((SELECT MAX(p.created_at) FROM support_ticket_player_replies p WHERE p.ticket_id = t.id), t.created_at) AS last_player_at
      FROM support_tickets t";

const ADMIN_TICKET_SELECT: &str =
    "SELECT t.id, t.user_id, t.subject, t.message, t.attachments, t.status, t.created_at,
           u.username, u.email
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id";

const HISTORY_SELECT: &str = "SELECT
      t.id,
      t.subject,
      t.status,
      t.message,
      t.attachments,
      t.created_at,
      (
        1
        + (SELECT COUNT(*)::int FROM support_ticket_player_replies p WHERE p.ticket_id = t.id)
        + (SELECT COUNT(*)::int FROM support_ticket_replies r WHERE r.ticket_id = t.id)
      ) AS message_count,
      GREATEST(
        t.created_at,
        COALESCE((SELECT MAX(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id = t.id), 0::bigint),
        COALESCE((SELECT MAX(p.created_at) FROM support_ticket_player_replies p WHERE p.ticket_id = t.id), 0::bigint)
      ) AS last_message_at,
      (
        SELECT au.username
        FROM support_ticket_replies r
        JOIN users au ON au.id = r.admin_user_id
        WHERE r.ticket_id = t.id
        ORDER BY r.created_at DESC
        LIMIT 1
      ) AS last_admin_username
    FROM support_tickets t";

#[derive(Debug)]
pub struct SupportReadError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl SupportReadError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            code: "VALIDATION",
            message: message.into(),
        }
    }
    fn not_found() -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            code: "NOT_FOUND",
            message: "Ticket não encontrado.".into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            code: "INTERNAL",
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportListMineRequest {
    pub user_id: i64,
    pub limit: Option<i64>,
    pub cursor_created_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportGetRequest {
    pub user_id: i64,
    pub ticket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportStateRequest {
    pub user_id: i64,
    pub limit: Option<i64>,
    pub cursor_created_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportStatusChangeRequest {
    pub user_id: i64,
    pub ticket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminListRequest {
    pub limit: Option<i64>,
    pub ticket_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminGetRequest {
    pub ticket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminHistoryRequest {
    pub user_id: i64,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminStatsRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportTicketForPlayerRequest {
    pub ticket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAttachmentReferencedRequest {
    pub ticket_id: String,
    pub stored_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportTicketForPlayerRow {
    pub id: String,
    pub user_id: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportTicketForPlayerResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<SupportTicketForPlayerRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAttachmentReferencedResponse {
    pub ok: bool,
    pub referenced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSummaryRow {
    pub id: String,
    pub subject: String,
    pub status: String,
    pub created_at: i64,
    pub admin_reply_count: i32,
    pub last_admin_at: i64,
    pub last_player_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportTicketDetailRow {
    pub id: String,
    pub user_id: i64,
    pub subject: String,
    pub message: String,
    pub attachments: serde_json::Value,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminReplyRow {
    pub id: String,
    pub ticket_id: Option<String>,
    pub admin_user_id: Option<i64>,
    pub message: String,
    pub attachments: serde_json::Value,
    pub created_at: i64,
    pub admin_username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportPlayerReplyRow {
    pub id: String,
    pub ticket_id: Option<String>,
    pub message: String,
    pub attachments: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminTicketRow {
    pub id: String,
    pub user_id: i64,
    pub subject: String,
    pub message: String,
    pub attachments: serde_json::Value,
    pub status: String,
    pub created_at: i64,
    pub username: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportHistorySummaryRow {
    pub id: String,
    pub subject: String,
    pub status: String,
    pub message: String,
    pub attachments: serde_json::Value,
    pub created_at: i64,
    pub message_count: i32,
    pub last_message_at: i64,
    pub last_admin_username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportListMineResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summaries: Option<Vec<SupportSummaryRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportGetResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<SupportTicketDetailRow>,
    pub admin_replies: Vec<SupportAdminReplyRow>,
    pub player_replies: Vec<SupportPlayerReplyRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportStatusChangeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminListResponse {
    pub ok: bool,
    pub tickets: Vec<SupportAdminTicketRow>,
    pub admin_replies: Vec<SupportAdminReplyRow>,
    pub player_replies: Vec<SupportPlayerReplyRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminGetResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<SupportAdminTicketRow>,
    pub admin_replies: Vec<SupportAdminReplyRow>,
    pub player_replies: Vec<SupportPlayerReplyRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminHistoryResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summaries: Option<Vec<SupportHistorySummaryRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminStatsResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ticket_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn clamp_limit(raw: Option<i64>, default: i64, max: i64) -> i64 {
    raw.unwrap_or(default).clamp(LIMIT_MIN, max)
}

fn clamp_offset(raw: Option<i64>) -> i64 {
    raw.unwrap_or(0).max(0)
}

fn pg_user_id(user_id: i64) -> Result<i32, SupportReadError> {
    i32::try_from(user_id).map_err(|_| SupportReadError::validation("Invalid request."))
}

fn trim_ticket_id(raw: &str) -> Result<String, SupportReadError> {
    let id: String = raw.trim().chars().take(TICKET_ID_MAX_LENGTH).collect();
    if id.is_empty() {
        return Err(SupportReadError::validation("Invalid request."));
    }
    Ok(id)
}

fn i64_col(row: &Row, col: &str) -> Result<i64, SupportReadError> {
    row.try_get::<_, i64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(i64::from))
        .map_err(|e| SupportReadError::internal(e.to_string()))
}

fn i32_col(row: &Row, col: &str) -> Result<i32, SupportReadError> {
    if let Ok(n) = row.try_get::<_, i32>(col) {
        return Ok(n);
    }
    let n = i64_col(row, col)?;
    i32::try_from(n).map_err(|_| SupportReadError::internal(format!("{col} out of i32 range")))
}

fn json_col(row: &Row, col: &str) -> serde_json::Value {
    if let Ok(v) = row.try_get::<_, serde_json::Value>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<serde_json::Value>>(col) {
        return v;
    }
    serde_json::json!([])
}

fn map_summary(row: &Row) -> Result<SupportSummaryRow, SupportReadError> {
    Ok(SupportSummaryRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        subject: row
            .try_get("subject")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        status: row
            .try_get("status")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        created_at: i64_col(row, "created_at")?,
        admin_reply_count: i32_col(row, "admin_reply_count")?,
        last_admin_at: i64_col(row, "last_admin_at")?,
        last_player_at: i64_col(row, "last_player_at")?,
    })
}

fn map_ticket_detail(row: &Row) -> Result<SupportTicketDetailRow, SupportReadError> {
    Ok(SupportTicketDetailRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        user_id: i64_col(row, "user_id")?,
        subject: row
            .try_get("subject")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        message: row
            .try_get("message")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        attachments: json_col(row, "attachments"),
        status: row
            .try_get("status")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        created_at: i64_col(row, "created_at")?,
    })
}

fn map_admin_ticket(row: &Row) -> Result<SupportAdminTicketRow, SupportReadError> {
    Ok(SupportAdminTicketRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        user_id: i64_col(row, "user_id")?,
        subject: row
            .try_get("subject")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        message: row
            .try_get("message")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        attachments: json_col(row, "attachments"),
        status: row
            .try_get("status")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        created_at: i64_col(row, "created_at")?,
        username: row
            .try_get("username")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        email: row
            .try_get("email")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
    })
}

fn map_admin_reply(
    row: &Row,
    include_ticket_id: bool,
) -> Result<SupportAdminReplyRow, SupportReadError> {
    Ok(SupportAdminReplyRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        ticket_id: if include_ticket_id {
            row.try_get("ticket_id").ok()
        } else {
            None
        },
        admin_user_id: if include_ticket_id {
            i64_col(row, "admin_user_id").ok()
        } else {
            None
        },
        message: row
            .try_get("message")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        attachments: json_col(row, "attachments"),
        created_at: i64_col(row, "created_at")?,
        admin_username: row
            .try_get("admin_username")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
    })
}

fn map_player_reply(
    row: &Row,
    include_ticket_id: bool,
) -> Result<SupportPlayerReplyRow, SupportReadError> {
    Ok(SupportPlayerReplyRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        ticket_id: if include_ticket_id {
            row.try_get("ticket_id").ok()
        } else {
            None
        },
        message: row
            .try_get("message")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        attachments: json_col(row, "attachments"),
        created_at: i64_col(row, "created_at")?,
    })
}

fn map_history(row: &Row) -> Result<SupportHistorySummaryRow, SupportReadError> {
    Ok(SupportHistorySummaryRow {
        id: row
            .try_get("id")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        subject: row
            .try_get("subject")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        status: row
            .try_get("status")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        message: row
            .try_get("message")
            .map_err(|e| SupportReadError::internal(e.to_string()))?,
        attachments: json_col(row, "attachments"),
        created_at: i64_col(row, "created_at")?,
        message_count: i32_col(row, "message_count")?,
        last_message_at: i64_col(row, "last_message_at")?,
        last_admin_username: row.try_get("last_admin_username").ok().flatten(),
    })
}

async fn list_summaries<C: GenericClient>(
    client: &C,
    user_id: i32,
    limit: i64,
    cursor: Option<i64>,
) -> Result<Vec<SupportSummaryRow>, SupportReadError> {
    let rows = if let Some(cursor_at) = cursor {
        let sql = format!(
            "{SUMMARY_SELECT}
      WHERE t.user_id = $1 AND t.created_at < $2
      ORDER BY t.created_at DESC
      LIMIT $3"
        );
        client
            .query(&sql, &[&user_id, &cursor_at, &limit])
            .await
            .map_err(|e| SupportReadError::internal(e.to_string()))?
    } else {
        let sql = format!(
            "{SUMMARY_SELECT}
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2"
        );
        client
            .query(&sql, &[&user_id, &limit])
            .await
            .map_err(|e| SupportReadError::internal(e.to_string()))?
    };
    rows.iter().map(map_summary).collect()
}

async fn list_admin_replies_for_ticket<C: GenericClient>(
    client: &C,
    ticket_id: &str,
    include_ticket_id: bool,
) -> Result<Vec<SupportAdminReplyRow>, SupportReadError> {
    let rows = client
        .query(
            "SELECT r.id, r.ticket_id, r.admin_user_id, r.message, r.attachments, r.created_at, u.username AS admin_username
    FROM support_ticket_replies r
    JOIN users u ON u.id = r.admin_user_id
    WHERE r.ticket_id = $1
    ORDER BY r.created_at ASC",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    rows.iter()
        .map(|r| map_admin_reply(r, include_ticket_id))
        .collect()
}

async fn list_player_replies_for_ticket<C: GenericClient>(
    client: &C,
    ticket_id: &str,
    include_ticket_id: bool,
) -> Result<Vec<SupportPlayerReplyRow>, SupportReadError> {
    let rows = client
        .query(
            "SELECT id, ticket_id, message, attachments, created_at
    FROM support_ticket_player_replies
    WHERE ticket_id = $1
    ORDER BY created_at ASC",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    rows.iter()
        .map(|r| map_player_reply(r, include_ticket_id))
        .collect()
}

async fn list_admin_replies_for_ids<C: GenericClient>(
    client: &C,
    ticket_ids: &[String],
) -> Result<Vec<SupportAdminReplyRow>, SupportReadError> {
    if ticket_ids.is_empty() {
        return Ok(vec![]);
    }
    let rows = client
        .query(
            "SELECT r.id, r.ticket_id, r.admin_user_id, r.message, r.attachments, r.created_at,
           au.username AS admin_username
    FROM support_ticket_replies r
    JOIN users au ON au.id = r.admin_user_id
    WHERE r.ticket_id = ANY($1::text[])
    ORDER BY r.created_at ASC",
            &[&ticket_ids],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    rows.iter().map(|r| map_admin_reply(r, true)).collect()
}

async fn list_player_replies_for_ids<C: GenericClient>(
    client: &C,
    ticket_ids: &[String],
) -> Result<Vec<SupportPlayerReplyRow>, SupportReadError> {
    if ticket_ids.is_empty() {
        return Ok(vec![]);
    }
    let rows = client
        .query(
            "SELECT id, ticket_id, message, attachments, created_at
    FROM support_ticket_player_replies
    WHERE ticket_id = ANY($1::text[])
    ORDER BY created_at ASC",
            &[&ticket_ids],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    rows.iter().map(|r| map_player_reply(r, true)).collect()
}

pub async fn run_support_list_mine(
    pool: &Pool,
    req: SupportListMineRequest,
) -> Result<SupportListMineResponse, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let limit = clamp_limit(req.limit, SUMMARIES_MAX_LIMIT, SUMMARIES_MAX_LIMIT);
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let summaries = list_summaries(&client, user_id, limit, req.cursor_created_at).await?;
    Ok(SupportListMineResponse {
        ok: true,
        summaries: Some(summaries),
        error: None,
        code: None,
    })
}

pub async fn run_support_get(
    pool: &Pool,
    req: SupportGetRequest,
) -> Result<SupportGetResponse, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let ticket_id = trim_ticket_id(&req.ticket_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let row = client
        .query_opt(
            "SELECT id, user_id, subject, message, attachments, status, created_at
             FROM support_tickets WHERE id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(SupportReadError::not_found());
    };
    let ticket = map_ticket_detail(&row)?;
    if ticket.user_id != i64::from(user_id) {
        return Err(SupportReadError::not_found());
    }
    let admin_replies = list_admin_replies_for_ticket(&client, &ticket_id, false).await?;
    let player_replies = list_player_replies_for_ticket(&client, &ticket_id, false).await?;
    Ok(SupportGetResponse {
        ok: true,
        ticket: Some(ticket),
        admin_replies,
        player_replies,
        error: None,
        code: None,
    })
}

/// Node `SUPPORT_UPLOAD_MAX_BYTES` (12 MiB) / `_MAX_FILES` / subject / message caps.
const SUPPORT_UPLOAD_MAX_BYTES: i64 = 12 * 1024 * 1024;
const SUPPORT_UPLOAD_MAX_FILES: i64 = 5;
const SUPPORT_SUBJECT_MAX_LENGTH: i64 = 180;
const SUPPORT_MESSAGE_MAX_LENGTH: i64 = 8000;
/// Node `SUPPORT_ALLOWED_EXT`, already sorted (`Array.from(...).sort()`).
const SUPPORT_ALLOWED_EXT: [&str; 8] = [
    ".gif", ".jpeg", ".jpg", ".mov", ".mp4", ".png", ".webm", ".webp",
];
const SUPPORT_STATE_NOTICE: &str = "Anexos: imagens e vídeo (png, jpeg, webp, gif, mp4, webm, mov). Validação final no servidor. Use idempotencyKey ao criar pedidos.";
/// Node `DEFAULT_PAGE` / `MAX_PAGE` for the player ticket list.
const SUPPORT_STATE_DEFAULT_PAGE: i64 = 20;
const SUPPORT_STATE_MAX_PAGE: i64 = 50;

fn mask_email_hint(email: &str) -> String {
    let e = email.trim();
    match e.find('@') {
        Some(at) if at > 1 => format!("{}…{}", &e[..1], &e[at - 1..]),
        _ => {
            let take = e.chars().take(3).collect::<String>();
            format!("{take}…")
        }
    }
}

/// Full `/api/support/state` payload for the player support page — was Node
/// `buildSupportStatePayload` (`server/modules/support/services/state.ts`).
pub async fn run_support_state(
    pool: &Pool,
    req: SupportStateRequest,
) -> Result<Value, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let limit = clamp_limit(
        req.limit,
        SUPPORT_STATE_DEFAULT_PAGE,
        SUPPORT_STATE_MAX_PAGE,
    );
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let user_row = client
        .query_opt(
            "SELECT email, username FROM users WHERE id = $1",
            &[&user_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let (email, username) = match user_row {
        Some(r) => (
            r.try_get::<_, Option<String>>("email").ok().flatten(),
            r.try_get::<_, Option<String>>("username").ok().flatten(),
        ),
        None => (None, None),
    };
    let summaries = list_summaries(&client, user_id, limit, req.cursor_created_at).await?;

    let mut tickets: Vec<Value> = Vec::with_capacity(summaries.len());
    let mut unread_staff_reply_count = 0;
    let last_created_at = summaries.last().map(|s| s.created_at);
    for r in &summaries {
        let created_at = r.created_at.max(0);
        let last_admin = r.last_admin_at.max(0);
        let last_player = r.last_player_at.max(0);
        let last_activity_at = created_at.max(last_admin).max(last_player);
        let admin_count = r.admin_reply_count.max(0);
        let unread_staff = admin_count > 0
            && last_admin > 0
            && if last_player == 0 {
                last_admin > created_at
            } else {
                last_admin > last_player
            };
        if unread_staff {
            unread_staff_reply_count += 1;
        }
        let status_label = match r.status.as_str() {
            "archived" => "Arquivado",
            "open" => "Aberto",
            other => other,
        };
        tickets.push(json!({
            "publicId": r.id,
            "subject": r.subject,
            "status": r.status,
            "statusLabel": status_label,
            "createdAt": created_at,
            "adminReplyCount": admin_count,
            "lastActivityAt": last_activity_at,
            "unreadStaffReply": unread_staff,
        }));
    }

    let next_cursor = if summaries.len() as i64 == limit {
        last_created_at.map(|c| c.max(0).to_string())
    } else {
        None
    };

    Ok(json!({
        "ok": true,
        "account": {
            "emailHint": email.as_deref().map(mask_email_hint),
            "username": username,
        },
        "limits": {
            "maxAttachmentBytes": SUPPORT_UPLOAD_MAX_BYTES,
            "maxAttachmentCount": SUPPORT_UPLOAD_MAX_FILES,
            "maxSubjectLength": SUPPORT_SUBJECT_MAX_LENGTH,
            "maxMessageLength": SUPPORT_MESSAGE_MAX_LENGTH,
        },
        "allowedExtensions": SUPPORT_ALLOWED_EXT,
        "tickets": tickets,
        "pagination": { "limit": limit, "nextCursor": next_cursor },
        "unreadStaffReplyCount": unread_staff_reply_count,
        "notice": SUPPORT_STATE_NOTICE,
    }))
}

async fn update_status_for_user(
    pool: &Pool,
    req: SupportStatusChangeRequest,
    next_status: &str,
    current_must_be: &str,
) -> Result<SupportStatusChangeResponse, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let ticket_id = trim_ticket_id(&req.ticket_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let n = client
        .execute(
            "UPDATE support_tickets SET status = $1
              WHERE id = $2 AND user_id = $3 AND status = $4",
            &[&next_status, &ticket_id, &user_id, &current_must_be],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    Ok(SupportStatusChangeResponse {
        ok: true,
        updated: Some(i64::try_from(n).unwrap_or(i64::MAX)),
        error: None,
        code: None,
    })
}

pub async fn run_support_archive(
    pool: &Pool,
    req: SupportStatusChangeRequest,
) -> Result<SupportStatusChangeResponse, SupportReadError> {
    update_status_for_user(pool, req, TICKET_STATUS_ARCHIVED, TICKET_STATUS_OPEN).await
}

pub async fn run_support_reopen(
    pool: &Pool,
    req: SupportStatusChangeRequest,
) -> Result<SupportStatusChangeResponse, SupportReadError> {
    update_status_for_user(pool, req, TICKET_STATUS_OPEN, TICKET_STATUS_ARCHIVED).await
}

pub async fn run_support_admin_list(
    pool: &Pool,
    req: SupportAdminListRequest,
) -> Result<SupportAdminListResponse, SupportReadError> {
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let ticket_ids = req
        .ticket_ids
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            s.trim()
                .chars()
                .take(TICKET_ID_MAX_LENGTH)
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if !ticket_ids.is_empty() && req.limit.is_none() {
        let admin_replies = list_admin_replies_for_ids(&client, &ticket_ids).await?;
        let player_replies = list_player_replies_for_ids(&client, &ticket_ids).await?;
        return Ok(SupportAdminListResponse {
            ok: true,
            tickets: vec![],
            admin_replies,
            player_replies,
            error: None,
            code: None,
        });
    }

    let limit = clamp_limit(
        req.limit,
        ADMIN_TICKETS_DEFAULT_LIMIT,
        ADMIN_TICKETS_MAX_LIMIT,
    );
    let sql = format!(
        "{ADMIN_TICKET_SELECT}
    ORDER BY t.created_at DESC
    LIMIT $1"
    );
    let rows = client
        .query(&sql, &[&limit])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let tickets: Vec<SupportAdminTicketRow> = rows
        .iter()
        .map(map_admin_ticket)
        .collect::<Result<_, _>>()?;
    let ids: Vec<String> = tickets.iter().map(|t| t.id.clone()).collect();
    let admin_replies = list_admin_replies_for_ids(&client, &ids).await?;
    let player_replies = list_player_replies_for_ids(&client, &ids).await?;
    Ok(SupportAdminListResponse {
        ok: true,
        tickets,
        admin_replies,
        player_replies,
        error: None,
        code: None,
    })
}

pub async fn run_support_admin_get(
    pool: &Pool,
    req: SupportAdminGetRequest,
) -> Result<SupportAdminGetResponse, SupportReadError> {
    let ticket_id = trim_ticket_id(&req.ticket_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let sql = format!("{ADMIN_TICKET_SELECT} WHERE t.id = $1 LIMIT 1");
    let row = client
        .query_opt(&sql, &[&ticket_id])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(SupportReadError::not_found());
    };
    let ticket = map_admin_ticket(&row)?;
    let admin_replies = list_admin_replies_for_ticket(&client, &ticket_id, true).await?;
    let player_replies = list_player_replies_for_ticket(&client, &ticket_id, true).await?;
    Ok(SupportAdminGetResponse {
        ok: true,
        ticket: Some(ticket),
        admin_replies,
        player_replies,
        error: None,
        code: None,
    })
}

pub async fn run_support_admin_history(
    pool: &Pool,
    req: SupportAdminHistoryRequest,
) -> Result<SupportAdminHistoryResponse, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let limit = clamp_limit(
        req.limit,
        USER_HISTORY_DEFAULT_LIMIT,
        USER_HISTORY_MAX_LIMIT,
    );
    let offset = clamp_offset(req.offset);
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let sql = format!(
        "{HISTORY_SELECT}
    WHERE t.user_id = $1
    ORDER BY last_message_at DESC, t.created_at DESC
    LIMIT $2
    OFFSET $3"
    );
    let rows = client
        .query(&sql, &[&user_id, &limit, &offset])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let summaries: Vec<SupportHistorySummaryRow> =
        rows.iter().map(map_history).collect::<Result<_, _>>()?;
    Ok(SupportAdminHistoryResponse {
        ok: true,
        summaries: Some(summaries),
        error: None,
        code: None,
    })
}

pub async fn run_support_admin_stats(
    pool: &Pool,
    req: SupportAdminStatsRequest,
) -> Result<SupportAdminStatsResponse, SupportReadError> {
    let user_id = pg_user_id(req.user_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let row = client
        .query_one(
            "SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE t.status IS DISTINCT FROM 'archived')::int AS open_count,
      COUNT(*) FILTER (WHERE t.status = 'archived')::int AS archived_count,
      COALESCE(
        MAX(
          GREATEST(
            t.created_at,
            COALESCE((SELECT MAX(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id = t.id), 0::bigint),
            COALESCE((SELECT MAX(p.created_at) FROM support_ticket_player_replies p WHERE p.ticket_id = t.id), 0::bigint)
          )
        ),
        0::bigint
      ) AS last_ticket_at
    FROM support_tickets t
    WHERE t.user_id = $1",
            &[&user_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    Ok(SupportAdminStatsResponse {
        ok: true,
        total: Some(i32_col(&row, "total")?),
        open_count: Some(i32_col(&row, "open_count")?),
        archived_count: Some(i32_col(&row, "archived_count")?),
        last_ticket_at: Some(i64_col(&row, "last_ticket_at")?),
        error: None,
        code: None,
    })
}

fn stored_name_has_control_or_quote(stored_name: &str) -> bool {
    stored_name
        .chars()
        .any(|c| c == '"' || c == '\\' || (c as u32) <= 0x1f)
}

pub async fn run_support_ticket_for_player(
    pool: &Pool,
    req: SupportTicketForPlayerRequest,
) -> Result<SupportTicketForPlayerResponse, SupportReadError> {
    let ticket_id = trim_ticket_id(&req.ticket_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let row = client
        .query_opt(
            "SELECT id, user_id, status FROM support_tickets WHERE id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Ok(SupportTicketForPlayerResponse {
            ok: true,
            ticket: None,
            error: None,
            code: None,
        });
    };
    Ok(SupportTicketForPlayerResponse {
        ok: true,
        ticket: Some(SupportTicketForPlayerRow {
            id: row
                .try_get("id")
                .map_err(|e| SupportReadError::internal(e.to_string()))?,
            user_id: i64_col(&row, "user_id")?,
            status: row
                .try_get("status")
                .map_err(|e| SupportReadError::internal(e.to_string()))?,
        }),
        error: None,
        code: None,
    })
}

pub async fn run_support_attachment_referenced(
    pool: &Pool,
    req: SupportAttachmentReferencedRequest,
) -> Result<SupportAttachmentReferencedResponse, SupportReadError> {
    let stored = req.stored_name.trim();
    if stored.is_empty() || stored_name_has_control_or_quote(stored) {
        return Ok(SupportAttachmentReferencedResponse {
            ok: true,
            referenced: false,
            error: None,
            code: None,
        });
    }
    let ticket_id = match trim_ticket_id(&req.ticket_id) {
        Ok(id) => id,
        Err(_) => {
            return Ok(SupportAttachmentReferencedResponse {
                ok: true,
                referenced: false,
                error: None,
                code: None,
            });
        }
    };
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let ticket = client
        .query_opt(
            "SELECT attachments FROM support_tickets WHERE id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let Some(ticket) = ticket else {
        return Ok(SupportAttachmentReferencedResponse {
            ok: true,
            referenced: false,
            error: None,
            code: None,
        });
    };
    let mut hay = json_col(&ticket, "attachments").to_string();
    let admin_rows = client
        .query(
            "SELECT attachments FROM support_ticket_replies WHERE ticket_id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    for row in admin_rows {
        hay.push_str(&json_col(&row, "attachments").to_string());
    }
    let player_rows = client
        .query(
            "SELECT attachments FROM support_ticket_player_replies WHERE ticket_id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    for row in player_rows {
        hay.push_str(&json_col(&row, "attachments").to_string());
    }
    Ok(SupportAttachmentReferencedResponse {
        ok: true,
        referenced: hay.contains(stored),
        error: None,
        code: None,
    })
}

impl SupportListMineResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            summaries: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportGetResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            ticket: None,
            admin_replies: vec![],
            player_replies: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportStatusChangeResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            updated: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAdminListResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            tickets: vec![],
            admin_replies: vec![],
            player_replies: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAdminGetResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            ticket: None,
            admin_replies: vec![],
            player_replies: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAdminHistoryResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            summaries: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAdminStatsResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            total: None,
            open_count: None,
            archived_count: None,
            last_ticket_at: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportTicketForPlayerResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            ticket: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAttachmentReferencedResponse {
    pub fn from_err(e: SupportReadError) -> Self {
        Self {
            ok: false,
            referenced: false,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}


// ---------------------------------------------------------------------------
// Admin support: full client payloads (was Node `admin.controller.ts` +
// `ticket-model.ts` reshaping). genesis-api only forwards + gates.
// ---------------------------------------------------------------------------

pub const SUPPORT_ADMIN_TICKETS_PAYLOAD_PATH: &str = "/v1/support/admin/tickets-payload";
pub const SUPPORT_ADMIN_TICKET_PAYLOAD_PATH: &str = "/v1/support/admin/ticket-payload";
pub const SUPPORT_ADMIN_USER_HISTORY_PATH: &str = "/v1/support/admin/user-history-payload";
pub const SUPPORT_ADMIN_STATUS_PATH: &str = "/v1/support/admin/status";

const SUPPORT_PREVIEW_MAX: usize = 160;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminTicketsPayloadRequest {
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminTicketPayloadRequest {
    pub ticket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminUserHistoryRequest {
    pub email: String,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminStatusRequest {
    pub id: String,
    pub status: String,
}

fn json_array_or_empty(v: &Value) -> Value {
    if v.is_array() {
        v.clone()
    } else {
        json!([])
    }
}

fn attachments_non_empty(v: &Value) -> bool {
    v.as_array().map(|a| !a.is_empty()).unwrap_or(false)
}

fn preview_text(message: &str) -> String {
    let collapsed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SUPPORT_PREVIEW_MAX {
        collapsed
    } else {
        let head: String = collapsed.chars().take(SUPPORT_PREVIEW_MAX - 1).collect();
        format!("{head}…")
    }
}

fn admin_reply_json(r: &SupportAdminReplyRow) -> Value {
    json!({
        "id": r.id,
        "adminUserId": r.admin_user_id.unwrap_or(0),
        "adminUsername": r.admin_username,
        "message": r.message,
        "attachments": json_array_or_empty(&r.attachments),
        "createdAt": r.created_at.max(0),
    })
}

fn player_reply_json(r: &SupportPlayerReplyRow) -> Value {
    json!({
        "id": r.id,
        "message": r.message,
        "attachments": json_array_or_empty(&r.attachments),
        "createdAt": r.created_at.max(0),
    })
}

fn admin_ticket_json(t: &SupportAdminTicketRow, replies: Vec<Value>, player: Vec<Value>) -> Value {
    json!({
        "id": t.id,
        "userId": t.user_id,
        "username": t.username,
        "email": t.email,
        "subject": t.subject,
        "message": t.message,
        "attachments": json_array_or_empty(&t.attachments),
        "status": t.status,
        "createdAt": t.created_at.max(0),
        "replies": replies,
        "playerReplies": player,
    })
}

fn nest_admin_tickets(
    tickets: &[SupportAdminTicketRow],
    admin_replies: &[SupportAdminReplyRow],
    player_replies: &[SupportPlayerReplyRow],
) -> Vec<Value> {
    let mut by_admin: std::collections::HashMap<&str, Vec<Value>> = std::collections::HashMap::new();
    for r in admin_replies {
        if let Some(tid) = r.ticket_id.as_deref() {
            by_admin.entry(tid).or_default().push(admin_reply_json(r));
        }
    }
    let mut by_player: std::collections::HashMap<&str, Vec<Value>> = std::collections::HashMap::new();
    for r in player_replies {
        if let Some(tid) = r.ticket_id.as_deref() {
            by_player.entry(tid).or_default().push(player_reply_json(r));
        }
    }
    tickets
        .iter()
        .map(|t| {
            let a = by_admin.remove(t.id.as_str()).unwrap_or_default();
            let p = by_player.remove(t.id.as_str()).unwrap_or_default();
            admin_ticket_json(t, a, p)
        })
        .collect()
}

/// Node `GET /api/admin/support-tickets` — `{ tickets: [ …nested ] }`.
pub async fn run_support_admin_tickets_payload(
    pool: &Pool,
    req: SupportAdminTicketsPayloadRequest,
) -> Result<Value, SupportReadError> {
    let limit = clamp_limit(req.limit, ADMIN_TICKETS_DEFAULT_LIMIT, ADMIN_TICKETS_MAX_LIMIT);
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let sql = format!("{ADMIN_TICKET_SELECT}\n    ORDER BY t.created_at DESC\n    LIMIT $1");
    let rows = client
        .query(&sql, &[&limit])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let tickets: Vec<SupportAdminTicketRow> =
        rows.iter().map(map_admin_ticket).collect::<Result<_, _>>()?;
    let ids: Vec<String> = tickets.iter().map(|t| t.id.clone()).collect();
    let admin_replies = list_admin_replies_for_ids(&client, &ids).await?;
    let player_replies = list_player_replies_for_ids(&client, &ids).await?;
    Ok(json!({ "tickets": nest_admin_tickets(&tickets, &admin_replies, &player_replies) }))
}

/// Node `GET /api/admin/support/tickets/:ticketId` — `{ ok, ticket }`.
pub async fn run_support_admin_ticket_payload(
    pool: &Pool,
    req: SupportAdminTicketPayloadRequest,
) -> Result<Value, SupportReadError> {
    let ticket_id = trim_ticket_id(&req.ticket_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let sql = format!("{ADMIN_TICKET_SELECT} WHERE t.id = $1 LIMIT 1");
    let Some(row) = client
        .query_opt(&sql, &[&ticket_id])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?
    else {
        return Err(SupportReadError::not_found());
    };
    let ticket = map_admin_ticket(&row)?;
    let admin_replies = list_admin_replies_for_ticket(&client, &ticket_id, true).await?;
    let player_replies = list_player_replies_for_ticket(&client, &ticket_id, true).await?;
    let nested = nest_admin_tickets(
        std::slice::from_ref(&ticket),
        &admin_replies,
        &player_replies,
    );
    Ok(json!({ "ok": true, "ticket": nested.into_iter().next().unwrap_or(json!(null)) }))
}

/// Node `POST /api/admin/support-tickets/status` — toggle open/archived.
pub async fn run_support_admin_status(
    pool: &Pool,
    req: SupportAdminStatusRequest,
) -> Result<Value, SupportReadError> {
    let id = trim_ticket_id(&req.id)?;
    let status = if req.status.trim() == "archived" {
        "archived"
    } else {
        "open"
    };
    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let n = client
        .execute(
            "UPDATE support_tickets SET status = $1 WHERE id = $2",
            &[&status, &id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    if n == 0 {
        return Err(SupportReadError::not_found());
    }
    Ok(json!({ "ok": true }))
}

/// Node `GET /api/admin/support/user-history` — stats + summaries + account.
pub async fn run_support_admin_user_history_payload(
    pool: &Pool,
    req: SupportAdminUserHistoryRequest,
) -> Result<Value, SupportReadError> {
    let email = req.email.trim().to_string();
    if email.is_empty() {
        return Err(SupportReadError::validation("Informe um email para buscar."));
    }
    let page = req.page.unwrap_or(1).max(1);
    let limit = clamp_limit(req.limit, USER_HISTORY_DEFAULT_LIMIT, USER_HISTORY_MAX_LIMIT);
    let offset = (page - 1) * limit;

    let client = pool
        .get()
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;

    let Some(user_row) = client
        .query_opt(
            "SELECT id, email, username FROM users WHERE lower(email) = lower($1) ORDER BY id ASC LIMIT 1",
            &[&email],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?
    else {
        return Err(SupportReadError {
            http_status: HTTP_NOT_FOUND,
            code: "NOT_FOUND",
            message: "Usuário não encontrado.".into(),
        });
    };
    let user_id: i32 = user_row
        .try_get("id")
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let user_email: String = user_row
        .try_get::<_, Option<String>>("email")
        .ok()
        .flatten()
        .unwrap_or_else(|| email.clone());
    let user_username: String = user_row
        .try_get::<_, Option<String>>("username")
        .ok()
        .flatten()
        .unwrap_or_default();

    let stats_row = client
        .query_one(
            "SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE t.status IS DISTINCT FROM 'archived')::int AS open_count,
      COUNT(*) FILTER (WHERE t.status = 'archived')::int AS archived_count,
      COALESCE(MAX(GREATEST(
        t.created_at,
        COALESCE((SELECT MAX(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id = t.id), 0::bigint),
        COALESCE((SELECT MAX(p.created_at) FROM support_ticket_player_replies p WHERE p.ticket_id = t.id), 0::bigint)
      )), 0::bigint) AS last_ticket_at
    FROM support_tickets t WHERE t.user_id = $1",
            &[&user_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let total = i32_col(&stats_row, "total")?;
    let open_count = i32_col(&stats_row, "open_count")?;
    let archived_count = i32_col(&stats_row, "archived_count")?;
    let last_ticket_at = i64_col(&stats_row, "last_ticket_at")?;

    let start_time: Option<i64> = client
        .query_opt(
            "SELECT start_time FROM game_states WHERE user_id = $1",
            &[&user_id],
        )
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?
        .and_then(|r| r.try_get::<_, Option<i64>>("start_time").ok().flatten())
        .filter(|n| *n > 0);

    let sql = format!(
        "{HISTORY_SELECT}\n    WHERE t.user_id = $1\n    ORDER BY last_message_at DESC, t.created_at DESC\n    LIMIT $2 OFFSET $3"
    );
    let rows = client
        .query(&sql, &[&user_id, &limit, &offset])
        .await
        .map_err(|e| SupportReadError::internal(e.to_string()))?;
    let summaries: Vec<SupportHistorySummaryRow> =
        rows.iter().map(map_history).collect::<Result<_, _>>()?;

    let ticket_ids: Vec<String> = summaries.iter().map(|s| s.id.clone()).collect();
    let mut reply_attach_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    if !ticket_ids.is_empty() {
        for r in list_admin_replies_for_ids(&client, &ticket_ids).await? {
            if attachments_non_empty(&r.attachments) {
                if let Some(tid) = r.ticket_id {
                    reply_attach_ids.insert(tid);
                }
            }
        }
        for r in list_player_replies_for_ids(&client, &ticket_ids).await? {
            if attachments_non_empty(&r.attachments) {
                if let Some(tid) = r.ticket_id {
                    reply_attach_ids.insert(tid);
                }
            }
        }
    }

    let tickets: Vec<Value> = summaries
        .iter()
        .map(|r| {
            let last = if r.last_message_at > 0 {
                r.last_message_at
            } else {
                r.created_at.max(0)
            };
            json!({
                "id": r.id,
                "subject": r.subject,
                "status": r.status,
                "createdAt": r.created_at.max(0),
                "updatedAt": last,
                "lastMessageAt": last,
                "messageCount": r.message_count.max(1),
                "hasAttachments": attachments_non_empty(&r.attachments) || reply_attach_ids.contains(&r.id),
                "assignedTo": r.last_admin_username,
                "preview": preview_text(&r.message),
            })
        })
        .collect();

    let has_more = offset + (summaries.len() as i64) < i64::from(total);

    Ok(json!({
        "ok": true,
        "user": {
            "id": user_id,
            "email": user_email,
            "username": user_username,
            "createdAt": start_time,
        },
        "summary": {
            "total": total,
            "open": open_count,
            "archived": archived_count,
            "lastTicketAt": last_ticket_at,
        },
        "pagination": { "page": page, "limit": limit, "hasMore": has_more },
        "tickets": tickets,
    }))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_limit_matches_node() {
        assert_eq!(
            clamp_limit(None, SUMMARIES_MAX_LIMIT, SUMMARIES_MAX_LIMIT),
            SUMMARIES_MAX_LIMIT
        );
        assert_eq!(
            clamp_limit(Some(0), SUMMARIES_MAX_LIMIT, SUMMARIES_MAX_LIMIT),
            LIMIT_MIN
        );
        assert_eq!(
            clamp_limit(Some(999), SUMMARIES_MAX_LIMIT, SUMMARIES_MAX_LIMIT),
            SUMMARIES_MAX_LIMIT
        );
        assert_eq!(
            clamp_limit(
                Some(999),
                ADMIN_TICKETS_DEFAULT_LIMIT,
                ADMIN_TICKETS_MAX_LIMIT
            ),
            ADMIN_TICKETS_MAX_LIMIT
        );
        assert_eq!(
            clamp_limit(Some(5), USER_HISTORY_DEFAULT_LIMIT, USER_HISTORY_MAX_LIMIT),
            5
        );
    }

    #[test]
    fn clamp_offset_never_negative() {
        assert_eq!(clamp_offset(None), 0);
        assert_eq!(clamp_offset(Some(-4)), 0);
        assert_eq!(clamp_offset(Some(10)), 10);
    }

    #[test]
    fn paths_match_node_client() {
        assert_eq!(SUPPORT_LIST_MINE_PATH, "/v1/support/list-mine");
        assert_eq!(SUPPORT_GET_PATH, "/v1/support/get");
        assert_eq!(SUPPORT_STATE_PATH, "/v1/support/state");
        assert_eq!(SUPPORT_ARCHIVE_PATH, "/v1/support/archive");
        assert_eq!(SUPPORT_REOPEN_PATH, "/v1/support/reopen");
        assert_eq!(SUPPORT_ADMIN_LIST_PATH, "/v1/support/admin/list");
        assert_eq!(SUPPORT_ADMIN_GET_PATH, "/v1/support/admin/get");
        assert_eq!(SUPPORT_ADMIN_HISTORY_PATH, "/v1/support/admin/history");
        assert_eq!(SUPPORT_ADMIN_STATS_PATH, "/v1/support/admin/stats");
        assert_eq!(
            SUPPORT_TICKET_FOR_PLAYER_PATH,
            "/v1/support/ticket-for-player"
        );
        assert_eq!(
            SUPPORT_ATTACHMENT_REFERENCED_PATH,
            "/v1/support/attachment-referenced"
        );
        assert!(stored_name_has_control_or_quote("x\"y"));
        assert!(!stored_name_has_control_or_quote("support-7-1-1.png"));
    }
}
