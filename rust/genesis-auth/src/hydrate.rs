//! Public session/login profile — Node `session.controller.ts` 103–126 + login JSON.

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};
use tokio_postgres::Row;

use crate::errors::AuthPgError;
use crate::pg_types::pg_user_id;
use crate::session::{
    run_session_load, SessionLoadOk, SESSION_MANAGER_MODE_ON,
};
use genesis_core::get_email_verification_flags;

pub const SESSION_HYDRATE_PATH: &str = "/v1/auth/session/hydrate";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHydrateRequest {
    #[serde(default)]
    pub user_id: Option<serde_json::Value>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionFlagState {
    pub is_impersonating: bool,
    pub is_managing_account: bool,
    pub manager_mode: bool,
    pub manager_user_id: Option<i64>,
    pub acting_as_owner_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub id: String,
    pub username: String,
    pub email: String,
    pub is_admin: bool,
    pub is_super_admin: bool,
    pub admin_permissions: serde_json::Value,
    pub is_blocked: bool,
    pub polygon_wallet: Option<String>,
    pub access_level_id: Option<String>,
    pub access_level_ids: Vec<String>,
    pub referral_code: Option<String>,
    pub referred_by: Option<String>,
    pub email_verified: bool,
    pub email_verification_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_impersonating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_managing_account: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acting_as_owner_id: Option<i64>,
    pub account_manager_enabled: bool,
    pub merge_enabled: bool,
}

pub fn parse_admin_permissions(raw: Option<&str>) -> serde_json::Value {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return serde_json::Value::Null;
    };
    serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
}

fn truthy_db_int(v: Option<i32>) -> bool {
    v.unwrap_or(0) != 0
}

fn session_flags_from_load(loaded: &SessionLoadOk) -> SessionFlagState {
    if loaded.manager_mode == SESSION_MANAGER_MODE_ON {
        SessionFlagState {
            is_impersonating: false,
            is_managing_account: true,
            manager_mode: true,
            manager_user_id: loaded.original_user_id,
            acting_as_owner_id: loaded.acting_as_owner_id,
        }
    } else if loaded.original_user_id.is_some() {
        SessionFlagState {
            is_impersonating: true,
            ..SessionFlagState::default()
        }
    } else {
        SessionFlagState::default()
    }
}

pub fn assemble_public_profile(
    user_id: i64,
    username: &str,
    email: &str,
    is_admin: Option<i32>,
    is_super_admin: i32,
    admin_permissions: Option<&str>,
    is_blocked: Option<i32>,
    polygon_wallet: Option<String>,
    access_level_id: Option<String>,
    access_level_ids: Vec<String>,
    referral_code: Option<String>,
    referred_by: Option<String>,
    email_verified: i32,
    email_verification_required: i32,
    flags: SessionFlagState,
    include_session_flags: bool,
    account_manager_enabled: bool,
    merge_enabled: bool,
) -> PublicProfile {
    let ev = get_email_verification_flags(i64::from(email_verified), i64::from(email_verification_required));
    PublicProfile {
        id: user_id.to_string(),
        username: username.to_string(),
        email: email.to_string(),
        is_admin: truthy_db_int(is_admin),
        is_super_admin: is_super_admin != 0,
        admin_permissions: parse_admin_permissions(admin_permissions),
        is_blocked: truthy_db_int(is_blocked),
        polygon_wallet,
        access_level_id,
        access_level_ids,
        referral_code,
        referred_by,
        email_verified: ev.email_verified,
        email_verification_required: ev.email_verification_required,
        is_impersonating: include_session_flags.then_some(flags.is_impersonating),
        is_managing_account: include_session_flags.then_some(flags.is_managing_account),
        manager_mode: include_session_flags.then_some(flags.manager_mode),
        manager_user_id: if include_session_flags {
            flags.manager_user_id
        } else {
            None
        },
        acting_as_owner_id: if include_session_flags {
            flags.acting_as_owner_id
        } else {
            None
        },
        account_manager_enabled,
        merge_enabled,
    }
}

fn user_id_i64(raw: &serde_json::Value) -> Result<i64, AuthPgError> {
    match raw {
        serde_json::Value::Number(n) => {
            let i = n.as_i64().ok_or_else(|| AuthPgError::bad("invalid userId"))?;
            if i <= 0 {
                return Err(AuthPgError::bad("invalid userId"));
            }
            Ok(i)
        }
        serde_json::Value::String(s) => {
            let i = s
                .trim()
                .parse::<i64>()
                .map_err(|_| AuthPgError::bad("invalid userId"))?;
            if i <= 0 {
                return Err(AuthPgError::bad("invalid userId"));
            }
            Ok(i)
        }
        _ => Err(AuthPgError::bad("invalid userId")),
    }
}

fn flag_on(v: Option<i32>) -> bool {
    match v {
        None => true,
        Some(n) => n != 0,
    }
}

pub async fn resolve_merge_enabled(pool: &Pool) -> bool {
    let Ok(client) = pool.get().await else {
        return true;
    };
    let row = client
        .query_opt(
            "SELECT enabled, enabled_machine, enabled_multiplier, enabled_infrastructure
               FROM merge_settings WHERE id = 1",
            &[],
        )
        .await;
    match row {
        Ok(Some(r)) => {
            let enabled: Option<i32> = r.get(0);
            let machine: Option<i32> = r.get(1);
            let multiplier: Option<i32> = r.get(2);
            let infra: Option<i32> = r.get(3);
            flag_on(enabled)
                && (flag_on(machine) || flag_on(multiplier) || flag_on(infra))
        }
        _ => true,
    }
}

pub async fn list_access_level_ids(
    pool: &Pool,
    user_id: i64,
    primary: Option<&str>,
) -> Result<Vec<String>, AuthPgError> {
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    let rows = client
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let mut ids: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    if let Some(p) = primary {
        if !p.is_empty() && !ids.iter().any(|x| x == p) {
            ids.push(p.to_string());
        }
    }
    Ok(ids)
}

fn profile_from_session_user(
    user: &crate::session::SessionUserBody,
    access_level_ids: Vec<String>,
    flags: SessionFlagState,
    include_session_flags: bool,
    account_manager_enabled: bool,
    merge_enabled: bool,
) -> PublicProfile {
    assemble_public_profile(
        user.id,
        &user.username,
        &user.email,
        user.is_admin,
        user.is_super_admin,
        user.admin_permissions.as_deref(),
        user.is_blocked,
        user.polygon_wallet.clone(),
        user.access_level_id.clone(),
        access_level_ids,
        user.referral_code.clone(),
        user.referred_by.clone(),
        user.email_verified,
        user.email_verification_required,
        flags,
        include_session_flags,
        account_manager_enabled,
        merge_enabled,
    )
}

fn user_from_users_row(row: &Row) -> crate::session::SessionUserBody {
    let id: i32 = row.get("id");
    crate::session::SessionUserBody {
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

pub async fn load_user_by_id(
    pool: &Pool,
    user_id: i64,
) -> Result<crate::session::SessionUserBody, AuthPgError> {
    let uid = pg_user_id(user_id).map_err(AuthPgError::transport)?;
    let client = pool.get().await.map_err(AuthPgError::transport)?;
    let row = client
        .query_opt(
            "SELECT id, username, email, is_admin, is_super_admin,
                    polygon_wallet, is_blocked, access_level_id, referral_code,
                    referred_by, last_active_at, ranking_excluded, registration_ip,
                    admin_permissions, email_verification_required, email_verified,
                    login_failure_count, login_locked_until
               FROM users WHERE id = $1",
            &[&uid],
        )
        .await
        .map_err(AuthPgError::transport)?;
    let Some(row) = row else {
        return Err(AuthPgError::unauthorized_code(
            "Invalid session or account no longer exists. Please sign in again.",
            "USER_NOT_FOUND",
        ));
    };
    Ok(user_from_users_row(&row))
}

pub async fn run_session_hydrate(
    pool: &Pool,
    account_manager_enabled: bool,
    user_id: Option<i64>,
    session_id: Option<&str>,
) -> Result<PublicProfile, AuthPgError> {
    let sid = session_id.map(str::trim).filter(|s| !s.is_empty());
    let (user, flags, include_session_flags) = if let Some(sid) = sid {
        match run_session_load(pool, sid, false).await {
            Ok(loaded) => {
                if let Some(uid) = user_id {
                    if uid != loaded.user_id {
                        return Err(AuthPgError::unauthorized_code(
                            "Invalid session.",
                            "USER_NOT_FOUND",
                        ));
                    }
                }
                let flags = session_flags_from_load(&loaded);
                (loaded.user, flags, true)
            }
            Err(e) => {
                if user_id.is_some() {
                    let uid = user_id.unwrap();
                    let user = load_user_by_id(pool, uid).await?;
                    (user, SessionFlagState::default(), true)
                } else {
                    return Err(e);
                }
            }
        }
    } else if let Some(uid) = user_id {
        let user = load_user_by_id(pool, uid).await?;
        (user, SessionFlagState::default(), true)
    } else {
        return Err(AuthPgError::bad("userId or sessionId required"));
    };

    let access_level_ids =
        list_access_level_ids(pool, user.id, user.access_level_id.as_deref()).await?;
    let merge_enabled = resolve_merge_enabled(pool).await;
    Ok(profile_from_session_user(
        &user,
        access_level_ids,
        flags,
        include_session_flags,
        account_manager_enabled,
        merge_enabled,
    ))
}

pub fn parse_hydrate_ids(body: &SessionHydrateRequest) -> Result<(Option<i64>, Option<String>), AuthPgError> {
    let user_id = match body.user_id.as_ref() {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(user_id_i64(v)?),
    };
    let session_id = body
        .session_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if user_id.is_none() && session_id.is_none() {
        return Err(AuthPgError::bad("userId or sessionId required"));
    }
    Ok((user_id, session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_admin_permissions_null_and_json() {
        assert_eq!(parse_admin_permissions(None), serde_json::Value::Null);
        assert_eq!(parse_admin_permissions(Some("")), serde_json::Value::Null);
        assert_eq!(parse_admin_permissions(Some("not-json")), serde_json::Value::Null);
        let v = parse_admin_permissions(Some(r#"{"users":true}"#));
        assert_eq!(v["users"], true);
    }

    #[test]
    fn assemble_login_profile_omits_session_flags() {
        let p = assemble_public_profile(
            7,
            "alice",
            "a@b.com",
            Some(1),
            0,
            Some(r#"{"x":1}"#),
            Some(0),
            None,
            Some("lvl1".into()),
            vec!["lvl1".into()],
            Some("ref".into()),
            None,
            1,
            0,
            SessionFlagState::default(),
            false,
            false,
            true,
        );
        assert_eq!(p.id, "7");
        assert!(p.is_admin);
        assert!(!p.is_super_admin);
        assert!(p.email_verified);
        assert!(!p.email_verification_required);
        assert!(p.is_impersonating.is_none());
        assert!(p.merge_enabled);
        assert!(!p.account_manager_enabled);
        assert_eq!(p.admin_permissions["x"], 1);
    }

    #[test]
    fn assemble_session_profile_includes_manager_flags() {
        let p = assemble_public_profile(
            3,
            "bob",
            "b@c.com",
            Some(0),
            1,
            None,
            Some(0),
            None,
            None,
            vec![],
            None,
            None,
            1,
            0,
            SessionFlagState {
                is_impersonating: false,
                is_managing_account: true,
                manager_mode: true,
                manager_user_id: Some(9),
                acting_as_owner_id: Some(3),
            },
            true,
            true,
            true,
        );
        assert_eq!(p.is_impersonating, Some(false));
        assert_eq!(p.is_managing_account, Some(true));
        assert_eq!(p.manager_mode, Some(true));
        assert_eq!(p.manager_user_id, Some(9));
        assert_eq!(p.acting_as_owner_id, Some(3));
        assert!(p.is_super_admin);
    }

    #[test]
    fn hydrate_ids_require_one() {
        let err = parse_hydrate_ids(&SessionHydrateRequest {
            user_id: None,
            session_id: None,
        })
        .unwrap_err();
        assert!(matches!(err, AuthPgError::BadRequest(_)));
    }

    #[test]
    fn hydrate_ids_accept_user() {
        let (uid, sid) = parse_hydrate_ids(&SessionHydrateRequest {
            user_id: Some(serde_json::json!(12)),
            session_id: None,
        })
        .unwrap();
        assert_eq!(uid, Some(12));
        assert!(sid.is_none());
    }
}
