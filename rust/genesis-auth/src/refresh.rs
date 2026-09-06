//! Refresh-token persist (sha256 at rest) + atomic rotate (`SELECT … FOR UPDATE`).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use deadpool_postgres::Pool;
use genesis_core::auth::constants::REFRESH_TOKEN_RAW_BYTES;
use genesis_core::hash_token_sha256;
use genesis_core::time::MS_PER_SECOND;

use crate::config::WorkerConfig;
use crate::db::current_unix_ms;
use crate::errors::{AuthPgError, CODE_EXPIRED, CODE_INVALID};
use crate::pg_types::pg_user_id;

pub const REFRESH_ISSUE_PATH: &str = "/v1/auth/refresh/issue";
pub const REFRESH_ROTATE_PATH: &str = "/v1/auth/refresh/rotate";
pub const REFRESH_REVOKE_PATH: &str = "/v1/auth/refresh/revoke";

#[derive(Debug, Clone)]
pub struct RefreshIssueOk {
    pub refresh_token: String,
    pub expires_at_ms: i64,
    pub expires_in_sec: u64,
}

#[derive(Debug, Clone)]
pub struct RefreshRotateOk {
    pub user_id: i64,
    pub refresh_token: String,
    pub expires_in_sec: u64,
}

fn generate_refresh_raw() -> Result<String, AuthPgError> {
    let mut buf = vec![0u8; REFRESH_TOKEN_RAW_BYTES];
    getrandom::getrandom(&mut buf).map_err(AuthPgError::transport)?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn refresh_expires_at_ms(ttl_sec: u64) -> Result<(i64, u64), AuthPgError> {
    let now = current_unix_ms();
    let ttl_ms = i64::try_from(ttl_sec.saturating_mul(MS_PER_SECOND))
        .map_err(AuthPgError::transport)?;
    Ok((now.saturating_add(ttl_ms), ttl_sec))
}

pub async fn run_refresh_issue(
    pool: &Pool,
    cfg: &WorkerConfig,
    user_id: i64,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<RefreshIssueOk, AuthPgError> {
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let raw = generate_refresh_raw()?;
    let token_hash = hash_token_sha256(&raw);
    let family_id = uuid::Uuid::new_v4().to_string();
    let (expires_at_ms, expires_in_sec) = refresh_expires_at_ms(cfg.refresh_ttl_sec)?;
    let now = current_unix_ms();
    let ua = user_agent.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let ip_s = ip.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    client
        .execute(
            "INSERT INTO jwt_refresh_tokens
                (user_id, token_hash, family_id, expires_at, created_at, user_agent, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &uid,
                &token_hash,
                &family_id,
                &expires_at_ms,
                &now,
                &ua,
                &ip_s,
            ],
        )
        .await
        .map_err(AuthPgError::transport)?;
    Ok(RefreshIssueOk {
        refresh_token: raw,
        expires_at_ms,
        expires_in_sec,
    })
}

pub async fn run_refresh_rotate(
    pool: &Pool,
    cfg: &WorkerConfig,
    refresh_token: &str,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<RefreshRotateOk, AuthPgError> {
    let raw_old = refresh_token.trim();
    if raw_old.is_empty() {
        return Err(AuthPgError::unauthorized_code(
            "refresh token required",
            CODE_INVALID,
        ));
    }
    let old_hash = hash_token_sha256(raw_old);
    let new_raw = generate_refresh_raw()?;
    let new_hash = hash_token_sha256(&new_raw);
    let (expires_at_ms, expires_in_sec) = refresh_expires_at_ms(cfg.refresh_ttl_sec)?;
    let now = current_unix_ms();
    let ua = user_agent.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let ip_s = ip.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });

    let mut client = pool.get().await.map_err(AuthPgError::transport)?;
    let tx = client.transaction().await.map_err(AuthPgError::transport)?;
    let row = tx
        .query_opt(
            "SELECT id, user_id, family_id, expires_at
               FROM jwt_refresh_tokens
              WHERE token_hash = $1 AND revoked_at IS NULL
              FOR UPDATE
              LIMIT 1",
            &[&old_hash],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let Some(row) = row else {
        let _ = tx.rollback().await;
        return Err(AuthPgError::unauthorized_code(
            "invalid or revoked refresh token",
            CODE_INVALID,
        ));
    };
    let expires_at: i64 = row.get("expires_at");
    if expires_at < now {
        let _ = tx.rollback().await;
        return Err(AuthPgError::unauthorized_code(
            "refresh token expired",
            CODE_EXPIRED,
        ));
    }
    let id: i64 = row.get("id");
    let user_id: i32 = row.get("user_id");
    let family_id: String = row.get("family_id");
    tx.execute("DELETE FROM jwt_refresh_tokens WHERE id = $1", &[&id])
        .await
        .map_err(AuthPgError::transport)?;
    tx.execute(
        "INSERT INTO jwt_refresh_tokens
            (user_id, token_hash, family_id, expires_at, created_at, user_agent, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[
            &user_id,
            &new_hash,
            &family_id,
            &expires_at_ms,
            &now,
            &ua,
            &ip_s,
        ],
    )
    .await
    .map_err(AuthPgError::transport)?;
    tx.commit().await.map_err(AuthPgError::transport)?;
    Ok(RefreshRotateOk {
        user_id: i64::from(user_id),
        refresh_token: new_raw,
        expires_in_sec,
    })
}

pub async fn run_refresh_revoke(pool: &Pool, user_id: i64) -> Result<(), AuthPgError> {
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let now = current_unix_ms();
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    client
        .execute(
            "UPDATE jwt_refresh_tokens SET revoked_at = $2
              WHERE user_id = $1 AND revoked_at IS NULL",
            &[&uid, &now],
        )
        .await
        .map_err(AuthPgError::transport)?;
    Ok(())
}
