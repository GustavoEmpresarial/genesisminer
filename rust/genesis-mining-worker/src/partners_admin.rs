//! Partners YouTube **admin** I/O — ports `server/modules/partners/controllers/partners-admin.controller.ts`
//! + `services/admin-model.ts` + `services/admin-apply.ts` (Express, deleted).
//!
//! Admin auth stays in `genesis-api` (`admin_partners.rs`, tab `partners`);
//! this module runs the SQL. The streamer-room rack teardown lives in
//! `genesis-hardware` (`partners_streamer.rs`) because it needs the rack
//! persist engine; `partner-videos/:id/approve` is forwarded to `genesis-wallet`.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::NFT_AUTO_ROOM_ID;
use crate::partners::{
    sanitize_avatar_url, sanitize_channel_description, sanitize_channel_name, sanitize_channel_url,
    value_str, PartnersError,
};
use crate::player_reads::{i64_cell, now_ms, pg_user_id, string_cell};

pub const PARTNERS_ADMIN_APPLICATIONS_LIST_PATH: &str = "/v1/partners/admin/applications/list";
pub const PARTNERS_ADMIN_APPLICATION_APPROVE_PATH: &str = "/v1/partners/admin/applications/approve";
pub const PARTNERS_ADMIN_APPLICATION_REJECT_PATH: &str = "/v1/partners/admin/applications/reject";
pub const PARTNERS_ADMIN_PARTNERS_LIST_PATH: &str = "/v1/partners/admin/partners/list";
pub const PARTNERS_ADMIN_STREAMER_USERS_PATH: &str = "/v1/partners/admin/streamer-room-users/list";
pub const PARTNERS_ADMIN_ALLOWLIST_ADD_PATH: &str = "/v1/partners/admin/allowlist/add";
pub const PARTNERS_ADMIN_ALLOWLIST_REMOVE_PATH: &str = "/v1/partners/admin/allowlist/remove";
pub const PARTNERS_ADMIN_SUBMISSIONS_LIST_PATH: &str = "/v1/partners/admin/submissions/list";
pub const PARTNERS_ADMIN_SUBMISSION_REJECT_PATH: &str = "/v1/partners/admin/submissions/reject";
pub const PARTNERS_ADMIN_SUBMISSION_DELETE_PATH: &str = "/v1/partners/admin/submissions/delete";
pub const PARTNERS_ADMIN_CREATOR_GET_PATH: &str = "/v1/partners/admin/creator/get";
pub const PARTNERS_ADMIN_CREATOR_PUT_PATH: &str = "/v1/partners/admin/creator/put";

const HTTP_OK: u16 = 200;
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_NOT_FOUND: u16 = 404;

const ADMIN_SUBMISSIONS_LIST_LIMIT: i64 = 300;
const ADMIN_APPLICATIONS_LIST_LIMIT: i64 = 200;
const USER_LOOKUP_MAX_RESULTS: i64 = 3;
const REJECT_REASON_MAX_LENGTH: usize = 500;
const SUBMISSION_ID_MAX_LENGTH: usize = 120;
const CHANNEL_NAME_MIN_LENGTH: usize = 0;

const STREAMER_OVERDUE_DAYS: i64 = 60;
const REQUIRED_APPROVED_PER_YEAR: i64 = 6;
const REQUIRED_INTERVAL_DAYS: i64 = 60;
const DAY_MS: i64 = 86_400_000;
const PARTNER_VIDEO_WINDOW_MS: i64 = REQUIRED_INTERVAL_DAYS * DAY_MS;
const YEAR_365D_MS: i64 = 365 * DAY_MS;

/// Streamer room (levels tester/creator) — `STREAMER_ROOM_ID_CONST` in Node.
const STREAMER_ROOM_ID: &str = "room_1766898636697";
/// Slots granted on the auto NFT room when approving a partner application.
const PARTNER_NFT_ROOM_UNLOCKED_SLOTS: i32 = 4;

fn err(status: u16, msg: &str) -> PartnersError {
    PartnersError {
        http_status: status,
        body: json!({ "error": msg }),
    }
}

fn normalize_list_status(raw: Option<&str>, default_all: bool) -> String {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("pending") => "pending".into(),
        Some("approved") => "approved".into(),
        Some("rejected") => "rejected".into(),
        Some("all") => "all".into(),
        _ => {
            if default_all {
                "all".into()
            } else {
                "pending".into()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminListRequest {
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminIdActionRequest {
    pub id: String,
    pub admin_user_id: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminIdRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminAllowlistAddRequest {
    #[serde(default)]
    pub user_id: Option<Value>,
    #[serde(default)]
    pub username: Option<String>,
    pub admin_user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminUserIdRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersAdminCreatorPutRequest {
    pub user_id: i64,
    pub admin_user_id: i64,
    #[serde(default)]
    pub channel_url: Option<Value>,
    #[serde(default)]
    pub avatar_url: Option<Value>,
    #[serde(default)]
    pub channel_name: Option<Value>,
    #[serde(default)]
    pub description: Option<Value>,
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

const APPLICATION_SELECT: &str = r#"
    SELECT a.id, a.user_id, a.channel_name, a.channel_url, a.avatar_url, a.description, a.status,
           a.created_at, a.reviewed_at, a.reject_reason, u.username, u.email
      FROM partner_youtube_applications a
      JOIN users u ON u.id = a.user_id
"#;

fn map_application_row(r: &tokio_postgres::Row) -> Value {
    let reviewed = i64_cell(r, "reviewed_at");
    let reject = string_cell(r, "reject_reason");
    let mut obj = json!({
        "id": string_cell(r, "id"),
        "userId": i64_cell(r, "user_id"),
        "username": string_cell(r, "username"),
        "email": string_cell(r, "email"),
        "channelName": string_cell(r, "channel_name"),
        "channelUrl": string_cell(r, "channel_url"),
        "avatarUrl": string_cell(r, "avatar_url"),
        "description": string_cell(r, "description"),
        "status": string_cell(r, "status"),
        "createdAt": i64_cell(r, "created_at"),
    });
    if reviewed > 0 {
        obj["reviewedAt"] = json!(reviewed);
    }
    if !reject.is_empty() {
        obj["rejectReason"] = json!(reject);
    }
    obj
}

pub async fn run_admin_applications_list(
    pool: &Pool,
    req: PartnersAdminListRequest,
) -> Result<(u16, Value), PartnersError> {
    let status = normalize_list_status(req.status.as_deref(), false);
    let conn = pool.get().await?;
    let rows = if status == "all" {
        conn.query(
            &format!("{APPLICATION_SELECT} ORDER BY a.created_at DESC LIMIT $1"),
            &[&ADMIN_APPLICATIONS_LIST_LIMIT],
        )
        .await?
    } else {
        conn.query(
            &format!(
                "{APPLICATION_SELECT} WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT $2"
            ),
            &[&status, &ADMIN_APPLICATIONS_LIST_LIMIT],
        )
        .await?
    };
    let applications: Vec<Value> = rows.iter().map(map_application_row).collect();
    Ok((HTTP_OK, json!({ "applications": applications })))
}

pub async fn run_admin_application_approve(
    pool: &Pool,
    req: PartnersAdminIdActionRequest,
) -> Result<(u16, Value), PartnersError> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err(err(HTTP_BAD_REQUEST, "ID inválido."));
    }
    let admin_id = pg_user_id(req.admin_user_id)?;
    let now = now_ms();

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;

    let app_row = tx
        .query_opt(
            "SELECT id, user_id, channel_name, channel_url, avatar_url, description, status
               FROM partner_youtube_applications WHERE id = $1 LIMIT 1",
            &[&id],
        )
        .await?;
    let Some(app_row) = app_row else {
        return Err(err(
            HTTP_NOT_FOUND,
            "Candidatura não encontrada ou já processada.",
        ));
    };
    if string_cell(&app_row, "status") != "pending" {
        return Err(err(
            HTTP_NOT_FOUND,
            "Candidatura não encontrada ou já processada.",
        ));
    }

    let n = tx
        .execute(
            "UPDATE partner_youtube_applications
                SET status = 'approved', reviewed_at = $2, reviewed_by = $3, reject_reason = NULL
              WHERE id = $1 AND status = 'pending'",
            &[&id, &now, &admin_id],
        )
        .await?;
    if n == 0 {
        return Err(err(
            HTTP_NOT_FOUND,
            "Candidatura não encontrada ou já processada.",
        ));
    }

    let target_uid: i32 = app_row.get("user_id");
    let channel_name = string_cell(&app_row, "channel_name");
    let channel_url = string_cell(&app_row, "channel_url");
    let avatar_url = string_cell(&app_row, "avatar_url");
    let description = string_cell(&app_row, "description");

    tx.execute(
        "INSERT INTO partner_youtube_manual_allowlist (user_id, added_at, added_by)
         VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING",
        &[&target_uid, &now, &admin_id],
    )
    .await?;

    tx.execute(
        "INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
         VALUES ($1, 'partners', $2)
         ON CONFLICT (user_id, access_level_id) DO NOTHING",
        &[&target_uid, &now],
    )
    .await?;

    tx.execute(
        "INSERT INTO partner_youtube_creator_profiles
            (user_id, channel_name, channel_url, avatar_url, description, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
            channel_name = EXCLUDED.channel_name,
            channel_url  = EXCLUDED.channel_url,
            avatar_url   = EXCLUDED.avatar_url,
            description  = EXCLUDED.description,
            updated_at   = EXCLUDED.updated_at,
            updated_by   = EXCLUDED.updated_by",
        &[
            &target_uid,
            &channel_name,
            &channel_url,
            &avatar_url,
            &description,
            &now,
            &admin_id,
        ],
    )
    .await?;

    tx.execute(
        "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, room_id) DO NOTHING",
        &[
            &target_uid,
            &NFT_AUTO_ROOM_ID,
            &now,
            &PARTNER_NFT_ROOM_UNLOCKED_SLOTS,
        ],
    )
    .await?;

    tx.commit().await?;
    Ok((HTTP_OK, json!({ "ok": true, "userId": i64::from(target_uid) })))
}

pub async fn run_admin_application_reject(
    pool: &Pool,
    req: PartnersAdminIdActionRequest,
) -> Result<(u16, Value), PartnersError> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err(err(HTTP_BAD_REQUEST, "ID inválido."));
    }
    let admin_id = pg_user_id(req.admin_user_id)?;
    let reason: Option<String> = req
        .reason
        .map(|r| r.trim().chars().take(REJECT_REASON_MAX_LENGTH).collect::<String>())
        .filter(|r| !r.is_empty());
    let now = now_ms();
    let conn = pool.get().await?;
    let n = conn
        .execute(
            "UPDATE partner_youtube_applications
                SET status = 'rejected', reviewed_at = $2, reviewed_by = $3, reject_reason = $4
              WHERE id = $1 AND status = 'pending'",
            &[&id, &now, &admin_id, &reason],
        )
        .await?;
    if n == 0 {
        return Err(err(
            HTTP_NOT_FOUND,
            "Candidatura não encontrada ou já processada.",
        ));
    }
    Ok((HTTP_OK, json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

const SUBMISSION_SELECT: &str = r#"
    SELECT s.id, s.user_id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.status,
           s.created_at, s.reviewed_at, s.reviewed_by, s.reject_reason, u.username, u.email
      FROM partner_youtube_submissions s
      JOIN users u ON u.id = s.user_id
"#;

fn map_submission_row(r: &tokio_postgres::Row) -> Value {
    let reviewed = i64_cell(r, "reviewed_at");
    let reviewed_by = i64_cell(r, "reviewed_by");
    let reject = string_cell(r, "reject_reason");
    let mut obj = json!({
        "id": string_cell(r, "id"),
        "userId": i64_cell(r, "user_id"),
        "username": string_cell(r, "username"),
        "email": string_cell(r, "email"),
        "title": string_cell(r, "title"),
        "youtubeUrl": string_cell(r, "youtube_url"),
        "youtubeVideoId": string_cell(r, "youtube_video_id"),
        "description": string_cell(r, "description"),
        "status": string_cell(r, "status"),
        "createdAt": i64_cell(r, "created_at"),
        "reviewedBy": if reviewed_by > 0 { json!(reviewed_by) } else { Value::Null },
    });
    if reviewed > 0 {
        obj["reviewedAt"] = json!(reviewed);
    }
    if !reject.is_empty() {
        obj["rejectReason"] = json!(reject);
    }
    obj
}

pub async fn run_admin_submissions_list(
    pool: &Pool,
    req: PartnersAdminListRequest,
) -> Result<(u16, Value), PartnersError> {
    let status = normalize_list_status(req.status.as_deref(), true);
    let conn = pool.get().await?;
    let rows = if status == "all" {
        conn.query(
            &format!("{SUBMISSION_SELECT} ORDER BY s.created_at DESC LIMIT $1"),
            &[&ADMIN_SUBMISSIONS_LIST_LIMIT],
        )
        .await?
    } else {
        conn.query(
            &format!(
                "{SUBMISSION_SELECT} WHERE s.status = $1 ORDER BY s.created_at DESC LIMIT $2"
            ),
            &[&status, &ADMIN_SUBMISSIONS_LIST_LIMIT],
        )
        .await?
    };
    let submissions: Vec<Value> = rows.iter().map(map_submission_row).collect();
    Ok((HTTP_OK, json!({ "submissions": submissions })))
}

pub async fn run_admin_submission_reject(
    pool: &Pool,
    req: PartnersAdminIdActionRequest,
) -> Result<(u16, Value), PartnersError> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err(err(HTTP_BAD_REQUEST, "ID inválido."));
    }
    let admin_id = pg_user_id(req.admin_user_id)?;
    let reason: Option<String> = req
        .reason
        .map(|r| r.trim().chars().take(REJECT_REASON_MAX_LENGTH).collect::<String>())
        .filter(|r| !r.is_empty());
    let now = now_ms();
    let conn = pool.get().await?;
    let n = conn
        .execute(
            "UPDATE partner_youtube_submissions
                SET status = 'rejected', reviewed_at = $2, reviewed_by = $3, reject_reason = $4
              WHERE id = $1 AND status = 'pending'",
            &[&id, &now, &admin_id, &reason],
        )
        .await?;
    if n == 0 {
        return Err(err(HTTP_NOT_FOUND, "Envio não encontrado ou já processado."));
    }
    Ok((HTTP_OK, json!({ "ok": true })))
}

fn is_valid_submission_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= SUBMISSION_ID_MAX_LENGTH
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

pub async fn run_admin_submission_delete(
    pool: &Pool,
    req: PartnersAdminIdRequest,
) -> Result<(u16, Value), PartnersError> {
    let id = req.id.trim().to_string();
    if !is_valid_submission_id(&id) {
        return Err(err(HTTP_BAD_REQUEST, "ID inválido."));
    }
    let conn = pool.get().await?;
    let n = conn
        .execute(
            "DELETE FROM partner_youtube_submissions WHERE id = $1",
            &[&id],
        )
        .await?;
    if n == 0 {
        return Err(err(HTTP_NOT_FOUND, "Envio não encontrado."));
    }
    Ok((HTTP_OK, json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Manual allowlist
// ---------------------------------------------------------------------------

fn parse_opt_user_id(v: &Option<Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
    .filter(|n| *n >= 1)
}

pub async fn run_admin_allowlist_add(
    pool: &Pool,
    req: PartnersAdminAllowlistAddRequest,
) -> Result<(u16, Value), PartnersError> {
    let admin_id = pg_user_id(req.admin_user_id)?;
    let conn = pool.get().await?;

    let user_id: i64 = if let Some(uid) = parse_opt_user_id(&req.user_id) {
        let uid32 = pg_user_id(uid)?;
        let exists = conn
            .query_opt("SELECT 1 FROM users WHERE id = $1", &[&uid32])
            .await?
            .is_some();
        if !exists {
            return Err(err(HTTP_NOT_FOUND, "Utilizador não encontrado."));
        }
        uid
    } else {
        let raw = req.username.unwrap_or_default().trim().to_string();
        if raw.is_empty() {
            return Err(err(
                HTTP_BAD_REQUEST,
                "Indica userId ou texto (nome ou email).",
            ));
        }
        let rows = if raw.contains('@') {
            conn.query(
                "SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT $2",
                &[&raw, &USER_LOOKUP_MAX_RESULTS],
            )
            .await?
        } else {
            conn.query(
                "SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) LIMIT $2",
                &[&raw, &USER_LOOKUP_MAX_RESULTS],
            )
            .await?
        };
        if rows.is_empty() {
            return Err(err(HTTP_NOT_FOUND, "Utilizador não encontrado."));
        }
        if rows.len() > 1 {
            return Err(err(
                HTTP_BAD_REQUEST,
                "Vários resultados; escolhe na lista pelo ID ou refina a pesquisa.",
            ));
        }
        i64::from(rows[0].get::<_, i32>("id"))
    };

    let uid32 = pg_user_id(user_id)?;
    let now = now_ms();
    let n = conn
        .execute(
            "INSERT INTO partner_youtube_manual_allowlist (user_id, added_at, added_by)
             VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING",
            &[&uid32, &now, &admin_id],
        )
        .await?;
    Ok((
        HTTP_OK,
        json!({ "ok": true, "inserted": n > 0, "userId": user_id }),
    ))
}

pub async fn run_admin_allowlist_remove(
    pool: &Pool,
    req: PartnersAdminUserIdRequest,
) -> Result<(u16, Value), PartnersError> {
    if req.user_id < 1 {
        return Err(err(HTTP_BAD_REQUEST, "ID de utilizador inválido."));
    }
    let uid32 = pg_user_id(req.user_id)?;
    let conn = pool.get().await?;
    let n = conn
        .execute(
            "DELETE FROM partner_youtube_manual_allowlist WHERE user_id = $1",
            &[&uid32],
        )
        .await?;
    if n == 0 {
        return Err(err(
            HTTP_NOT_FOUND,
            "Este utilizador não está na lista manual.",
        ));
    }
    Ok((HTTP_OK, json!({ "ok": true, "userId": req.user_id })))
}

// ---------------------------------------------------------------------------
// Creator profile (admin get / put)
// ---------------------------------------------------------------------------

pub async fn run_admin_creator_get(
    pool: &Pool,
    req: PartnersAdminUserIdRequest,
) -> Result<(u16, Value), PartnersError> {
    if req.user_id < 1 {
        return Err(err(HTTP_BAD_REQUEST, "ID de utilizador inválido."));
    }
    let uid32 = pg_user_id(req.user_id)?;
    let conn = pool.get().await?;
    let row = conn
        .query_opt(
            "SELECT channel_url, avatar_url, channel_name, description
               FROM partner_youtube_creator_profiles WHERE user_id = $1",
            &[&uid32],
        )
        .await?;
    let (channel_url, avatar_url, channel_name, description) = match row {
        Some(r) => (
            string_cell(&r, "channel_url"),
            string_cell(&r, "avatar_url"),
            string_cell(&r, "channel_name"),
            string_cell(&r, "description"),
        ),
        None => (String::new(), String::new(), String::new(), String::new()),
    };
    Ok((
        HTTP_OK,
        json!({
            "channelUrl": channel_url,
            "avatarUrl": avatar_url,
            "channelName": channel_name,
            "description": description,
        }),
    ))
}

pub async fn run_admin_creator_put(
    pool: &Pool,
    req: PartnersAdminCreatorPutRequest,
) -> Result<(u16, Value), PartnersError> {
    if req.user_id < 1 {
        return Err(err(HTTP_BAD_REQUEST, "ID de utilizador inválido."));
    }
    let uid32 = pg_user_id(req.user_id)?;
    let admin_id = pg_user_id(req.admin_user_id)?;

    let raw_ch = value_str(&req.channel_url);
    let raw_av = value_str(&req.avatar_url);
    let channel_url = sanitize_channel_url(&raw_ch);
    let avatar_url = sanitize_avatar_url(&raw_av);
    let channel_name = req
        .channel_name
        .as_ref()
        .map(|_| sanitize_channel_name(&value_str(&req.channel_name)));
    let description = req
        .description
        .as_ref()
        .map(|_| sanitize_channel_description(&value_str(&req.description)));

    if !raw_ch.trim().is_empty() && channel_url.is_empty() {
        return Err(err(
            HTTP_BAD_REQUEST,
            "Link do canal inválido (use https:// no YouTube).",
        ));
    }
    if !raw_av.trim().is_empty() && avatar_url.is_empty() {
        return Err(err(
            HTTP_BAD_REQUEST,
            "URL da foto inválida (https:// ou caminho /...).",
        ));
    }
    let _ = CHANNEL_NAME_MIN_LENGTH;

    let now = now_ms();
    let conn = pool.get().await?;
    conn.execute(
        "INSERT INTO partner_youtube_creator_profiles
            (user_id, channel_name, channel_url, avatar_url, description, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
            channel_name = COALESCE($8::text, partner_youtube_creator_profiles.channel_name),
            channel_url  = EXCLUDED.channel_url,
            avatar_url   = EXCLUDED.avatar_url,
            description  = COALESCE($9::text, partner_youtube_creator_profiles.description),
            updated_at   = EXCLUDED.updated_at,
            updated_by   = EXCLUDED.updated_by",
        &[
            &uid32,
            &channel_name.clone().unwrap_or_default(),
            &channel_url,
            &avatar_url,
            &description.clone().unwrap_or_default(),
            &now,
            &admin_id,
            &channel_name,
            &description,
        ],
    )
    .await?;

    Ok((
        HTTP_OK,
        json!({ "ok": true, "channelUrl": channel_url, "avatarUrl": avatar_url }),
    ))
}

// ---------------------------------------------------------------------------
// Streamer-room users list
// ---------------------------------------------------------------------------

const STREAMER_ROOM_USERS_SQL: &str = r#"
    SELECT DISTINCT ON (u.id)
      u.id AS user_id,
      u.username,
      u.email,
      (SELECT MAX(pys.created_at) FROM partner_youtube_submissions pys
        WHERE pys.user_id = u.id AND pys.status = 'approved') AS last_approved_at,
      (SELECT COUNT(*) FROM partner_youtube_submissions pys
        WHERE pys.user_id = u.id AND pys.status = 'approved' AND pys.created_at >= $1) AS approved_last_60d
    FROM users u
    WHERE (
      EXISTS (SELECT 1 FROM user_rig_rooms urr WHERE urr.user_id = u.id AND urr.room_id = $2)
      OR EXISTS (
        SELECT 1 FROM placed_racks pr
         WHERE pr.user_id = u.id
           AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = $2
      )
    )
    ORDER BY u.id ASC
"#;

pub async fn run_admin_streamer_room_users(pool: &Pool) -> Result<(u16, Value), PartnersError> {
    let overdue_threshold = now_ms() - STREAMER_OVERDUE_DAYS * DAY_MS;
    let conn = pool.get().await?;
    let rows = conn
        .query(STREAMER_ROOM_USERS_SQL, &[&overdue_threshold, &STREAMER_ROOM_ID])
        .await?;
    let users: Vec<Value> = rows
        .iter()
        .map(|r| {
            let last = i64_cell(r, "last_approved_at");
            let approved_60d = i64_cell(r, "approved_last_60d");
            json!({
                "userId": i64_cell(r, "user_id"),
                "username": string_cell(r, "username"),
                "email": string_cell(r, "email"),
                "lastApprovedAt": if last > 0 { json!(last) } else { Value::Null },
                "approvedLast60d": approved_60d,
                "overdue": approved_60d == 0,
            })
        })
        .collect();
    Ok((HTTP_OK, json!({ "users": users })))
}

// ---------------------------------------------------------------------------
// Partners list (approved ∪ allowlist ∪ streamer-room occupants)
// ---------------------------------------------------------------------------

const PARTNERS_BASE_SQL: &str = r#"
    WITH partner_user_ids AS (
      SELECT DISTINCT user_id FROM partner_youtube_submissions WHERE status = 'approved'
      UNION
      SELECT user_id FROM partner_youtube_manual_allowlist
    )
    SELECT u.id AS user_id, u.username, u.email,
      (SELECT COUNT(*)::int FROM partner_youtube_submissions s
        WHERE s.user_id = u.id AND s.status = 'approved') AS approved_count,
      (SELECT COUNT(*)::int FROM partner_youtube_submissions s
        WHERE s.user_id = u.id AND s.status = 'approved'
          AND COALESCE(s.reviewed_at, s.created_at) >= $1) AS approved_last_365d,
      (SELECT MAX(COALESCE(s.reviewed_at, s.created_at))::bigint FROM partner_youtube_submissions s
        WHERE s.user_id = u.id AND s.status = 'approved') AS last_approved_at,
      COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
      COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url,
      EXISTS (SELECT 1 FROM partner_youtube_manual_allowlist m WHERE m.user_id = u.id) AS is_allowlisted
    FROM users u
    INNER JOIN partner_user_ids pu ON pu.user_id = u.id
    LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
    ORDER BY u.username ASC
"#;

const PARTNERS_EXTRA_SQL: &str = r#"
    SELECT u.id AS user_id, u.username, u.email,
      COALESCE(SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END), 0)::int AS approved_count,
      COALESCE(SUM(CASE WHEN s.status = 'approved'
        AND COALESCE(s.reviewed_at, s.created_at) >= $2::bigint THEN 1 ELSE 0 END), 0)::int AS approved_last_365d,
      MAX(CASE WHEN s.status = 'approved'
        THEN COALESCE(s.reviewed_at, s.created_at) ELSE NULL END)::bigint AS last_approved_at,
      COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
      COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url,
      EXISTS (SELECT 1 FROM partner_youtube_manual_allowlist m WHERE m.user_id = u.id) AS is_allowlisted
    FROM users u
    LEFT JOIN partner_youtube_submissions s ON s.user_id = u.id
    LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
    WHERE u.id = ANY($1::int[])
    GROUP BY u.id, u.username, u.email,
      COALESCE(NULLIF(BTRIM(p.channel_url), ''), ''),
      COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '')
    ORDER BY u.username ASC
"#;

/// `loadPartnerNftRoomUserIds` (no filter) — streamer-room occupants by rig room,
/// placed rack, or an `allowed_levels` match against the user's access levels.
const PARTNERS_NFT_ROOM_IDS_SQL: &str = r#"
    SELECT DISTINCT u.id AS user_id
      FROM users u
     WHERE EXISTS (
             SELECT 1 FROM user_rig_rooms urr
              WHERE urr.user_id = u.id AND urr.room_id = ANY($1::text[])
           )
        OR EXISTS (
             SELECT 1 FROM placed_racks pr
              WHERE pr.user_id = u.id
                AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = ANY($1::text[])
           )
        OR EXISTS (
             SELECT 1 FROM rig_rooms rr
              WHERE rr.id = ANY($1::text[])
                AND COALESCE(rr.is_active, 1) = 1
                AND (
                  COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]') = '[]'
                  OR EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(
                             COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]')::jsonb
                           ) AS room_lvl(level_id)
                     WHERE LOWER(BTRIM(room_lvl.level_id)) IN (
                       SELECT lvl.level_id FROM (
                         SELECT LOWER(BTRIM(u.access_level_id::text)) AS level_id
                          WHERE u.access_level_id IS NOT NULL
                            AND BTRIM(u.access_level_id::text) <> ''
                         UNION
                         SELECT LOWER(BTRIM(ual.access_level_id::text)) AS level_id
                           FROM user_access_levels ual
                          WHERE ual.user_id = u.id
                            AND ual.access_level_id IS NOT NULL
                            AND BTRIM(ual.access_level_id::text) <> ''
                       ) lvl
                     )
                  )
                )
           )
"#;

fn build_room_compliance(last_approved_at: i64, approved_last_365d: i64) -> Value {
    let last_ms = last_approved_at.max(0);
    let now = now_ms();
    let next_deadline = if last_ms > 0 {
        last_ms + PARTNER_VIDEO_WINDOW_MS
    } else {
        0
    };
    let overdue = last_ms == 0 || next_deadline < now;
    json!({
        "requiredApprovedPerYear": REQUIRED_APPROVED_PER_YEAR,
        "requiredIntervalDays": REQUIRED_INTERVAL_DAYS,
        "approvedLast365d": approved_last_365d.max(0),
        "lastApprovedAt": if last_ms > 0 { json!(last_ms) } else { Value::Null },
        "nextDeadlineAt": if next_deadline > 0 { json!(next_deadline) } else { Value::Null },
        "overdue": overdue,
        "compliant": !overdue,
    })
}

fn map_partner_row(r: &tokio_postgres::Row, nft_active: bool) -> Value {
    let last_approved = i64_cell(r, "last_approved_at");
    let approved_365 = i64_cell(r, "approved_last_365d");
    let mut compliance = build_room_compliance(last_approved, approved_365);
    let c_overdue = compliance["overdue"].as_bool().unwrap_or(false);
    let c_compliant = compliance["compliant"].as_bool().unwrap_or(true);
    if let Value::Object(ref mut m) = compliance {
        m.insert("active".into(), json!(nft_active));
        m.insert(
            "overdue".into(),
            json!(if nft_active { c_overdue } else { false }),
        );
        m.insert(
            "compliant".into(),
            json!(if nft_active { c_compliant } else { true }),
        );
    }
    json!({
        "nftRoom": compliance,
        "userId": i64_cell(r, "user_id"),
        "username": string_cell(r, "username"),
        "email": string_cell(r, "email"),
        "approvedCount": i64_cell(r, "approved_count"),
        "approvedLast365d": approved_365,
        "lastApprovedAt": if last_approved > 0 { json!(last_approved) } else { Value::Null },
        "channelUrl": string_cell(r, "partner_channel_url"),
        "avatarUrl": string_cell(r, "partner_avatar_url"),
        "allowlisted": r.try_get::<_, bool>("is_allowlisted").unwrap_or(false),
    })
}

pub async fn run_admin_partners_list(pool: &Pool) -> Result<(u16, Value), PartnersError> {
    let conn = pool.get().await?;
    let cutoff_365d = now_ms() - YEAR_365D_MS;

    let base_rows = conn.query(PARTNERS_BASE_SQL, &[&cutoff_365d]).await?;
    let base_ids: Vec<i32> = base_rows.iter().map(|r| r.get::<_, i32>("user_id")).collect();

    let room_ids = vec![STREAMER_ROOM_ID.to_string()];
    let nft_rows = conn.query(PARTNERS_NFT_ROOM_IDS_SQL, &[&room_ids]).await?;
    let nft_ids: Vec<i32> = nft_rows.iter().map(|r| r.get::<_, i32>("user_id")).collect();

    let missing_ids: Vec<i32> = nft_ids
        .iter()
        .copied()
        .filter(|id| !base_ids.contains(id))
        .collect();
    let extra_rows = if missing_ids.is_empty() {
        Vec::new()
    } else {
        conn.query(PARTNERS_EXTRA_SQL, &[&missing_ids, &cutoff_365d])
            .await?
    };

    let nft_active = |uid: i64| nft_ids.contains(&(uid as i32));

    let mut partners: Vec<Value> = base_rows
        .iter()
        .chain(extra_rows.iter())
        .map(|r| {
            let uid = i64_cell(r, "user_id");
            map_partner_row(r, nft_active(uid))
        })
        .collect();
    partners.sort_by(|a, b| {
        let ua = a["username"].as_str().unwrap_or("").to_lowercase();
        let ub = b["username"].as_str().unwrap_or("").to_lowercase();
        ua.cmp(&ub)
    });

    Ok((HTTP_OK, json!({ "partners": partners })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submission_id_validation() {
        assert!(is_valid_submission_id("abc-123_XYZ"));
        assert!(!is_valid_submission_id(""));
        assert!(!is_valid_submission_id("bad id"));
        assert!(!is_valid_submission_id(&"x".repeat(SUBMISSION_ID_MAX_LENGTH + 1)));
    }

    #[test]
    fn list_status_defaults() {
        assert_eq!(normalize_list_status(None, true), "all");
        assert_eq!(normalize_list_status(None, false), "pending");
        assert_eq!(normalize_list_status(Some("REJECTED"), false), "rejected");
        assert_eq!(normalize_list_status(Some("junk"), false), "pending");
    }

    #[test]
    fn compliance_overdue_when_no_history() {
        let c = build_room_compliance(0, 0);
        assert_eq!(c["overdue"], json!(true));
        assert_eq!(c["lastApprovedAt"], Value::Null);
    }

    #[test]
    fn paths_are_stable() {
        assert_eq!(
            PARTNERS_ADMIN_APPLICATION_APPROVE_PATH,
            "/v1/partners/admin/applications/approve"
        );
    }
}
