//! Chat INSERT / UPDATE writes — SQL plus mutate gates.
//!
//! Edit/delete mirror Node `canMutateChatMessage` + AUDIO reject + channel
//! access (`server/modules/chat/services/chat.ts`). Returns `CHAT_SELECT_COLS`.

use deadpool_postgres::Pool;
use genesis_core::gerente::ACCOUNT_MANAGER_STATUS_ACTIVE;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_postgres::Row;

/// Node `CHAT_KIND_TEXT`.
const CHAT_KIND_TEXT: &str = "text";
/// Node `CHAT_KIND_AUDIO`.
const CHAT_KIND_AUDIO: &str = "audio";
/// Node `CHAT_CHANNEL_GLOBAL`.
pub(crate) const CHAT_CHANNEL_GLOBAL: &str = "global";
/// Node `CHAT_SELECT_COLS`.
pub(crate) const CHAT_SELECT_COLS: &str =
    "id, user_id, username_snapshot, body, created_at, channel, kind, audio_url, duration_ms, edited_at, deleted_at";
/// Pré-SELECT before mutate — 404 if missing/deleted.
const CHAT_MUTATE_SELECT_SQL: &str =
    "SELECT user_id, channel, kind, deleted_at FROM chat_messages WHERE id = $1";
/// Owner gate on UPDATE — Node `canMutateChatMessage` at SQL.
const CHAT_MUTATE_OWNER_SQL_WHERE: &str = "id = $3 AND user_id = $4 AND deleted_at IS NULL";
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_FORBIDDEN` — codes `FORBIDDEN` / `AUDIO`.
const HTTP_FORBIDDEN: u16 = 403;
/// Node `HTTP_NOT_FOUND`.
const HTTP_NOT_FOUND: u16 = 404;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;

pub const CHAT_INSERT_PATH: &str = "/v1/chat/insert";
pub const CHAT_EDIT_PATH: &str = "/v1/chat/edit";
pub const CHAT_DELETE_PATH: &str = "/v1/chat/delete";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInsertRequest {
    pub user_id: i64,
    pub username: String,
    pub body: String,
    pub channel: String,
    pub created_at: Option<i64>,
    pub kind: Option<String>,
    pub audio_url: Option<String>,
    pub duration_ms: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEditRequest {
    pub user_id: i64,
    pub message_id: String,
    pub body: String,
    pub edited_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeleteRequest {
    pub user_id: i64,
    pub message_id: String,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub id: String,
    pub user_id: i64,
    pub username_snapshot: String,
    pub body: String,
    pub created_at: i64,
    pub channel: String,
    pub kind: Option<String>,
    pub audio_url: Option<String>,
    pub duration_ms: Option<i32>,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInsertResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<ChatMessageRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEditResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<ChatMessageRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeleteResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct ChatWriteError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ChatWriteError {
    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            code: "VALIDATION",
            message: message.into(),
        }
    }
    pub(crate) fn not_found() -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            code: "NOT_FOUND",
            message: "Message not found.".into(),
        }
    }
    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            code: "FORBIDDEN",
            message: message.into(),
        }
    }
    pub(crate) fn audio() -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            code: "AUDIO",
            message: "Audio messages cannot be edited.".into(),
        }
    }
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            code: "INTERNAL",
            message: message.into(),
        }
    }
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn pg_user_id(user_id: i64) -> Result<i32, ChatWriteError> {
    i32::try_from(user_id).map_err(|_| ChatWriteError::validation("Invalid userId."))
}

/// Node `getChatMessageById`: id must be digits.
pub(crate) fn parse_message_id(raw: &str) -> Result<i64, ChatWriteError> {
    let id = raw.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ChatWriteError::not_found());
    }
    id.parse::<i64>().map_err(|_| ChatWriteError::not_found())
}

fn normalize_kind(raw: Option<&str>) -> &'static str {
    match raw.map(|s| s.trim().to_ascii_lowercase()) {
        Some(k) if k == CHAT_KIND_AUDIO => CHAT_KIND_AUDIO,
        _ => CHAT_KIND_TEXT,
    }
}

/// Node `canMutateChatMessage` — twin actor is a single `require_player` uid.
fn can_mutate_chat_message(message_user_id: i64, actor_user_id: i64) -> bool {
    message_user_id == actor_user_id
}

/// Node `parseAmChannel`.
fn parse_am_channel(channel: &str) -> Option<(i32, i32)> {
    let rest = channel.strip_prefix("am:")?;
    let mut parts = rest.split(':');
    let owner = parts.next()?.parse::<i32>().ok()?;
    let manager = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if owner <= 0 || manager <= 0 || owner == manager {
        return None;
    }
    Some((owner, manager))
}

/// Node `normalizeChatChannel`.
pub(crate) fn normalize_chat_channel(raw: &str) -> String {
    let s = raw.trim();
    let s = if s.is_empty() { CHAT_CHANNEL_GLOBAL } else { s };
    if s == CHAT_CHANNEL_GLOBAL {
        return CHAT_CHANNEL_GLOBAL.to_string();
    }
    if let Some((owner, manager)) = parse_am_channel(s) {
        return format!("am:{owner}:{manager}");
    }
    CHAT_CHANNEL_GLOBAL.to_string()
}

/// Same gate as `POST /v1/chat/can-access` (`run_chat_can_access`).
pub(crate) async fn user_can_access_chat_channel(
    pool: &Pool,
    user_id: i64,
    channel: &str,
) -> Result<bool, ChatWriteError> {
    let user_id = pg_user_id(user_id)?;
    let channel = normalize_chat_channel(channel);
    if channel == CHAT_CHANNEL_GLOBAL {
        return Ok(true);
    }
    let Some((owner, manager)) = parse_am_channel(&channel) else {
        return Ok(false);
    };
    if user_id != owner && user_id != manager {
        return Ok(false);
    }
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let rows = client
        .query(
            "SELECT 1 AS ok
               FROM account_manager_contracts
              WHERE owner_user_id = $1
                AND manager_user_id = $2
                AND status = $3
              LIMIT 1",
            &[&owner, &manager, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    Ok(!rows.is_empty())
}

struct ChatMutateRow {
    user_id: i64,
    channel: String,
    kind: Option<String>,
}

async fn load_live_chat_message(
    client: &deadpool_postgres::Object,
    message_id: i64,
) -> Result<ChatMutateRow, ChatWriteError> {
    let row = client
        .query_opt(CHAT_MUTATE_SELECT_SQL, &[&message_id])
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(ChatWriteError::not_found());
    };
    if opt_i64_col(&row, "deleted_at")?.is_some() {
        return Err(ChatWriteError::not_found());
    }
    Ok(ChatMutateRow {
        user_id: i64_col(&row, "user_id")?,
        channel: row
            .try_get("channel")
            .map_err(|e| ChatWriteError::internal(e.to_string()))?,
        kind: row.try_get("kind").ok(),
    })
}

async fn ensure_can_mutate_chat_message(
    pool: &Pool,
    actor_user_id: i64,
    row: &ChatMutateRow,
    own_message_error: &'static str,
) -> Result<(), ChatWriteError> {
    if !can_mutate_chat_message(row.user_id, actor_user_id) {
        return Err(ChatWriteError::forbidden(own_message_error));
    }
    if !user_can_access_chat_channel(pool, actor_user_id, &row.channel).await? {
        return Err(ChatWriteError::forbidden("No access to this channel."));
    }
    Ok(())
}

fn chat_edit_update_sql() -> String {
    format!(
        "UPDATE chat_messages
            SET body = $1, edited_at = $2
          WHERE {CHAT_MUTATE_OWNER_SQL_WHERE}
          RETURNING {CHAT_SELECT_COLS}"
    )
}

fn chat_delete_update_sql() -> String {
    format!(
        "UPDATE chat_messages
                SET deleted_at = $1, body = '', audio_url = NULL, duration_ms = NULL, kind = $2
              WHERE {CHAT_MUTATE_OWNER_SQL_WHERE}
              RETURNING id, channel"
    )
}

pub(crate) fn i64_col(row: &Row, col: &str) -> Result<i64, ChatWriteError> {
    row.try_get::<_, i64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(i64::from))
        .map_err(|e| ChatWriteError::internal(e.to_string()))
}

fn opt_i64_col(row: &Row, col: &str) -> Result<Option<i64>, ChatWriteError> {
    match row.try_get::<_, Option<i64>>(col) {
        Ok(v) => Ok(v),
        Err(_) => match row.try_get::<_, Option<i32>>(col) {
            Ok(v) => Ok(v.map(i64::from)),
            Err(e) => Err(ChatWriteError::internal(e.to_string())),
        },
    }
}

pub(crate) fn map_chat_row(row: &Row) -> Result<ChatMessageRow, ChatWriteError> {
    Ok(ChatMessageRow {
        id: i64_col(row, "id")?.to_string(),
        user_id: i64_col(row, "user_id")?,
        username_snapshot: row
            .try_get("username_snapshot")
            .map_err(|e| ChatWriteError::internal(e.to_string()))?,
        body: row
            .try_get("body")
            .map_err(|e| ChatWriteError::internal(e.to_string()))?,
        created_at: i64_col(row, "created_at")?,
        channel: row
            .try_get("channel")
            .map_err(|e| ChatWriteError::internal(e.to_string()))?,
        kind: row.try_get("kind").ok(),
        audio_url: row.try_get("audio_url").ok().flatten(),
        duration_ms: row.try_get("duration_ms").ok().flatten(),
        edited_at: opt_i64_col(row, "edited_at")?,
        deleted_at: opt_i64_col(row, "deleted_at")?,
    })
}

pub async fn run_chat_insert(
    pool: &Pool,
    req: ChatInsertRequest,
) -> Result<ChatInsertResponse, ChatWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let created_at = req.created_at.unwrap_or_else(current_unix_ms);
    let kind = normalize_kind(req.kind.as_deref());
    let audio_url = req.audio_url.filter(|s| !s.is_empty());
    let duration_ms = req.duration_ms.filter(|n| *n > 0);
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let sql = format!(
        "INSERT INTO chat_messages (user_id, username_snapshot, channel, body, kind, audio_url, duration_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING {CHAT_SELECT_COLS}"
    );
    let row = client
        .query_one(
            &sql,
            &[
                &user_id,
                &req.username,
                &req.channel,
                &req.body,
                &kind,
                &audio_url,
                &duration_ms,
                &created_at,
            ],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    Ok(ChatInsertResponse {
        ok: true,
        row: Some(map_chat_row(&row)?),
        error: None,
        code: None,
    })
}

pub async fn run_chat_edit(
    pool: &Pool,
    req: ChatEditRequest,
) -> Result<ChatEditResponse, ChatWriteError> {
    let actor_user_id = req.user_id;
    let actor_pg = pg_user_id(actor_user_id)?;
    let message_id = parse_message_id(&req.message_id)?;
    let edited_at = req.edited_at.unwrap_or_else(current_unix_ms);
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let existing = load_live_chat_message(&client, message_id).await?;
    if normalize_kind(existing.kind.as_deref()) == CHAT_KIND_AUDIO {
        return Err(ChatWriteError::audio());
    }
    drop(client);
    ensure_can_mutate_chat_message(
        pool,
        actor_user_id,
        &existing,
        "You can only edit your own messages.",
    )
    .await?;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let sql = chat_edit_update_sql();
    let row = client
        .query_opt(&sql, &[&req.body, &edited_at, &message_id, &actor_pg])
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(ChatWriteError::not_found());
    };
    Ok(ChatEditResponse {
        ok: true,
        row: Some(map_chat_row(&row)?),
        error: None,
        code: None,
    })
}

pub async fn run_chat_delete(
    pool: &Pool,
    req: ChatDeleteRequest,
) -> Result<ChatDeleteResponse, ChatWriteError> {
    let actor_user_id = req.user_id;
    let actor_pg = pg_user_id(actor_user_id)?;
    let message_id = parse_message_id(&req.message_id)?;
    let deleted_at = req.deleted_at.unwrap_or_else(current_unix_ms);
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let existing = load_live_chat_message(&client, message_id).await?;
    drop(client);
    ensure_can_mutate_chat_message(
        pool,
        actor_user_id,
        &existing,
        "You can only delete your own messages.",
    )
    .await?;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let sql = chat_delete_update_sql();
    let row = client
        .query_opt(
            &sql,
            &[&deleted_at, &CHAT_KIND_TEXT, &message_id, &actor_pg],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(ChatWriteError::not_found());
    };
    let id = i64_col(&row, "id")?.to_string();
    let channel: String = row
        .try_get("channel")
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    Ok(ChatDeleteResponse {
        ok: true,
        id: Some(id),
        channel: Some(channel),
        deleted_at: Some(deleted_at),
        error: None,
        code: None,
    })
}

impl ChatInsertResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            row: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatEditResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            row: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatDeleteResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            id: None,
            channel: None,
            deleted_at: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_message_id_digits_only() {
        assert_eq!(parse_message_id("42").unwrap(), 42);
        assert!(parse_message_id("").is_err());
        assert!(parse_message_id("1a").is_err());
        assert!(parse_message_id(" 9 ").is_ok());
    }

    #[test]
    fn normalize_kind_audio_or_text() {
        assert_eq!(normalize_kind(Some("audio")), CHAT_KIND_AUDIO);
        assert_eq!(normalize_kind(Some("AUDIO")), CHAT_KIND_AUDIO);
        assert_eq!(normalize_kind(Some("text")), CHAT_KIND_TEXT);
        assert_eq!(normalize_kind(None), CHAT_KIND_TEXT);
    }

    #[test]
    fn chat_edit_request_requires_user_id() {
        let missing = serde_json::from_str::<ChatEditRequest>(r#"{"messageId":"1","body":"hi"}"#);
        assert!(missing.is_err());
        let ok =
            serde_json::from_str::<ChatEditRequest>(r#"{"messageId":"1","body":"hi","userId":7}"#)
                .expect("userId present");
        assert_eq!(ok.user_id, 7);
    }

    #[test]
    fn chat_delete_request_requires_user_id() {
        let missing = serde_json::from_str::<ChatDeleteRequest>(r#"{"messageId":"1"}"#);
        assert!(missing.is_err());
        let ok = serde_json::from_str::<ChatDeleteRequest>(r#"{"messageId":"1","userId":7}"#)
            .expect("userId present");
        assert_eq!(ok.user_id, 7);
    }

    #[test]
    fn mutate_sql_where_includes_user_id() {
        assert!(chat_edit_update_sql().contains("user_id = $4"));
        assert!(CHAT_MUTATE_OWNER_SQL_WHERE.contains("user_id"));
        assert!(chat_delete_update_sql().contains("user_id = $4"));
        assert!(chat_delete_update_sql().contains(CHAT_MUTATE_OWNER_SQL_WHERE));
    }

    #[test]
    fn mutate_http_codes_match_node() {
        let audio = ChatWriteError::audio();
        assert_eq!(audio.http_status, HTTP_FORBIDDEN);
        assert_eq!(audio.code, "AUDIO");
        let forbidden = ChatWriteError::forbidden("You can only edit your own messages.");
        assert_eq!(forbidden.http_status, HTTP_FORBIDDEN);
        assert_eq!(forbidden.code, "FORBIDDEN");
        let missing = ChatWriteError::not_found();
        assert_eq!(missing.http_status, HTTP_NOT_FOUND);
        assert_eq!(missing.code, "NOT_FOUND");
    }

    #[test]
    fn can_mutate_only_own_message() {
        assert!(can_mutate_chat_message(7, 7));
        assert!(!can_mutate_chat_message(7, 8));
    }
}
