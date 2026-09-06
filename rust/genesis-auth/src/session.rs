//! Legacy `sessions` row create / load / delete.

use deadpool_postgres::Pool;
use serde::Serialize;
use tokio_postgres::Row;

use crate::db::current_unix_ms;
use crate::errors::AuthPgError;
use crate::pg_types::pg_user_id;
use genesis_core::auth::constants::LAST_SEEN_UPDATE_INTERVAL_MS;

pub const SESSION_CREATE_PATH: &str = "/v1/auth/session/create";
pub const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
pub const SESSION_DELETE_PATH: &str = "/v1/auth/session/delete";
pub const SESSION_DELETE_BY_USER_PATH: &str = "/v1/auth/session/delete-by-user";
pub const SESSION_UPDATE_FLAGS_PATH: &str = "/v1/auth/session/update-flags";

/// Prisma `sessions.manager_mode` `@default(0)`.
pub const SESSION_MANAGER_MODE_OFF: i32 = 0;
/// Gerente enter / `manager.ts` sets `manager_mode = 1`.
pub const SESSION_MANAGER_MODE_ON: i32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUserBody {
    pub id: i64,
    pub username: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_admin: Option<i32>,
    pub is_super_admin: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon_wallet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_blocked: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_level_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referral_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referred_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranking_excluded: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_permissions: Option<String>,
    pub email_verification_required: i32,
    pub email_verified: i32,
    pub login_failure_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_locked_until_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct SessionLoadOk {
    pub user_id: i64,
    pub session_id: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub original_user_id: Option<i64>,
    pub last_seen_at_ms: Option<i64>,
    pub manager_mode: i32,
    pub acting_as_owner_id: Option<i64>,
    pub user: SessionUserBody,
}

#[derive(Debug, Clone)]
pub struct SessionDeleteOk {
    pub user_id: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct SessionDeleteByUserOk {
    pub deleted_count: i64,
}

#[derive(Debug, Clone)]
pub struct SessionFlagsOk {
    pub session_id: String,
    pub user_id: i64,
    pub original_user_id: Option<i64>,
    pub manager_mode: i32,
    pub acting_as_owner_id: Option<i64>,
}

fn user_from_row(row: &Row) -> SessionUserBody {
    let id: i32 = row.get("uid");
    SessionUserBody {
        id: i64::from(id),
        username: row.get("username"),
        email: row.get("email"),
        is_admin: row.get("is_admin"),
        is_super_admin: row.get("is_super_admin"),
        polygon_wallet: row.get("polygon_wallet"),
        is_blocked: row.get("is_blocked"),
        access_level_id: row.get("access_level_id"),
        referral_code: row.get("referral_code"),
        referred_by: row.get("referred_by"),
        last_active_at_ms: row.get("last_active_at"),
        ranking_excluded: row.get("ranking_excluded"),
        registration_ip: row.get("registration_ip"),
        admin_permissions: row.get("admin_permissions"),
        email_verification_required: row.get("email_verification_required"),
        email_verified: row.get("email_verified"),
        login_failure_count: row.get("login_failure_count"),
        login_locked_until_ms: row.get("login_locked_until"),
    }
}

fn opt_i32_as_i64(v: Option<i32>) -> Option<i64> {
    v.map(i64::from)
}

pub async fn run_session_create(
    pool: &Pool,
    user_id: i64,
    session_id: &str,
    expires_at_ms: i64,
) -> Result<(), AuthPgError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AuthPgError::bad("sessionId required"));
    }
    if expires_at_ms <= 0 {
        return Err(AuthPgError::bad("expiresAtMs required"));
    }
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let now = current_unix_ms();
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    client
        .execute(
            "INSERT INTO sessions (session_id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
            &[&sid, &uid, &now, &expires_at_ms],
        )
        .await
        .map_err(AuthPgError::transport)?;
    Ok(())
}

pub async fn run_session_load(
    pool: &Pool,
    session_id: &str,
    include_expired: bool,
) -> Result<SessionLoadOk, AuthPgError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AuthPgError::bad("sessionId required"));
    }
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    let row = client
        .query_opt(
            "SELECT s.session_id, s.user_id, s.created_at, s.expires_at,
                    s.original_user_id, s.last_seen_at, s.manager_mode, s.acting_as_owner_id,
                    u.id AS uid, u.username, u.email, u.is_admin, u.is_super_admin,
                    u.polygon_wallet, u.is_blocked, u.access_level_id, u.referral_code,
                    u.referred_by, u.last_active_at, u.ranking_excluded, u.registration_ip,
                    u.admin_permissions, u.email_verification_required, u.email_verified,
                    u.login_failure_count, u.login_locked_until
               FROM sessions s
               JOIN users u ON u.id = s.user_id
              WHERE s.session_id = $1",
            &[&sid],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let Some(row) = row else {
        return Err(AuthPgError::unauthorized("session not found"));
    };
    let now = current_unix_ms();
    let expires_at_ms: i64 = row.get("expires_at");
    if !include_expired && expires_at_ms < now {
        return Err(AuthPgError::unauthorized("session expired"));
    }
    let last_seen_at_ms: Option<i64> = row.get("last_seen_at");
    let last_seen = last_seen_at_ms.unwrap_or(0);
    let interval = i64::try_from(LAST_SEEN_UPDATE_INTERVAL_MS).unwrap_or(i64::MAX);
    if now.saturating_sub(last_seen) > interval {
        if let Err(e) = client
            .execute(
                "UPDATE sessions SET last_seen_at = $2 WHERE session_id = $1",
                &[&sid, &now],
            )
            .await
        {
            tracing::warn!(err = %e, "session last_seen update failed");
        }
    }
    let user_id: i32 = row.get("user_id");
    Ok(SessionLoadOk {
        user_id: i64::from(user_id),
        session_id: row.get("session_id"),
        created_at_ms: row.get("created_at"),
        expires_at_ms,
        original_user_id: opt_i32_as_i64(row.get("original_user_id")),
        last_seen_at_ms,
        manager_mode: row.get("manager_mode"),
        acting_as_owner_id: opt_i32_as_i64(row.get("acting_as_owner_id")),
        user: user_from_row(&row),
    })
}

pub async fn run_session_delete(
    pool: &Pool,
    session_id: &str,
) -> Result<SessionDeleteOk, AuthPgError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AuthPgError::bad("sessionId required"));
    }
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    let row = client
        .query_opt(
            "SELECT user_id FROM sessions WHERE session_id = $1",
            &[&sid],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let user_id = row.map(|r| {
        let uid: i32 = r.get("user_id");
        i64::from(uid)
    });
    client
        .execute("DELETE FROM sessions WHERE session_id = $1", &[&sid])
        .await
        .map_err(AuthPgError::transport)?;
    Ok(SessionDeleteOk { user_id })
}

fn require_manager_mode(mode: i32) -> Result<i32, AuthPgError> {
    if mode == SESSION_MANAGER_MODE_OFF || mode == SESSION_MANAGER_MODE_ON {
        return Ok(mode);
    }
    Err(AuthPgError::bad("invalid managerMode"))
}

/// Wipe sessions for one or more users, and clear `original_user_id` refs
/// (same as Node delete-user: `UPDATE … original_user_id = NULL` then `DELETE`).
pub async fn run_session_delete_by_user(
    pool: &Pool,
    user_ids: &[i64],
) -> Result<SessionDeleteByUserOk, AuthPgError> {
    if user_ids.is_empty() {
        return Err(AuthPgError::bad("userId or userIds required"));
    }
    let mut uids: Vec<i32> = Vec::with_capacity(user_ids.len());
    for uid in user_ids {
        uids.push(pg_user_id(*uid).map_err(AuthPgError::transport)?);
    }
    uids.sort_unstable();
    uids.dedup();
    let mut client = pool.get().await.map_err(AuthPgError::transport)?;
    let tx = client.transaction().await.map_err(AuthPgError::transport)?;
    tx.execute(
        "UPDATE sessions SET original_user_id = NULL WHERE original_user_id = ANY($1)",
        &[&uids],
    )
    .await
    .map_err(AuthPgError::transport)?;
    let deleted = tx
        .execute("DELETE FROM sessions WHERE user_id = ANY($1)", &[&uids])
        .await
        .map_err(AuthPgError::transport)?;
    tx.commit().await.map_err(AuthPgError::transport)?;
    let deleted_count = i64::try_from(deleted).map_err(AuthPgError::transport)?;
    Ok(SessionDeleteByUserOk { deleted_count })
}

/// Impersonate + gerente enter/leave — SET the same columns Node already writes.
pub async fn run_session_update_flags(
    pool: &Pool,
    session_id: &str,
    user_id: i64,
    original_user_id: Option<i64>,
    manager_mode: i32,
    acting_as_owner_id: Option<i64>,
) -> Result<SessionFlagsOk, AuthPgError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Err(AuthPgError::bad("sessionId required"));
    }
    let mode = require_manager_mode(manager_mode)?;
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let orig = match original_user_id {
        Some(v) => Some(pg_user_id(v).map_err(AuthPgError::transport)?),
        None => None,
    };
    let acting = match acting_as_owner_id {
        Some(v) => Some(pg_user_id(v).map_err(AuthPgError::transport)?),
        None => None,
    };
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    let row = client
        .query_opt(
            "UPDATE sessions
                SET user_id = $2,
                    original_user_id = $3,
                    manager_mode = $4,
                    acting_as_owner_id = $5
              WHERE session_id = $1
          RETURNING session_id, user_id, original_user_id, manager_mode, acting_as_owner_id",
            &[&sid, &uid, &orig, &mode, &acting],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let Some(row) = row else {
        return Err(AuthPgError::unauthorized("session not found"));
    };
    let out_uid: i32 = row.get("user_id");
    Ok(SessionFlagsOk {
        session_id: row.get("session_id"),
        user_id: i64::from(out_uid),
        original_user_id: opt_i32_as_i64(row.get("original_user_id")),
        manager_mode: row.get("manager_mode"),
        acting_as_owner_id: opt_i32_as_i64(row.get("acting_as_owner_id")),
    })
}

/// fireManager / resignManager — exact Node `UPDATE sessions SET user_id = original_user_id …`.
///
/// `match_original_user_id = None` → fire (`original_user_id IS NOT NULL` + `acting_as_owner_id`).
/// `Some` → resign (`original_user_id` + `acting_as_owner_id`).
pub async fn run_session_restore_from_original(
    pool: &Pool,
    match_acting_as_owner_id: i64,
    match_original_user_id: Option<i64>,
) -> Result<(), AuthPgError> {
    let owner = pg_user_id(match_acting_as_owner_id).map_err(AuthPgError::transport)?;
    let mode_off = SESSION_MANAGER_MODE_OFF;
    let mode_on = SESSION_MANAGER_MODE_ON;
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    if let Some(manager_uid) = match_original_user_id {
        let manager = pg_user_id(manager_uid).map_err(AuthPgError::transport)?;
        client
            .execute(
                "UPDATE sessions
                    SET user_id = original_user_id,
                        original_user_id = NULL,
                        manager_mode = $3,
                        acting_as_owner_id = NULL
                  WHERE manager_mode = $4
                    AND original_user_id = $1
                    AND acting_as_owner_id = $2",
                &[&manager, &owner, &mode_off, &mode_on],
            )
            .await
            .map_err(AuthPgError::transport)?;
    } else {
        client
            .execute(
                "UPDATE sessions
                    SET user_id = original_user_id,
                        original_user_id = NULL,
                        manager_mode = $2,
                        acting_as_owner_id = NULL
                  WHERE manager_mode = $3
                    AND acting_as_owner_id = $1
                    AND original_user_id IS NOT NULL",
                &[&owner, &mode_off, &mode_on],
            )
            .await
            .map_err(AuthPgError::transport)?;
    }
    Ok(())
}
