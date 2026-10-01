//! Admin impersonate / stop-impersonate — Node `impersonate.ts`.
//! Session flags via genesis-auth (`auth_session_load` / `update_flags`).

use deadpool_postgres::Pool;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::WorkerConfig;
use crate::gerente::auth_session::{
    auth_session_load, auth_session_update_flags, SESSION_MANAGER_MODE_OFF,
};
use crate::player_reads::{PlayerReadError, HTTP_SERVICE_UNAVAILABLE};

use super::{CODE_VALIDATION, EMAIL_MAX, HTTP_BAD_REQUEST};

pub const ADMIN_IMPERSONATE_START_PATH: &str = "/v1/admin/impersonate/start";
pub const ADMIN_IMPERSONATE_STOP_PATH: &str = "/v1/admin/impersonate/stop";

const HTTP_UNAUTHORIZED: u16 = 401;

const ERR_SESSION_REQUIRED: &str = "Sessão necessária para personificação";
const ERR_SESSION_INVALID: &str = "Sessão inválida";
const ERR_INVALID_TARGET: &str = "Invalid target";
const ERR_NOT_IMPERSONATING: &str = "Not impersonating";

const _: () = assert!(HTTP_UNAUTHORIZED == 401);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpersonateStartRequest {
    pub admin_user_id: i64,
    pub session_id: String,
    pub target_email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpersonateStopRequest {
    pub session_id: String,
}

pub async fn run_impersonate_start(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    req: &ImpersonateStartRequest,
) -> Result<Value, PlayerReadError> {
    let sid = req.session_id.trim();
    let admin_user_id = req.admin_user_id;
    if sid.is_empty() || admin_user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_SESSION_REQUIRED,
            CODE_VALIDATION,
        ));
    }

    load_session_or_throw(http, cfg, sid, ERR_SESSION_INVALID).await?;

    let email = req.target_email.trim();
    if email.is_empty() || email.len() > EMAIL_MAX {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_TARGET,
            CODE_VALIDATION,
        ));
    }

    let conn = pool.get().await?;
    let target = conn
        .query_opt(
            "SELECT id FROM users WHERE LOWER(BTRIM(email::text)) = LOWER($1) LIMIT 1",
            &[&email],
        )
        .await?;
    let Some(row) = target else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_TARGET,
            CODE_VALIDATION,
        ));
    };
    let target_id: i32 = row.get("id");
    let target_user_id = i64::from(target_id);
    if target_user_id == admin_user_id {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_TARGET,
            CODE_VALIDATION,
        ));
    }

    apply_session_flags(http, cfg, sid, target_user_id, Some(admin_user_id)).await?;

    Ok(json!({ "targetUserId": target_user_id }))
}

pub async fn run_impersonate_stop(
    http: &Client,
    cfg: &WorkerConfig,
    req: &ImpersonateStopRequest,
) -> Result<Value, PlayerReadError> {
    let sid = req.session_id.trim();
    if sid.is_empty() {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_NOT_IMPERSONATING,
            CODE_VALIDATION,
        ));
    }

    let loaded = match auth_session_load(http, cfg, sid).await {
        Ok(s) => s,
        Err(e) if e.http_status == HTTP_UNAUTHORIZED => {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_NOT_IMPERSONATING,
                CODE_VALIDATION,
            ));
        }
        Err(e) => return Err(e),
    };

    let original_uid = match loaded.original_user_id {
        Some(uid) if uid > 0 => uid,
        _ => {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_NOT_IMPERSONATING,
                CODE_VALIDATION,
            ));
        }
    };

    apply_session_flags(http, cfg, sid, original_uid, None).await?;

    Ok(json!({ "adminUserId": original_uid }))
}

async fn load_session_or_throw(
    http: &Client,
    cfg: &WorkerConfig,
    session_id: &str,
    missing: &str,
) -> Result<(), PlayerReadError> {
    match auth_session_load(http, cfg, session_id).await {
        Ok(_) => Ok(()),
        Err(e) if e.http_status == HTTP_UNAUTHORIZED => Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            missing,
            CODE_VALIDATION,
        )),
        Err(e) => Err(e),
    }
}

async fn apply_session_flags(
    http: &Client,
    cfg: &WorkerConfig,
    session_id: &str,
    user_id: i64,
    original_user_id: Option<i64>,
) -> Result<(), PlayerReadError> {
    let body = json!({
        "sessionId": session_id,
        "userId": user_id,
        "originalUserId": original_user_id,
        "managerMode": SESSION_MANAGER_MODE_OFF,
        "actingAsOwnerId": Value::Null,
    });
    match auth_session_update_flags(http, cfg, body).await {
        Ok(()) => Ok(()),
        Err(e) if e.http_status == HTTP_UNAUTHORIZED => Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_SESSION_INVALID,
            CODE_VALIDATION,
        )),
        Err(e) if e.http_status == HTTP_SERVICE_UNAVAILABLE => Err(e),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(ADMIN_IMPERSONATE_START_PATH, "/v1/admin/impersonate/start");
        assert_eq!(ADMIN_IMPERSONATE_STOP_PATH, "/v1/admin/impersonate/stop");
    }
}
