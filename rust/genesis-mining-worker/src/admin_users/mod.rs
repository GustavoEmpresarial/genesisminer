//! Admin "Usuários" tab twins — Node `server/modules/admin/users/services/`.
//!
//! Covers the four leftover routes that live outside the `/api/admin` prefix:
//! `GET /api/users` ([`list`]), `PUT /api/users/block`, `PUT /api/user`
//! ([`update`]) and `DELETE /api/user/:email` ([`delete`]), plus admin profile
//! leftovers: save-game override finalize, owned rooms, wallet history,
//! impersonate, and user-activity. genesis-api owns the `isAdmin` gate and the
//! HTTP shape; this module owns the SQL / session flags.

pub mod access_level_referral;
pub mod delete;
pub mod dormant_mining;
pub mod grant_premium_checkin;
pub mod impersonate;
pub mod list;
pub mod owned_rooms;
pub mod referral_models;
pub mod save_game_override;
pub mod update;
pub mod user_activity;
pub mod wallet_history;

use serde::Deserialize;
use serde_json::Value;

use crate::player_reads::PlayerReadError;

pub const ADMIN_USERS_LIST_PATH: &str = "/v1/users/admin-list";
pub const ADMIN_USERS_BLOCK_PATH: &str = "/v1/users/admin-block";
pub const ADMIN_USERS_UPDATE_PATH: &str = "/v1/users/admin-update";
pub const ADMIN_USERS_DELETE_RESOLVE_PATH: &str = "/v1/users/admin-delete/resolve";
pub const ADMIN_USERS_DELETE_PATH: &str = "/v1/users/admin-delete";
pub use access_level_referral::{
    ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH, ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH,
};
pub use dormant_mining::ADMIN_DORMANT_MINING_PATH;
pub use grant_premium_checkin::ADMIN_GRANT_PREMIUM_CHECKIN_PATH;
pub use impersonate::{ADMIN_IMPERSONATE_START_PATH, ADMIN_IMPERSONATE_STOP_PATH};
pub use owned_rooms::{ADMIN_OWNED_ROOMS_FINALIZE_PATH, ADMIN_OWNED_ROOMS_PREPARE_PATH};
pub use referral_models::{
    ADMIN_REFERRAL_MODELS_DELETE_PATH, ADMIN_REFERRAL_MODELS_LIST_PATH,
    ADMIN_REFERRAL_MODELS_UPSERT_PATH,
};
pub use save_game_override::ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH;
pub use user_activity::ADMIN_USER_ACTIVITY_PATH;
pub use wallet_history::ADMIN_WALLET_HISTORY_PATH;

/// Node `EMAIL_MAX` (users.controller.ts / delete.ts).
pub const EMAIL_MAX: usize = 254;
/// Node `BLOCKED_FLAG`.
pub const BLOCKED_FLAG: i32 = 1;
const UNBLOCKED_FLAG: i32 = 0;
/// Node `HTTP_*` constants used by the users services.
pub const HTTP_BAD_REQUEST: u16 = 400;
pub const HTTP_FORBIDDEN: u16 = 403;
pub const HTTP_NOT_FOUND: u16 = 404;
pub const HTTP_CONFLICT: u16 = 409;

pub const CODE_VALIDATION: &str = "VALIDATION";
pub const CODE_NOT_FOUND: &str = "NOT_FOUND";
pub const CODE_FORBIDDEN: &str = "FORBIDDEN";
pub const CODE_CONFLICT: &str = "CONFLICT";

const _: () = assert!(EMAIL_MAX == 254);
const _: () = assert!(BLOCKED_FLAG == 1);
const _: () = assert!(HTTP_BAD_REQUEST == 400);
const _: () = assert!(HTTP_FORBIDDEN == 403);
const _: () = assert!(HTTP_NOT_FOUND == 404);
const _: () = assert!(HTTP_CONFLICT == 409);

/// `GET /api/users` — Express `req.query` forwarded verbatim.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUsersListRequest {
    #[serde(default)]
    pub query: Value,
}

/// `PUT /api/users/block`. genesis-api validates the email like the Node
/// controller does; the worker only needs the normalized value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUsersBlockRequest {
    pub email: String,
    #[serde(default)]
    pub blocked: bool,
}

/// Actor half of `PUT /api/user` and `DELETE /api/user/:email` — Node reads it
/// from `req.userId` / `req.isSuperAdmin` after the `isAdmin` middleware.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminActor {
    pub actor_user_id: i64,
    #[serde(default)]
    pub actor_is_super_admin: bool,
}

/// Node `db.query('UPDATE users ...')` behind `prisma.users.updateMany` with
/// `mode: 'insensitive'`. Prisma renders that as `ILIKE`, whose wildcards would
/// leak into the match, so compare lowercased instead.
const BLOCK_SQL: &str =
    "UPDATE users SET is_blocked = $1 WHERE LOWER(BTRIM(email::text)) = LOWER($2)";

pub async fn run_admin_block_user(
    pool: &deadpool_postgres::Pool,
    req: &AdminUsersBlockRequest,
) -> Result<Value, PlayerReadError> {
    let flag = if req.blocked {
        BLOCKED_FLAG
    } else {
        UNBLOCKED_FLAG
    };
    let email = req.email.trim();
    let conn = pool.get().await?;
    conn.execute(BLOCK_SQL, &[&flag, &email]).await?;
    Ok(Value::Object(serde_json::Map::new()))
}

/// Node `parseAdminUserPathEmail` — the panel sends the address percent-encoded
/// in the path; genesis-api decodes it, the worker re-validates the bounds.
pub fn parse_admin_user_email(raw: &str) -> Result<String, PlayerReadError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > EMAIL_MAX {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Email inválido.",
            CODE_VALIDATION,
        ));
    }
    Ok(trimmed.to_string())
}

/// Node `truthyFlag` — `Number(v)` non-zero. `0`/`NULL` are falsy.
pub fn truthy_flag(v: Option<i32>) -> bool {
    v.unwrap_or(0) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_are_stable() {
        assert_eq!(ADMIN_USERS_LIST_PATH, "/v1/users/admin-list");
        assert_eq!(ADMIN_USERS_BLOCK_PATH, "/v1/users/admin-block");
        assert_eq!(ADMIN_USERS_UPDATE_PATH, "/v1/users/admin-update");
        assert_eq!(
            ADMIN_USERS_DELETE_RESOLVE_PATH,
            "/v1/users/admin-delete/resolve"
        );
        assert_eq!(ADMIN_USERS_DELETE_PATH, "/v1/users/admin-delete");
        assert_eq!(
            ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH,
            "/v1/admin/users/save-game-override-finalize"
        );
        assert_eq!(
            ADMIN_OWNED_ROOMS_PREPARE_PATH,
            "/v1/admin/users/owned-rooms-prepare"
        );
        assert_eq!(
            ADMIN_OWNED_ROOMS_FINALIZE_PATH,
            "/v1/admin/users/owned-rooms-finalize"
        );
        assert_eq!(ADMIN_WALLET_HISTORY_PATH, "/v1/admin/users/wallet-history");
        assert_eq!(
            ADMIN_GRANT_PREMIUM_CHECKIN_PATH,
            "/v1/admin/users/grant-premium-checkin"
        );
        assert_eq!(ADMIN_IMPERSONATE_START_PATH, "/v1/admin/impersonate/start");
        assert_eq!(ADMIN_IMPERSONATE_STOP_PATH, "/v1/admin/impersonate/stop");
        assert_eq!(ADMIN_USER_ACTIVITY_PATH, "/v1/admin/user-activity");
        assert_eq!(
            ADMIN_REFERRAL_MODELS_LIST_PATH,
            "/v1/admin/users/referral-models/list"
        );
        assert_eq!(
            ADMIN_REFERRAL_MODELS_UPSERT_PATH,
            "/v1/admin/users/referral-models/upsert"
        );
        assert_eq!(
            ADMIN_REFERRAL_MODELS_DELETE_PATH,
            "/v1/admin/users/referral-models/delete"
        );
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH,
            "/v1/admin/users/access-level-referral-assignments/list"
        );
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH,
            "/v1/admin/users/access-level-referral-assignments/save"
        );
        assert_eq!(
            ADMIN_DORMANT_MINING_PATH,
            "/v1/admin/users/accounts-dormant-mining"
        );
    }

    #[test]
    fn block_sql_never_uses_ilike_wildcards() {
        assert!(BLOCK_SQL.contains("LOWER(BTRIM(email::text)) = LOWER($2)"));
        assert!(!BLOCK_SQL.to_ascii_lowercase().contains("ilike"));
    }

    #[test]
    fn email_bounds_match_node() {
        assert_eq!(parse_admin_user_email("  a@b.c  ").unwrap(), "a@b.c");
        assert!(parse_admin_user_email("   ").is_err());
        let long = format!("{}@b.c", "x".repeat(EMAIL_MAX));
        assert!(parse_admin_user_email(&long).is_err());
    }

    #[test]
    fn email_error_matches_node_body() {
        let e = parse_admin_user_email("").unwrap_err();
        assert_eq!(e.http_status, HTTP_BAD_REQUEST);
        assert_eq!(e.code.as_deref(), Some(CODE_VALIDATION));
    }

    #[test]
    fn truthy_flag_matches_node() {
        assert!(!truthy_flag(None));
        assert!(!truthy_flag(Some(0)));
        assert!(truthy_flag(Some(1)));
        assert!(truthy_flag(Some(-1)));
    }
}
