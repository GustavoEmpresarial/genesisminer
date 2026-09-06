//! PATCH identity — Node `identity.ts`.

use deadpool_postgres::Pool;
use genesis_core::{
    is_reserved_profile_username, strip_invisible_username_chars, validate_signup_username,
};
use serde_json::{json, Map, Value};

use super::audit::append_profile_audit_log;
use super::clamp_request_id;
use crate::player_reads::{opt_string, pg_user_id, PlayerReadError, HTTP_UNPROCESSABLE};

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_CONFLICT: u16 = 409;
/// Node `AUDIT_USERNAME_SNIPPET_MAX_CHARS`.
const AUDIT_USERNAME_SNIPPET_MAX_CHARS: usize = 80;

const _: () = assert!(HTTP_UNPROCESSABLE == 422);
const _: () = assert!(AUDIT_USERNAME_SNIPPET_MAX_CHARS == 80);

pub async fn run_patch_identity(
    pool: &Pool,
    user_id: i64,
    display_username: Option<&str>,
    request_id: Option<&str>,
    route: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rid = clamp_request_id(request_id);
    let route_s = route.unwrap_or("/api/profile/identity");
    let raw = strip_invisible_username_chars(display_username.unwrap_or(""));
    let vu = validate_signup_username(Some(&raw));
    if !vu.ok {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_username_invalid",
            Some(route_s),
            rid.as_deref(),
            Some(&meta_reason("validation")),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            vu.error.unwrap_or_else(|| "Invalid username.".into()),
            "VALIDATION",
        ));
    }
    let next = vu.username.unwrap_or_default();
    if is_reserved_profile_username(&next) {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_username_reserved",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "This username is reserved or not allowed.",
            "USERNAME_RESERVED",
        ));
    }

    let conn = pool.get().await?;
    let clash = conn
        .query_opt(
            "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1",
            &[&next, &uid],
        )
        .await?;
    if clash.is_some() {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_username_conflict",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "This username is already taken.",
            "USERNAME_TAKEN",
        ));
    }

    let before = conn
        .query_opt("SELECT username FROM users WHERE id = $1", &[&uid])
        .await?;
    let prev = before
        .as_ref()
        .and_then(|r| opt_string(r, "username"))
        .unwrap_or_default();

    let updated = conn
        .execute(
            "UPDATE users SET username = $1
              WHERE id = $2
                AND NOT EXISTS (
                  SELECT 1 FROM users u2
                   WHERE LOWER(u2.username) = LOWER($1) AND u2.id <> $2
                )",
            &[&next, &uid],
        )
        .await?;
    if updated == 0 {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_username_conflict",
            Some(route_s),
            rid.as_deref(),
            Some(&meta_reason("race")),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "This username is already taken.",
            "USERNAME_TAKEN",
        ));
    }

    let mut meta = Map::new();
    meta.insert(
        "from".into(),
        Value::String(
            prev.chars()
                .take(AUDIT_USERNAME_SNIPPET_MAX_CHARS)
                .collect(),
        ),
    );
    meta.insert(
        "to".into(),
        Value::String(
            next.chars()
                .take(AUDIT_USERNAME_SNIPPET_MAX_CHARS)
                .collect(),
        ),
    );
    append_profile_audit_log(
        pool,
        Some(uid),
        "profile_username_changed",
        Some(route_s),
        rid.as_deref(),
        Some(&meta),
    )
    .await;

    Ok(json!({ "username": next }))
}

fn meta_reason(reason: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("reason".into(), Value::String(reason.into()));
    m
}
