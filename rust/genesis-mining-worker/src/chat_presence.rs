//! Chat rate-limit + presence Redis I/O.
//!
//! Node Socket.IO stays emit-only. Keys:
//! - `chat:ratelimit:<userId>` — Node comment in `chat.ts` (`SET NX PX`).
//! - `chat:presence:<channel>` — SET of socket ids (no prior Redis key).

use serde::{Deserialize, Serialize};

use crate::redis_lock::RedisLockClient;

/// Node `CHAT_RATE_LIMIT_MS`.
const CHAT_RATE_LIMIT_MS: u64 = 1200;
/// Node `CHAT_MESSAGE_TTL_MS` — presence SET refresh so crash leftovers expire.
const CHAT_MESSAGE_TTL_MS: u64 = 3_600_000;
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_SERVICE_UNAVAILABLE` style — Redis unset is fail-closed.
const HTTP_UNAVAILABLE: u16 = 503;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;

const _: () = assert!(CHAT_RATE_LIMIT_MS == 1200);
const _: () = assert!(CHAT_MESSAGE_TTL_MS == 3_600_000);

pub const CHAT_RATE_LIMIT_PATH: &str = "/v1/chat/rate-limit";
pub const CHAT_PRESENCE_PATH: &str = "/v1/chat/presence";

const RATE_LIMIT_KEY_PREFIX: &str = "chat:ratelimit:";
const PRESENCE_KEY_PREFIX: &str = "chat:presence:";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRateLimitRequest {
    pub user_id: i64,
    pub now_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRateLimitResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPresenceRequest {
    pub action: String,
    pub channel: String,
    pub socket_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPresenceResponse {
    pub ok: bool,
    pub online: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct ChatPresenceError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ChatPresenceError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            code: "VALIDATION",
            message: message.into(),
        }
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_UNAVAILABLE,
            code: "UNAVAILABLE",
            message: message.into(),
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

impl ChatRateLimitResponse {
    pub fn from_err(e: ChatPresenceError) -> Self {
        Self {
            ok: false,
            retry_after_ms: Some(i64::try_from(CHAT_RATE_LIMIT_MS).unwrap_or(i64::MAX)),
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl ChatPresenceResponse {
    pub fn from_err(e: ChatPresenceError) -> Self {
        Self {
            ok: false,
            online: 0,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

fn rate_key(user_id: i64) -> String {
    format!("{RATE_LIMIT_KEY_PREFIX}{user_id}")
}

fn presence_key(channel: &str) -> String {
    format!("{PRESENCE_KEY_PREFIX}{channel}")
}

pub async fn run_chat_rate_limit(
    locks: &RedisLockClient,
    req: ChatRateLimitRequest,
) -> Result<ChatRateLimitResponse, ChatPresenceError> {
    if req.user_id <= 0 {
        return Err(ChatPresenceError::validation("Invalid userId."));
    }
    if !locks.has_redis() {
        return Err(ChatPresenceError::unavailable("redis unset"));
    }
    let now = req.now_ms.unwrap_or(0);
    let allowed = locks
        .set_nx_px_ms(&rate_key(req.user_id), &now.to_string(), CHAT_RATE_LIMIT_MS)
        .await
        .map_err(|e| ChatPresenceError::internal(e.to_string()))?;
    if allowed {
        return Ok(ChatRateLimitResponse {
            ok: true,
            retry_after_ms: None,
            error: None,
            code: None,
        });
    }
    let remain = locks
        .pttl_ms(&rate_key(req.user_id))
        .await
        .map_err(|e| ChatPresenceError::internal(e.to_string()))?
        .unwrap_or_else(|| i64::try_from(CHAT_RATE_LIMIT_MS).unwrap_or(i64::MAX));
    Ok(ChatRateLimitResponse {
        ok: false,
        retry_after_ms: Some(remain.max(1)),
        error: None,
        code: Some("RATE".into()),
    })
}

pub async fn run_chat_presence(
    locks: &RedisLockClient,
    req: ChatPresenceRequest,
) -> Result<ChatPresenceResponse, ChatPresenceError> {
    if !locks.has_redis() {
        return Err(ChatPresenceError::unavailable("redis unset"));
    }
    let channel = req.channel.trim();
    if channel.is_empty() {
        return Err(ChatPresenceError::validation("Invalid channel."));
    }
    let key = presence_key(channel);
    let action = req.action.trim().to_ascii_lowercase();
    match action.as_str() {
        "join" => {
            let socket_id = req
                .socket_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ChatPresenceError::validation("Invalid socketId."))?;
            locks
                .sadd(&key, socket_id)
                .await
                .map_err(|e| ChatPresenceError::internal(e.to_string()))?;
            locks
                .expire_ms(&key, CHAT_MESSAGE_TTL_MS)
                .await
                .map_err(|e| ChatPresenceError::internal(e.to_string()))?;
        }
        "leave" => {
            let socket_id = req
                .socket_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ChatPresenceError::validation("Invalid socketId."))?;
            locks
                .srem(&key, socket_id)
                .await
                .map_err(|e| ChatPresenceError::internal(e.to_string()))?;
        }
        "count" => {}
        _ => return Err(ChatPresenceError::validation("Invalid presence action.")),
    }
    let online = locks
        .scard(&key)
        .await
        .map_err(|e| ChatPresenceError::internal(e.to_string()))?;
    Ok(ChatPresenceResponse {
        ok: true,
        online,
        error: None,
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_keys_match_node() {
        assert_eq!(CHAT_RATE_LIMIT_PATH, "/v1/chat/rate-limit");
        assert_eq!(CHAT_PRESENCE_PATH, "/v1/chat/presence");
        assert_eq!(rate_key(42), "chat:ratelimit:42");
        assert_eq!(presence_key("global"), "chat:presence:global");
    }
}
