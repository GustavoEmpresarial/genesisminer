//! Chat history / get / sender / peers / mention SQL reads.
//!
//! Sanitize, channel access, and DTO mapping stay on Node
//! (`server/modules/chat/services/chat.ts`).

use deadpool_postgres::Pool;
use genesis_core::gerente::ACCOUNT_MANAGER_STATUS_ACTIVE;
use genesis_core::time::MS_PER_HOUR;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::chat_writes::{
    i64_col, map_chat_row, parse_message_id, user_can_access_chat_channel, ChatMessageRow,
    ChatWriteError, CHAT_SELECT_COLS,
};

/// Node `CHAT_HISTORY_DEFAULT`.
const CHAT_HISTORY_DEFAULT: i64 = 60;
/// Node `CHAT_HISTORY_MAX`.
const CHAT_HISTORY_MAX: i64 = 100;
/// Node `CHAT_MESSAGE_TTL_HOURS`.
const CHAT_MESSAGE_TTL_HOURS: u64 = 1;
/// Node `CHAT_MESSAGE_TTL_MS`.
const CHAT_MESSAGE_TTL_MS: i64 = (CHAT_MESSAGE_TTL_HOURS * MS_PER_HOUR) as i64;
/// Node `MENTION_SEARCH_DEFAULT_LIMIT`.
const MENTION_SEARCH_DEFAULT_LIMIT: i64 = 8;
/// Node `MENTION_SEARCH_MAX_LIMIT`.
const MENTION_SEARCH_MAX_LIMIT: i64 = 10;
/// Node `MENTION_RESOLVE_MAX_ROWS`.
const MENTION_RESOLVE_MAX_ROWS: i64 = 20;
/// Node `MENTION_TOKEN_MAX_LENGTH`.
const MENTION_TOKEN_MAX_LENGTH: usize = 32;
/// Minimum LIMIT clamp floor.
const LIMIT_MIN: i64 = 1;
/// Node `is_blocked` active flag.
const BLOCKED_FLAG: i32 = 1;

const _: () = assert!(CHAT_HISTORY_DEFAULT == 60);
const _: () = assert!(CHAT_HISTORY_MAX == 100);
const _: () = assert!(CHAT_MESSAGE_TTL_MS == 3_600_000);
const _: () = assert!(MENTION_SEARCH_DEFAULT_LIMIT == 8);
const _: () = assert!(MENTION_SEARCH_MAX_LIMIT == 10);
const _: () = assert!(MENTION_RESOLVE_MAX_ROWS == 20);

pub const CHAT_HISTORY_PATH: &str = "/v1/chat/history";
pub const CHAT_GET_PATH: &str = "/v1/chat/get";
pub const CHAT_SENDER_PATH: &str = "/v1/chat/sender";
pub const CHAT_PEERS_PATH: &str = "/v1/chat/peers";
pub const CHAT_MENTIONS_SEARCH_PATH: &str = "/v1/chat/mentions-search";
pub const CHAT_MENTIONS_RESOLVE_PATH: &str = "/v1/chat/mentions-resolve";
pub const CHAT_CAN_ACCESS_PATH: &str = "/v1/chat/can-access";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryRequest {
    pub channel: String,
    pub limit: Option<i64>,
    pub now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGetRequest {
    pub message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSenderRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPeersRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMentionsSearchRequest {
    pub query: String,
    pub limit: Option<i64>,
    pub exclude_user_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMentionsResolveRequest {
    pub tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCanAccessRequest {
    pub user_id: i64,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGetRow {
    pub id: String,
    pub user_id: i64,
    pub channel: String,
    pub kind: Option<String>,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPeerRow {
    pub owner_user_id: i64,
    pub manager_user_id: i64,
    pub owner_username: Option<String>,
    pub manager_username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMentionUserRow {
    pub user_id: i64,
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryResponse {
    pub ok: bool,
    pub rows: Vec<ChatMessageRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGetResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<ChatGetRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSenderResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPeersResponse {
    pub ok: bool,
    pub rows: Vec<ChatPeerRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMentionsResponse {
    pub ok: bool,
    pub users: Vec<ChatMentionUserRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCanAccessResponse {
    pub ok: bool,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn clamp_limit(raw: Option<i64>, default: i64, max: i64) -> i64 {
    raw.unwrap_or(default).clamp(LIMIT_MIN, max)
}

fn pg_user_id(user_id: i64) -> Result<i32, ChatWriteError> {
    i32::try_from(user_id).map_err(|_| ChatWriteError::validation("Invalid userId."))
}

/// Node `escapeIlikePrefix`.
fn escape_ilike_prefix(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn opt_i64_col(row: &tokio_postgres::Row, col: &str) -> Result<Option<i64>, ChatWriteError> {
    match row.try_get::<_, Option<i64>>(col) {
        Ok(v) => Ok(v),
        Err(_) => match row.try_get::<_, Option<i32>>(col) {
            Ok(v) => Ok(v.map(i64::from)),
            Err(e) => Err(ChatWriteError::internal(e.to_string())),
        },
    }
}

pub async fn run_chat_history(
    pool: &Pool,
    req: ChatHistoryRequest,
) -> Result<ChatHistoryResponse, ChatWriteError> {
    let channel = req.channel.trim();
    if channel.is_empty() {
        return Err(ChatWriteError::validation("Invalid channel."));
    }
    let limit = clamp_limit(req.limit, CHAT_HISTORY_DEFAULT, CHAT_HISTORY_MAX);
    let now_ms = req.now_ms.unwrap_or_else(current_unix_ms);
    let cutoff = now_ms - CHAT_MESSAGE_TTL_MS;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let sql = format!(
        "SELECT {CHAT_SELECT_COLS}
     FROM chat_messages
     WHERE channel = $1
       AND deleted_at IS NULL
       AND created_at >= $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3"
    );
    let rows = client
        .query(&sql, &[&channel, &cutoff, &limit])
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let mapped: Vec<ChatMessageRow> = rows.iter().map(map_chat_row).collect::<Result<_, _>>()?;
    Ok(ChatHistoryResponse {
        ok: true,
        rows: mapped,
        error: None,
        code: None,
    })
}

pub async fn run_chat_get(
    pool: &Pool,
    req: ChatGetRequest,
) -> Result<ChatGetResponse, ChatWriteError> {
    let message_id = parse_message_id(&req.message_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let row = client
        .query_opt(
            "SELECT id, user_id, channel, kind, deleted_at FROM chat_messages WHERE id = $1",
            &[&message_id],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Ok(ChatGetResponse {
            ok: true,
            row: None,
            error: None,
            code: None,
        });
    };
    Ok(ChatGetResponse {
        ok: true,
        row: Some(ChatGetRow {
            id: i64_col(&row, "id")?.to_string(),
            user_id: i64_col(&row, "user_id")?,
            channel: row
                .try_get("channel")
                .map_err(|e| ChatWriteError::internal(e.to_string()))?,
            kind: row.try_get("kind").ok(),
            deleted_at: opt_i64_col(&row, "deleted_at")?,
        }),
        error: None,
        code: None,
    })
}

pub async fn run_chat_sender(
    pool: &Pool,
    req: ChatSenderRequest,
) -> Result<ChatSenderResponse, ChatWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let row = client
        .query_opt(
            "SELECT username, COALESCE(is_blocked, 0) AS is_blocked FROM users WHERE id = $1",
            &[&user_id],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Ok(ChatSenderResponse {
            ok: true,
            username: None,
            is_blocked: None,
            error: None,
            code: None,
        });
    };
    let username: String = row
        .try_get("username")
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let blocked: i32 = row.try_get("is_blocked").unwrap_or(0);
    Ok(ChatSenderResponse {
        ok: true,
        username: Some(username),
        is_blocked: Some(blocked == BLOCKED_FLAG),
        error: None,
        code: None,
    })
}

pub async fn run_chat_peers(
    pool: &Pool,
    req: ChatPeersRequest,
) -> Result<ChatPeersResponse, ChatWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let rows = client
        .query(
            "SELECT c.owner_user_id, c.manager_user_id,
            o.username AS owner_username, m.username AS manager_username
       FROM account_manager_contracts c
       JOIN users o ON o.id = c.owner_user_id
       JOIN users m ON m.id = c.manager_user_id
      WHERE c.status = $2
        AND (c.owner_user_id = $1 OR c.manager_user_id = $1)
      ORDER BY c.hired_at DESC NULLS LAST, c.id DESC",
            &[&user_id, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let mapped = rows
        .iter()
        .map(|r| {
            Ok(ChatPeerRow {
                owner_user_id: i64_col(r, "owner_user_id")?,
                manager_user_id: i64_col(r, "manager_user_id")?,
                owner_username: r.try_get("owner_username").ok().flatten(),
                manager_username: r.try_get("manager_username").ok().flatten(),
            })
        })
        .collect::<Result<Vec<_>, ChatWriteError>>()?;
    Ok(ChatPeersResponse {
        ok: true,
        rows: mapped,
        error: None,
        code: None,
    })
}

pub async fn run_chat_mentions_search(
    pool: &Pool,
    req: ChatMentionsSearchRequest,
) -> Result<ChatMentionsResponse, ChatWriteError> {
    let q: String = req.query.chars().take(MENTION_TOKEN_MAX_LENGTH).collect();
    if q.is_empty() {
        return Ok(ChatMentionsResponse {
            ok: true,
            users: vec![],
            error: None,
            code: None,
        });
    }
    let limit = clamp_limit(
        req.limit,
        MENTION_SEARCH_DEFAULT_LIMIT,
        MENTION_SEARCH_MAX_LIMIT,
    );
    let like = format!("{}%", escape_ilike_prefix(&q));
    let exclude = req.exclude_user_id.filter(|n| *n > 0);
    let exclude_i32 = match exclude {
        Some(n) => Some(pg_user_id(n)?),
        None => None,
    };
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let rows = client
        .query(
            "SELECT id, username
       FROM users
      WHERE COALESCE(is_blocked, 0) = 0
        AND ($3::int IS NULL OR id <> $3)
        AND (
          username ILIKE $1 ESCAPE '\\'
          OR replace(username, ' ', '') ILIKE $1 ESCAPE '\\'
          OR replace(username, ' ', '_') ILIKE $1 ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN lower(username) = lower($2) THEN 0
          WHEN lower(replace(username, ' ', '')) = lower($2) THEN 1
          WHEN lower(username) LIKE lower($2) || '%' THEN 2
          ELSE 3
        END,
        char_length(username) ASC,
        username ASC
      LIMIT $4",
            &[&like, &q, &exclude_i32, &limit],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let users = rows
        .iter()
        .map(|r| {
            Ok(ChatMentionUserRow {
                user_id: i64_col(r, "id")?,
                username: r
                    .try_get("username")
                    .map_err(|e| ChatWriteError::internal(e.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, ChatWriteError>>()?;
    Ok(ChatMentionsResponse {
        ok: true,
        users,
        error: None,
        code: None,
    })
}

pub async fn run_chat_mentions_resolve(
    pool: &Pool,
    req: ChatMentionsResolveRequest,
) -> Result<ChatMentionsResponse, ChatWriteError> {
    let keys: Vec<String> = req
        .tokens
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if keys.is_empty() {
        return Ok(ChatMentionsResponse {
            ok: true,
            users: vec![],
            error: None,
            code: None,
        });
    }
    let client = pool
        .get()
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let rows = client
        .query(
            "SELECT id, username
       FROM users
      WHERE COALESCE(is_blocked, 0) = 0
        AND (
          lower(username) = ANY($1::text[])
          OR lower(replace(username, ' ', '')) = ANY($1::text[])
          OR lower(replace(username, ' ', '_')) = ANY($1::text[])
        )
      LIMIT $2",
            &[&keys, &MENTION_RESOLVE_MAX_ROWS],
        )
        .await
        .map_err(|e| ChatWriteError::internal(e.to_string()))?;
    let users = rows
        .iter()
        .map(|r| {
            Ok(ChatMentionUserRow {
                user_id: i64_col(r, "id")?,
                username: r
                    .try_get("username")
                    .map_err(|e| ChatWriteError::internal(e.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, ChatWriteError>>()?;
    Ok(ChatMentionsResponse {
        ok: true,
        users,
        error: None,
        code: None,
    })
}

impl ChatHistoryResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            rows: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatGetResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            row: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatSenderResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            username: None,
            is_blocked: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatPeersResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            rows: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatMentionsResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            users: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatCanAccessResponse {
    pub fn from_err(e: ChatWriteError) -> Self {
        Self {
            ok: false,
            allowed: false,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

pub async fn run_chat_can_access(
    pool: &Pool,
    req: ChatCanAccessRequest,
) -> Result<ChatCanAccessResponse, ChatWriteError> {
    let allowed = user_can_access_chat_channel(pool, req.user_id, &req.channel).await?;
    Ok(ChatCanAccessResponse {
        ok: true,
        allowed,
        error: None,
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_writes::{normalize_chat_channel, CHAT_CHANNEL_GLOBAL};

    #[test]
    fn ttl_matches_node_one_hour() {
        assert_eq!(CHAT_MESSAGE_TTL_MS, 3_600_000);
    }

    #[test]
    fn escape_ilike_prefix_matches_node() {
        assert_eq!(escape_ilike_prefix(r"a%b_c\d"), r"a\%b\_c\\d");
    }

    #[test]
    fn paths_match_node_client() {
        assert_eq!(CHAT_HISTORY_PATH, "/v1/chat/history");
        assert_eq!(CHAT_GET_PATH, "/v1/chat/get");
        assert_eq!(CHAT_SENDER_PATH, "/v1/chat/sender");
        assert_eq!(CHAT_PEERS_PATH, "/v1/chat/peers");
        assert_eq!(CHAT_MENTIONS_SEARCH_PATH, "/v1/chat/mentions-search");
        assert_eq!(CHAT_MENTIONS_RESOLVE_PATH, "/v1/chat/mentions-resolve");
        assert_eq!(CHAT_CAN_ACCESS_PATH, "/v1/chat/can-access");
        assert_eq!(normalize_chat_channel("am:5:5"), CHAT_CHANNEL_GLOBAL);
        assert_eq!(normalize_chat_channel("am:1:2"), "am:1:2");
    }
}
