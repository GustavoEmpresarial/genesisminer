//! Support ticket submit + player reply + admin reply writes.
//!
//! Submit/reply mirror Node `runSupportSubmitTicketMutation` /
//! `runSupportPlayerReplyMutation` (`server/modules/support/services/mutation.ts`):
//! advisory lock + idempotency table `support_submission_idempotency` + INSERT
//! in one TX.
//!
//! Admin reply mirrors Node `insertSupportAdminReply`
//! (`server/modules/support/services/ticket-model.ts`): INSERT into
//! `support_ticket_replies` when the ticket exists (fail-closed 404 otherwise).

use deadpool_postgres::{GenericClient, Pool};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_postgres::types::Json;
use uuid::Uuid;

use genesis_core::time::MS_PER_SECOND;

/// Node `SUBJECT_MAX_LENGTH`.
const SUBJECT_MAX_LENGTH: usize = 180;
/// Node `SUBJECT_MIN_LENGTH`.
const SUBJECT_MIN_LENGTH: usize = 3;
/// Node `MESSAGE_MAX_LENGTH`.
const MESSAGE_MAX_LENGTH: usize = 8000;
/// Node `MESSAGE_MIN_LENGTH_SUBMIT`.
const MESSAGE_MIN_LENGTH_SUBMIT: usize = 10;
/// Node `MESSAGE_MIN_LENGTH_REPLY`.
const MESSAGE_MIN_LENGTH_REPLY: usize = 3;
/// Node `TICKET_ID_MAX_LENGTH`.
pub const TICKET_ID_MAX_LENGTH: usize = 80;
/// Node `HASH_INT32_BYTE_OFFSET`.
const HASH_INT32_BYTE_OFFSET: usize = 4;
/// Node `LOCK_TIMEOUT_MS` = 45_000.
const LOCK_TIMEOUT_SECONDS: u64 = 45;
pub const LOCK_TIMEOUT_MS: i64 = (LOCK_TIMEOUT_SECONDS * MS_PER_SECOND) as i64;
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_NOT_FOUND`.
const HTTP_NOT_FOUND: u16 = 404;
/// Node `HTTP_FORBIDDEN`.
const HTTP_FORBIDDEN: u16 = 403;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;
/// Node `IDEM_SCOPE_SUBMIT`.
const IDEM_SCOPE_SUBMIT: &str = "support_submit_ticket";
/// Node `IDEM_SCOPE_PLAYER_REPLY`.
const IDEM_SCOPE_PLAYER_REPLY: &str = "support_player_reply";
/// Node `IDEMPOTENCY_KEY_MIN_LENGTH`.
const IDEMPOTENCY_KEY_MIN_LENGTH: usize = 8;
/// Node `IDEMPOTENCY_KEY_MAX_LENGTH`.
const IDEMPOTENCY_KEY_MAX_LENGTH: usize = 128;
/// Node ticket `status` that accepts player replies.
const TICKET_STATUS_OPEN: &str = "open";
/// SHA-256 digest length (bytes).
const SHA256_LEN: usize = 32;
/// Signed int32 width (bytes).
const INT32_LEN: usize = 4;

pub const SUPPORT_SUBMIT_PATH: &str = "/v1/support/submit";
pub const SUPPORT_REPLY_PATH: &str = "/v1/support/reply";
pub const SUPPORT_ADMIN_REPLY_PATH: &str = "/v1/support/admin-reply";

const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(HASH_INT32_BYTE_OFFSET == INT32_LEN);
const _: () = assert!(SHA256_LEN >= HASH_INT32_BYTE_OFFSET + INT32_LEN);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAttachmentItem {
    pub url: String,
    pub original_name: String,
    pub mime: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSubmitRequest {
    pub user_id: i64,
    pub subject: String,
    pub message: String,
    #[serde(default)]
    pub attachments: Vec<SupportAttachmentItem>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportReplyRequest {
    pub user_id: i64,
    pub ticket_id: String,
    pub message: String,
    #[serde(default)]
    pub attachments: Vec<SupportAttachmentItem>,
    pub idempotency_key: Option<String>,
}

/// Node `insertSupportAdminReply` params (validation stays on Node).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminReplyRequest {
    pub reply_id: String,
    pub ticket_id: String,
    pub admin_user_id: i64,
    pub message: String,
    #[serde(default)]
    pub attachments_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSubmitResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_replay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportReplyResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_replay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAdminReplyResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct SupportApiError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl SupportApiError {
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
            message: "Order not found.".into(),
        }
    }
    fn ticket_not_found() -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            code: "NOT_FOUND",
            message: "Ticket não encontrado.".into(),
        }
    }
    fn archived() -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            code: "ARCHIVED",
            message: "Este pedido está arquivado. Só podes ver a conversa. Abre um novo pedido para falar connosco de novo.".into(),
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

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn pg_user_id(user_id: i64) -> Result<i32, SupportApiError> {
    i32::try_from(user_id).map_err(|_| SupportApiError::validation("Invalid request."))
}

fn trim_chars(raw: &str, max_len: usize) -> String {
    raw.trim().chars().take(max_len).collect()
}

/// Node `parseIdempotencyKey` — invalid/missing → `None` (write without lock).
fn parse_idempotency_key(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.len() < IDEMPOTENCY_KEY_MIN_LENGTH || trimmed.len() > IDEMPOTENCY_KEY_MAX_LENGTH {
        return None;
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
    if ok {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Node `advisoryPair`: sha256 of `userId\0scope\0key` → two int32 BE.
pub fn advisory_pair(user_id: i64, scope: &str, key: &str) -> (i32, i32) {
    let mut hasher = Sha256::new();
    hasher.update(user_id.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(scope.as_bytes());
    hasher.update([0u8]);
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let k1 = i32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let k2 = i32::from_be_bytes([
        digest[HASH_INT32_BYTE_OFFSET],
        digest[HASH_INT32_BYTE_OFFSET + 1],
        digest[HASH_INT32_BYTE_OFFSET + 2],
        digest[HASH_INT32_BYTE_OFFSET + 3],
    ]);
    (k1, k2)
}

fn attachments_json(items: &[SupportAttachmentItem]) -> serde_json::Value {
    serde_json::to_value(items).unwrap_or_else(|_| serde_json::json!([]))
}

/// Node `insertSupportAdminReply`: invalid JSON → `[]`.
fn parse_attachments_json(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!([]))
}

#[derive(Debug)]
struct PreparedAdminReply {
    reply_id: String,
    ticket_id: String,
    admin_user_id: i32,
    message: String,
}

fn prepare_admin_reply(
    req: &SupportAdminReplyRequest,
) -> Result<PreparedAdminReply, SupportApiError> {
    let reply_id = req.reply_id.trim().to_string();
    if reply_id.is_empty() {
        return Err(SupportApiError::validation("Invalid request."));
    }
    let ticket_id = trim_chars(&req.ticket_id, TICKET_ID_MAX_LENGTH);
    if ticket_id.is_empty() {
        return Err(SupportApiError::validation("Invalid request."));
    }
    let admin_user_id = pg_user_id(req.admin_user_id)?;
    let message = trim_chars(&req.message, MESSAGE_MAX_LENGTH);
    Ok(PreparedAdminReply {
        reply_id,
        ticket_id,
        admin_user_id,
        message,
    })
}

fn read_idempotency_response_id(response_json: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(response_json).ok()?;
    let id = parsed.get("id")?.as_str()?;
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

async fn read_idem_id<C: GenericClient>(
    tx: &C,
    user_id: i32,
    scope: &str,
    key: &str,
) -> Result<Option<String>, SupportApiError> {
    let row = tx
        .query_opt(
            "SELECT response_json FROM support_submission_idempotency
              WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3",
            &[&user_id, &scope, &key],
        )
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(row.and_then(|r| {
        let raw: String = r.try_get("response_json").ok()?;
        read_idempotency_response_id(&raw)
    }))
}

async fn insert_idem_row<C: GenericClient>(
    tx: &C,
    user_id: i32,
    scope: &str,
    key: &str,
    response_id: &str,
    created_at: i64,
) -> Result<(), SupportApiError> {
    let response_json = serde_json::json!({ "id": response_id }).to_string();
    tx.execute(
        "INSERT INTO support_submission_idempotency
            (user_id, scope, idempotency_key, response_json, created_at)
         VALUES ($1, $2, $3, $4, $5)",
        &[&user_id, &scope, &key, &response_json, &created_at],
    )
    .await
    .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(())
}

async fn insert_ticket<C: GenericClient>(
    tx: &C,
    id: &str,
    user_id: i32,
    subject: &str,
    message: &str,
    attachments: &serde_json::Value,
    created_at: i64,
) -> Result<(), SupportApiError> {
    tx.execute(
        "INSERT INTO support_tickets
            (id, user_id, subject, message, attachments, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[
            &id,
            &user_id,
            &subject,
            &message,
            &Json(attachments),
            &TICKET_STATUS_OPEN,
            &created_at,
        ],
    )
    .await
    .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(())
}

async fn insert_player_reply<C: GenericClient>(
    tx: &C,
    reply_id: &str,
    ticket_id: &str,
    user_id: i32,
    message: &str,
    attachments: &serde_json::Value,
    created_at: i64,
) -> Result<(), SupportApiError> {
    tx.execute(
        "INSERT INTO support_ticket_player_replies
            (id, ticket_id, user_id, message, attachments, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)",
        &[
            &reply_id,
            &ticket_id,
            &user_id,
            &message,
            &Json(attachments),
            &created_at,
        ],
    )
    .await
    .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(())
}

/// INSERT only if the ticket row exists — no Prisma FK on `support_ticket_replies`.
async fn insert_admin_reply_if_ticket_exists<C: GenericClient>(
    client: &C,
    reply_id: &str,
    ticket_id: &str,
    admin_user_id: i32,
    message: &str,
    attachments: &serde_json::Value,
    created_at: i64,
) -> Result<(), SupportApiError> {
    let n = client
        .execute(
            "INSERT INTO support_ticket_replies
                (id, ticket_id, admin_user_id, message, attachments, created_at)
             SELECT $1, $2, $3, $4, $5, $6
              WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = $2)",
            &[
                &reply_id,
                &ticket_id,
                &admin_user_id,
                &message,
                &Json(attachments),
                &created_at,
            ],
        )
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    if n == 0 {
        return Err(SupportApiError::ticket_not_found());
    }
    Ok(())
}

async fn assert_ticket_open_for_user<C: GenericClient>(
    tx: &C,
    ticket_id: &str,
    user_id: i32,
) -> Result<(), SupportApiError> {
    let row = tx
        .query_opt(
            "SELECT user_id, status FROM support_tickets WHERE id = $1",
            &[&ticket_id],
        )
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(SupportApiError::not_found());
    };
    let owner: i32 = row
        .try_get("user_id")
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    if owner != user_id {
        return Err(SupportApiError::not_found());
    }
    let status: String = row
        .try_get("status")
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    if status != TICKET_STATUS_OPEN {
        return Err(SupportApiError::archived());
    }
    Ok(())
}

pub async fn run_support_submit(
    pool: &Pool,
    req: SupportSubmitRequest,
) -> Result<SupportSubmitResponse, SupportApiError> {
    let user_id = pg_user_id(req.user_id)?;
    let subject = trim_chars(&req.subject, SUBJECT_MAX_LENGTH);
    let message = trim_chars(&req.message, MESSAGE_MAX_LENGTH);
    if subject.chars().count() < SUBJECT_MIN_LENGTH {
        return Err(SupportApiError::validation(
            "Assunto demasiado curto (mín. 3 characters).",
        ));
    }
    if message.chars().count() < MESSAGE_MIN_LENGTH_SUBMIT {
        return Err(SupportApiError::validation(
            "Mensagem demasiado curta (mín. 10 characters).",
        ));
    }
    let attachments = attachments_json(&req.attachments);
    let idem = parse_idempotency_key(req.idempotency_key.as_deref());
    let id = Uuid::new_v4().to_string();
    let now = current_unix_ms();

    let Some(idem_key) = idem else {
        let client = pool
            .get()
            .await
            .map_err(|e| SupportApiError::internal(e.to_string()))?;
        insert_ticket(&client, &id, user_id, &subject, &message, &attachments, now).await?;
        return Ok(SupportSubmitResponse {
            ok: true,
            id: Some(id),
            idempotent_replay: None,
            error: None,
            code: None,
        });
    };

    let mut client = pool
        .get()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    let (k1, k2) = advisory_pair(req.user_id, IDEM_SCOPE_SUBMIT, &idem_key);
    tx.execute(
        "SELECT pg_advisory_xact_lock($1::int, $2::int)",
        &[&k1, &k2],
    )
    .await
    .map_err(|e| SupportApiError::internal(e.to_string()))?;

    if let Some(existing) = read_idem_id(&tx, user_id, IDEM_SCOPE_SUBMIT, &idem_key).await? {
        tx.commit()
            .await
            .map_err(|e| SupportApiError::internal(e.to_string()))?;
        return Ok(SupportSubmitResponse {
            ok: true,
            id: Some(existing),
            idempotent_replay: Some(true),
            error: None,
            code: None,
        });
    }

    insert_ticket(&tx, &id, user_id, &subject, &message, &attachments, now).await?;
    insert_idem_row(&tx, user_id, IDEM_SCOPE_SUBMIT, &idem_key, &id, now).await?;
    tx.commit()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(SupportSubmitResponse {
        ok: true,
        id: Some(id),
        idempotent_replay: None,
        error: None,
        code: None,
    })
}

pub async fn run_support_reply(
    pool: &Pool,
    req: SupportReplyRequest,
) -> Result<SupportReplyResponse, SupportApiError> {
    let user_id = pg_user_id(req.user_id)?;
    let ticket_id = trim_chars(&req.ticket_id, TICKET_ID_MAX_LENGTH);
    if ticket_id.is_empty() {
        return Err(SupportApiError::validation("Invalid request."));
    }
    let message = trim_chars(&req.message, MESSAGE_MAX_LENGTH);
    if message.chars().count() < MESSAGE_MIN_LENGTH_REPLY && req.attachments.is_empty() {
        return Err(SupportApiError::validation(
            "Escreve uma mensagem (mín. 3 caracteres) ou anexa ficheiros.",
        ));
    }
    let attachments = attachments_json(&req.attachments);
    let idem = parse_idempotency_key(req.idempotency_key.as_deref());
    let idem_scoped = idem.map(|k| format!("{ticket_id}:{k}"));
    let reply_id = Uuid::new_v4().to_string();
    let now = current_unix_ms();

    let Some(idem_key) = idem_scoped else {
        let client = pool
            .get()
            .await
            .map_err(|e| SupportApiError::internal(e.to_string()))?;
        assert_ticket_open_for_user(&client, &ticket_id, user_id).await?;
        insert_player_reply(
            &client,
            &reply_id,
            &ticket_id,
            user_id,
            &message,
            &attachments,
            now,
        )
        .await?;
        return Ok(SupportReplyResponse {
            ok: true,
            reply_id: Some(reply_id),
            idempotent_replay: None,
            error: None,
            code: None,
        });
    };

    let mut client = pool
        .get()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    let (k1, k2) = advisory_pair(req.user_id, IDEM_SCOPE_PLAYER_REPLY, &idem_key);
    tx.execute(
        "SELECT pg_advisory_xact_lock($1::int, $2::int)",
        &[&k1, &k2],
    )
    .await
    .map_err(|e| SupportApiError::internal(e.to_string()))?;

    // Replay stored replyId even if the ticket was archived after the first write.
    if let Some(existing) = read_idem_id(&tx, user_id, IDEM_SCOPE_PLAYER_REPLY, &idem_key).await? {
        tx.commit()
            .await
            .map_err(|e| SupportApiError::internal(e.to_string()))?;
        return Ok(SupportReplyResponse {
            ok: true,
            reply_id: Some(existing),
            idempotent_replay: Some(true),
            error: None,
            code: None,
        });
    }

    assert_ticket_open_for_user(&tx, &ticket_id, user_id).await?;

    insert_player_reply(
        &tx,
        &reply_id,
        &ticket_id,
        user_id,
        &message,
        &attachments,
        now,
    )
    .await?;
    insert_idem_row(
        &tx,
        user_id,
        IDEM_SCOPE_PLAYER_REPLY,
        &idem_key,
        &reply_id,
        now,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    Ok(SupportReplyResponse {
        ok: true,
        reply_id: Some(reply_id),
        idempotent_replay: None,
        error: None,
        code: None,
    })
}

pub async fn run_support_admin_reply(
    pool: &Pool,
    req: SupportAdminReplyRequest,
) -> Result<SupportAdminReplyResponse, SupportApiError> {
    let prepared = prepare_admin_reply(&req)?;
    let attachments = parse_attachments_json(&req.attachments_json);
    let client = pool
        .get()
        .await
        .map_err(|e| SupportApiError::internal(e.to_string()))?;
    insert_admin_reply_if_ticket_exists(
        &client,
        &prepared.reply_id,
        &prepared.ticket_id,
        prepared.admin_user_id,
        &prepared.message,
        &attachments,
        req.created_at,
    )
    .await?;
    Ok(SupportAdminReplyResponse {
        ok: true,
        id: Some(prepared.reply_id),
        error: None,
        code: None,
    })
}

impl SupportSubmitResponse {
    pub fn from_err(e: SupportApiError) -> Self {
        Self {
            ok: false,
            id: None,
            idempotent_replay: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportReplyResponse {
    pub fn from_err(e: SupportApiError) -> Self {
        Self {
            ok: false,
            reply_id: None,
            idempotent_replay: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl SupportAdminReplyResponse {
    pub fn from_err(e: SupportApiError) -> Self {
        Self {
            ok: false,
            id: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_timeout_matches_node() {
        assert_eq!(LOCK_TIMEOUT_MS, 45_000);
    }

    #[test]
    fn advisory_pair_matches_node_sha256_int32be() {
        let (k1, k2) = advisory_pair(1, IDEM_SCOPE_SUBMIT, "key-12345678");
        assert_eq!(k1, 659_444_940);
        assert_eq!(k2, 118_914_917);
    }

    #[test]
    fn advisory_pair_is_stable_and_can_be_negative() {
        let a = advisory_pair(99, IDEM_SCOPE_PLAYER_REPLY, "t1:abc");
        let b = advisory_pair(99, IDEM_SCOPE_PLAYER_REPLY, "t1:abc");
        assert_eq!(a, b);
        let other = advisory_pair(98, IDEM_SCOPE_PLAYER_REPLY, "t1:abc");
        assert_ne!(a, other);
    }

    #[test]
    fn parse_idempotency_key_mirrors_node() {
        assert_eq!(parse_idempotency_key(None), None);
        assert_eq!(parse_idempotency_key(Some("short")), None);
        assert_eq!(
            parse_idempotency_key(Some("key-12345678")),
            Some("key-12345678".into())
        );
        assert_eq!(parse_idempotency_key(Some("bad key!!")), None);
        assert_eq!(
            parse_idempotency_key(Some("  key-12345678  ")),
            Some("key-12345678".into())
        );
    }

    #[test]
    fn trim_chars_caps_subject() {
        let long = "x".repeat(SUBJECT_MAX_LENGTH + 10);
        assert_eq!(
            trim_chars(&long, SUBJECT_MAX_LENGTH).len(),
            SUBJECT_MAX_LENGTH
        );
    }

    #[test]
    fn read_idem_json_requires_nonempty_id() {
        assert_eq!(
            read_idempotency_response_id(r#"{"id":"abc"}"#).as_deref(),
            Some("abc")
        );
        assert_eq!(read_idempotency_response_id(r#"{"id":""}"#), None);
        assert_eq!(read_idempotency_response_id("not-json"), None);
    }

    fn sample_admin_reply() -> SupportAdminReplyRequest {
        SupportAdminReplyRequest {
            reply_id: "r1".into(),
            ticket_id: "t1".into(),
            admin_user_id: 5,
            message: "ok".into(),
            attachments_json: r#"[{"url":"/img/a.png","originalName":"a.png","mime":"image/png"}]"#
                .into(),
            created_at: 1,
        }
    }

    #[test]
    fn admin_reply_path_matches_node_client() {
        assert_eq!(SUPPORT_ADMIN_REPLY_PATH, "/v1/support/admin-reply");
    }

    #[test]
    fn prepare_admin_reply_rejects_empty_ids() {
        let mut req = sample_admin_reply();
        req.reply_id = "   ".into();
        assert_eq!(prepare_admin_reply(&req).unwrap_err().code, "VALIDATION");
        req = sample_admin_reply();
        req.ticket_id = String::new();
        assert_eq!(prepare_admin_reply(&req).unwrap_err().code, "VALIDATION");
    }

    #[test]
    fn prepare_admin_reply_caps_ticket_and_message() {
        let mut req = sample_admin_reply();
        req.ticket_id = "x".repeat(TICKET_ID_MAX_LENGTH + 10);
        req.message = "y".repeat(MESSAGE_MAX_LENGTH + 10);
        let prepared = prepare_admin_reply(&req).expect("valid");
        assert_eq!(prepared.ticket_id.len(), TICKET_ID_MAX_LENGTH);
        assert_eq!(prepared.message.len(), MESSAGE_MAX_LENGTH);
        assert_eq!(prepared.admin_user_id, 5);
    }

    #[test]
    fn parse_attachments_json_invalid_becomes_empty_array() {
        assert_eq!(parse_attachments_json("not-json"), serde_json::json!([]));
        assert_eq!(
            parse_attachments_json(r#"[{"url":"/img/a.png"}]"#),
            serde_json::json!([{ "url": "/img/a.png" }])
        );
    }
}
