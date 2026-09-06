//! In-app announcement CRUD writes (Prisma `in_app_announcements*`).
//!
//! Node keeps validation / schedule merge / DTO mapping
//! (`server/modules/announcements/services/announcements.ts`). This worker
//! owns INSERT / UPDATE / DELETE / mark-read SQL.

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_postgres::Row;
use uuid::Uuid;

/// Node `ACTIVE_FLAG`.
pub(crate) const ACTIVE_FLAG: i32 = 1;
/// Node `INACTIVE_FLAG`.
const INACTIVE_FLAG: i32 = 0;
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Node `HTTP_NOT_FOUND`.
const HTTP_NOT_FOUND: u16 = 404;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;

pub const ANNOUNCEMENTS_CREATE_PATH: &str = "/v1/announcements/create";
pub const ANNOUNCEMENTS_UPDATE_PATH: &str = "/v1/announcements/update";
pub const ANNOUNCEMENTS_DELETE_PATH: &str = "/v1/announcements/delete";
pub const ANNOUNCEMENTS_MARK_READ_PATH: &str = "/v1/announcements/mark-read";
pub const ANNOUNCEMENTS_PENDING_PATH: &str = "/v1/announcements/pending";
pub const ANNOUNCEMENTS_MINI_BLOG_PATH: &str = "/v1/announcements/mini-blog";
pub const ANNOUNCEMENTS_ADMIN_LIST_PATH: &str = "/v1/announcements/admin-list";
pub const ANNOUNCEMENTS_GET_PATH: &str = "/v1/announcements/get";

/// Node `PENDING_MAX`.
const PENDING_MAX: i64 = 20;
/// Node `MINI_BLOG_MAX`.
const MINI_BLOG_MAX: i64 = 50;
const _: () = assert!(PENDING_MAX == 20);
const _: () = assert!(MINI_BLOG_MAX == 50);

pub(crate) const ANNOUNCEMENT_SELECT_COLS: &str =
    "id, title, message, link, image_url, is_active, priority, starts_at, ends_at, created_at, created_by";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementCreateRequest {
    pub id: Option<String>,
    pub title: String,
    pub message: String,
    pub link: Option<String>,
    pub image_url: Option<String>,
    pub is_active: bool,
    pub priority: i32,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub created_at: Option<i64>,
    pub created_by: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementUpdateRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    pub link: Option<String>,
    pub image_url: Option<String>,
    pub is_active: bool,
    pub priority: i32,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementDeleteRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementMarkReadRequest {
    pub user_id: i64,
    pub announcement_id: String,
    pub read_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementUserListRequest {
    pub user_id: i64,
    pub now_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementGetRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementAdminListItem {
    #[serde(flatten)]
    pub row: AnnouncementRow,
    pub read_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementListResponse {
    pub ok: bool,
    pub rows: Vec<AnnouncementRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementAdminListResponse {
    pub ok: bool,
    pub rows: Vec<AnnouncementAdminListItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementRow {
    pub id: String,
    pub title: String,
    pub message: String,
    pub link: Option<String>,
    pub image_url: Option<String>,
    pub is_active: i32,
    pub priority: i32,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub created_at: i64,
    pub created_by: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementWriteResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<AnnouncementRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct AnnouncementWriteError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl AnnouncementWriteError {
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
            message: "Announcement not found.".into(),
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

pub(crate) fn pg_user_id(user_id: i64) -> Result<i32, AnnouncementWriteError> {
    i32::try_from(user_id).map_err(|_| AnnouncementWriteError::validation("Invalid userId."))
}

fn active_flag(is_active: bool) -> i32 {
    if is_active {
        ACTIVE_FLAG
    } else {
        INACTIVE_FLAG
    }
}

pub(crate) fn i64_col(row: &Row, col: &str) -> Result<i64, AnnouncementWriteError> {
    row.try_get::<_, i64>(col)
        .or_else(|_| row.try_get::<_, i32>(col).map(i64::from))
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))
}

fn opt_i64_col(row: &Row, col: &str) -> Result<Option<i64>, AnnouncementWriteError> {
    match row.try_get::<_, Option<i64>>(col) {
        Ok(v) => Ok(v),
        Err(_) => match row.try_get::<_, Option<i32>>(col) {
            Ok(v) => Ok(v.map(i64::from)),
            Err(e) => Err(AnnouncementWriteError::internal(e.to_string())),
        },
    }
}

pub(crate) fn map_announcement_row(row: &Row) -> Result<AnnouncementRow, AnnouncementWriteError> {
    Ok(AnnouncementRow {
        id: row
            .try_get("id")
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?,
        title: row
            .try_get("title")
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?,
        message: row
            .try_get("message")
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?,
        link: row.try_get("link").ok().flatten(),
        image_url: row.try_get("image_url").ok().flatten(),
        is_active: row
            .try_get("is_active")
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?,
        priority: row
            .try_get("priority")
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?,
        starts_at: opt_i64_col(row, "starts_at")?,
        ends_at: opt_i64_col(row, "ends_at")?,
        created_at: i64_col(row, "created_at")?,
        created_by: row.try_get("created_by").ok().flatten(),
    })
}

async fn count_reads(pool: &Pool, announcement_id: &str) -> Result<i64, AnnouncementWriteError> {
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let row = client
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM in_app_announcement_reads WHERE announcement_id = $1",
            &[&announcement_id],
        )
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    i64_col(&row, "n")
}

pub async fn run_announcement_create(
    pool: &Pool,
    req: AnnouncementCreateRequest,
) -> Result<AnnouncementWriteResponse, AnnouncementWriteError> {
    if req.title.trim().is_empty() || req.message.trim().is_empty() {
        return Err(AnnouncementWriteError::validation(
            "Título e mensagem são obrigatórios.",
        ));
    }
    let id = req
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = req.created_at.unwrap_or_else(current_unix_ms);
    let is_active = active_flag(req.is_active);
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let sql = format!(
        "INSERT INTO in_app_announcements
            (id, title, message, link, image_url, is_active, priority, starts_at, ends_at, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING {ANNOUNCEMENT_SELECT_COLS}"
    );
    let row = client
        .query_one(
            &sql,
            &[
                &id,
                &req.title,
                &req.message,
                &req.link,
                &req.image_url,
                &is_active,
                &req.priority,
                &req.starts_at,
                &req.ends_at,
                &created_at,
                &req.created_by,
            ],
        )
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    Ok(AnnouncementWriteResponse {
        ok: true,
        row: Some(map_announcement_row(&row)?),
        read_count: Some(0),
        deleted: None,
        error: None,
        code: None,
    })
}

pub async fn run_announcement_update(
    pool: &Pool,
    req: AnnouncementUpdateRequest,
) -> Result<AnnouncementWriteResponse, AnnouncementWriteError> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err(AnnouncementWriteError::validation(
            "Invalid announcement identifier.",
        ));
    }
    let is_active = active_flag(req.is_active);
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let sql = format!(
        "UPDATE in_app_announcements
            SET title = $2, message = $3, link = $4, image_url = $5,
                is_active = $6, priority = $7, starts_at = $8, ends_at = $9
          WHERE id = $1
          RETURNING {ANNOUNCEMENT_SELECT_COLS}"
    );
    let row = client
        .query_opt(
            &sql,
            &[
                &id,
                &req.title,
                &req.message,
                &req.link,
                &req.image_url,
                &is_active,
                &req.priority,
                &req.starts_at,
                &req.ends_at,
            ],
        )
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(AnnouncementWriteError::not_found());
    };
    let mapped = map_announcement_row(&row)?;
    drop(client);
    let read_count = count_reads(pool, &mapped.id).await?;
    Ok(AnnouncementWriteResponse {
        ok: true,
        row: Some(mapped),
        read_count: Some(read_count),
        deleted: None,
        error: None,
        code: None,
    })
}

pub async fn run_announcement_delete(
    pool: &Pool,
    req: AnnouncementDeleteRequest,
) -> Result<AnnouncementWriteResponse, AnnouncementWriteError> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err(AnnouncementWriteError::validation(
            "Invalid announcement identifier.",
        ));
    }
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let row = client
        .query_opt(
            "DELETE FROM in_app_announcements WHERE id = $1 RETURNING id",
            &[&id],
        )
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    if row.is_none() {
        return Err(AnnouncementWriteError::not_found());
    }
    Ok(AnnouncementWriteResponse {
        ok: true,
        row: None,
        read_count: None,
        deleted: Some(true),
        error: None,
        code: None,
    })
}

pub async fn run_announcement_mark_read(
    pool: &Pool,
    req: AnnouncementMarkReadRequest,
) -> Result<AnnouncementWriteResponse, AnnouncementWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let announcement_id = req.announcement_id.trim();
    if announcement_id.is_empty() {
        return Err(AnnouncementWriteError::validation(
            "Invalid announcement identifier.",
        ));
    }
    let read_at = req.read_at.unwrap_or_else(current_unix_ms);
    let mut client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let exists = tx
        .query_opt(
            "SELECT id FROM in_app_announcements WHERE id = $1",
            &[&announcement_id],
        )
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    if exists.is_none() {
        tx.rollback()
            .await
            .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
        return Err(AnnouncementWriteError::not_found());
    }
    tx.execute(
        "INSERT INTO in_app_announcement_reads (user_id, announcement_id, read_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, announcement_id) DO UPDATE SET read_at = EXCLUDED.read_at",
        &[&user_id, &announcement_id, &read_at],
    )
    .await
    .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    tx.commit()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    Ok(AnnouncementWriteResponse {
        ok: true,
        row: None,
        read_count: None,
        deleted: None,
        error: None,
        code: None,
    })
}

fn is_within_schedule(starts_at: Option<i64>, ends_at: Option<i64>, at: i64) -> bool {
    if let Some(start) = starts_at {
        if at < start {
            return false;
        }
    }
    if let Some(end) = ends_at {
        if at > end {
            return false;
        }
    }
    true
}

async fn list_announcements_for_user(
    pool: &Pool,
    user_id: i32,
    now_ms: i64,
    unread_only: bool,
    limit: i64,
) -> Result<Vec<AnnouncementRow>, AnnouncementWriteError> {
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let exists_clause = if unread_only { "NOT EXISTS" } else { "EXISTS" };
    let sql = format!(
        "SELECT {ANNOUNCEMENT_SELECT_COLS}
           FROM in_app_announcements a
          WHERE a.is_active = $1
            AND {exists_clause} (
              SELECT 1 FROM in_app_announcement_reads r
               WHERE r.announcement_id = a.id AND r.user_id = $2
            )
            AND (a.starts_at IS NULL OR a.starts_at <= $3)
            AND (a.ends_at IS NULL OR a.ends_at >= $3)
          ORDER BY a.priority DESC, a.created_at DESC
          LIMIT $4"
    );
    let rows = client
        .query(&sql, &[&ACTIVE_FLAG, &user_id, &now_ms, &limit])
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mapped = map_announcement_row(&row)?;
        if is_within_schedule(mapped.starts_at, mapped.ends_at, now_ms) {
            out.push(mapped);
        }
    }
    Ok(out)
}

pub async fn run_announcement_pending(
    pool: &Pool,
    req: AnnouncementUserListRequest,
) -> Result<AnnouncementListResponse, AnnouncementWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let now_ms = req.now_ms.unwrap_or_else(current_unix_ms);
    let rows = list_announcements_for_user(pool, user_id, now_ms, true, PENDING_MAX).await?;
    Ok(AnnouncementListResponse {
        ok: true,
        rows,
        error: None,
        code: None,
    })
}

pub async fn run_announcement_mini_blog(
    pool: &Pool,
    req: AnnouncementUserListRequest,
) -> Result<AnnouncementListResponse, AnnouncementWriteError> {
    let user_id = pg_user_id(req.user_id)?;
    let now_ms = req.now_ms.unwrap_or_else(current_unix_ms);
    let rows = list_announcements_for_user(pool, user_id, now_ms, false, MINI_BLOG_MAX).await?;
    Ok(AnnouncementListResponse {
        ok: true,
        rows,
        error: None,
        code: None,
    })
}

pub async fn run_announcement_admin_list(
    pool: &Pool,
) -> Result<AnnouncementAdminListResponse, AnnouncementWriteError> {
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let sql = format!(
        "SELECT {ANNOUNCEMENT_SELECT_COLS},
                COALESCE((
                  SELECT COUNT(*)::bigint
                    FROM in_app_announcement_reads r
                   WHERE r.announcement_id = a.id
                ), 0) AS read_count
           FROM in_app_announcements a
          ORDER BY a.priority DESC, a.created_at DESC"
    );
    let rows = client
        .query(&sql, &[])
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(AnnouncementAdminListItem {
            row: map_announcement_row(&row)?,
            read_count: i64_col(&row, "read_count")?,
        });
    }
    Ok(AnnouncementAdminListResponse {
        ok: true,
        rows: out,
        error: None,
        code: None,
    })
}

pub async fn run_announcement_get(
    pool: &Pool,
    req: AnnouncementGetRequest,
) -> Result<AnnouncementWriteResponse, AnnouncementWriteError> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err(AnnouncementWriteError::validation(
            "Invalid announcement id.",
        ));
    }
    let client = pool
        .get()
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let sql = format!("SELECT {ANNOUNCEMENT_SELECT_COLS} FROM in_app_announcements WHERE id = $1");
    let row = client
        .query_opt(&sql, &[&id])
        .await
        .map_err(|e| AnnouncementWriteError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(AnnouncementWriteError::not_found());
    };
    let read_count = count_reads(pool, id).await?;
    Ok(AnnouncementWriteResponse {
        ok: true,
        row: Some(map_announcement_row(&row)?),
        read_count: Some(read_count),
        deleted: None,
        error: None,
        code: None,
    })
}

impl AnnouncementListResponse {
    pub fn from_err(e: AnnouncementWriteError) -> Self {
        Self {
            ok: false,
            rows: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl AnnouncementAdminListResponse {
    pub fn from_err(e: AnnouncementWriteError) -> Self {
        Self {
            ok: false,
            rows: vec![],
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

impl AnnouncementWriteResponse {
    pub fn from_err(e: AnnouncementWriteError) -> Self {
        Self {
            ok: false,
            row: None,
            read_count: None,
            deleted: None,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_flag_matches_node() {
        assert_eq!(active_flag(true), ACTIVE_FLAG);
        assert_eq!(active_flag(false), INACTIVE_FLAG);
        assert_eq!(ACTIVE_FLAG, 1);
        assert_eq!(INACTIVE_FLAG, 0);
    }

    #[test]
    fn schedule_window_matches_node() {
        assert!(is_within_schedule(None, None, 100));
        assert!(!is_within_schedule(Some(200), None, 100));
        assert!(!is_within_schedule(None, Some(50), 100));
        assert!(is_within_schedule(Some(100), Some(100), 100));
    }

    #[test]
    fn list_paths_match_node_client() {
        assert_eq!(ANNOUNCEMENTS_PENDING_PATH, "/v1/announcements/pending");
        assert_eq!(ANNOUNCEMENTS_MINI_BLOG_PATH, "/v1/announcements/mini-blog");
        assert_eq!(
            ANNOUNCEMENTS_ADMIN_LIST_PATH,
            "/v1/announcements/admin-list"
        );
        assert_eq!(ANNOUNCEMENTS_GET_PATH, "/v1/announcements/get");
    }
}
