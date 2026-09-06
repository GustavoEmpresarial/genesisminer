//! POST password/change — Node `password.ts` + genesis-auth hash/verify/revoke.

use deadpool_postgres::Pool;
use genesis_core::{validate_login_password, validate_password_strength_policy};
use reqwest::Client;
use serde_json::{json, Map, Value};

use super::audit::append_profile_audit_log;
use super::auth_client::{auth_hash_password, auth_revoke_refresh, auth_verify_password};
use super::clamp_request_id;
use crate::config::WorkerConfig;
use crate::player_reads::{opt_string, pg_user_id, PlayerReadError, HTTP_UNPROCESSABLE};

const HTTP_BAD_REQUEST: u16 = 400;

const _: () = assert!(HTTP_UNPROCESSABLE == 422);

pub async fn run_change_password(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
    current_password: Option<&str>,
    new_password: Option<&str>,
    confirm_password: Option<&str>,
    request_id: Option<&str>,
    route: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rid = clamp_request_id(request_id);
    let route_s = route.unwrap_or("/api/profile/password/change");

    let cur_pv = validate_login_password(current_password);
    if !cur_pv.ok {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            cur_pv.error.unwrap_or_else(|| "Invalid password.".into()),
            "VALIDATION",
        ));
    }
    let cur = current_password.unwrap_or("");

    let (Some(np_raw), Some(cp_raw)) = (new_password, confirm_password) else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Invalid payload.",
            "VALIDATION",
        ));
    };
    if np_raw != cp_raw {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Confirmation does not match the new password.",
            "VALIDATION",
        ));
    }

    let conn = pool.get().await?;
    let row = conn
        .query_opt("SELECT password FROM users WHERE id = $1", &[&uid])
        .await?;
    let hash = row
        .as_ref()
        .and_then(|r| opt_string(r, "password"))
        .filter(|s| !s.is_empty());
    let Some(hash) = hash else {
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Account has no password set; use the recovery flow.",
            "PASSWORD_NOT_SET",
        ));
    };

    let ok_cur = auth_verify_password(http, cfg, cur, &hash).await?;
    if !ok_cur {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_password_change_wrong_current",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Current password incorrect.",
            "PASSWORD_CURRENT_WRONG",
        ));
    }

    let strength = validate_password_strength_policy(np_raw);
    if !strength.ok {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_password_weak_rejected",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            strength
                .error
                .unwrap_or_else(|| "Password too weak.".into()),
            "PASSWORD_WEAK",
        ));
    }
    // Same-as-current rejection (Node validateProfileNewPasswordStrength).
    if auth_verify_password(http, cfg, np_raw, &hash).await? {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_password_weak_rejected",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "The new password cannot be the same as the current one.",
            "PASSWORD_WEAK",
        ));
    }

    let new_hash = auth_hash_password(http, cfg, np_raw).await?;
    conn.execute(
        "UPDATE users SET password = $1 WHERE id = $2",
        &[&new_hash, &uid],
    )
    .await?;

    auth_revoke_refresh(http, cfg, user_id).await?;

    append_profile_audit_log(
        pool,
        Some(uid),
        "profile_password_changed",
        Some(route_s),
        rid.as_deref(),
        Some(&Map::new()),
    )
    .await;

    Ok(json!({
        "message": "Password updated. On devices with an old session you may need to sign in again."
    }))
}
