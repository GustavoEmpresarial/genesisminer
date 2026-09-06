//! HTTP fixed-window rate limits — Node `express-rate-limit` on profile /
//! partners / partner-games facades. Redis `INCR` + `PEXPIRE` when `REDIS_URL`
//! is set; fail-open when unset or Redis errors (local/dev).

use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde_json::json;
use tracing::warn;

use crate::config::AppState;
use crate::session::json_status;
use axum::response::Response;
use genesis_core::time::{MINUTES_PER_HOUR, MS_PER_MINUTE};

/// Node `RATE_LIMIT_WINDOW_MINUTES` in `profile.controller.ts`.
pub const PROFILE_RATE_LIMIT_WINDOW_MINUTES: u64 = 15;
/// Node `RATE_LIMIT_WINDOW_MS`.
pub const PROFILE_RATE_LIMIT_WINDOW_MS: u64 = PROFILE_RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE;
/// Node `IDENTITY_LIMIT_MAX`.
pub const PROFILE_IDENTITY_LIMIT_MAX: u64 = 40;
/// Node `PASSWORD_LIMIT_MAX`.
pub const PROFILE_PASSWORD_LIMIT_MAX: u64 = 12;
/// Node key scope `profile_identity`.
pub const SCOPE_PROFILE_IDENTITY: &str = "profile_identity";
/// Node key scope `profile_password`.
pub const SCOPE_PROFILE_PASSWORD: &str = "profile_password";

/// Node `SUBMIT_RATE_LIMIT_MAX` in `partners.controller.ts`.
pub const PARTNERS_SUBMIT_RATE_LIMIT_MAX: u64 = 12;
/// Node `PARTNERS_ME_RATE_LIMIT_MAX`.
pub const PARTNERS_ME_RATE_LIMIT_MAX: u64 = 60;
/// Node `APPLY_RATE_LIMIT_MAX`.
pub const PARTNERS_APPLY_RATE_LIMIT_MAX: u64 = 5;
/// Node `APPLY_RATE_LIMIT_WINDOW_MS` (`MINUTES_PER_HOUR * MS_PER_MINUTE`).
pub const PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS: u64 = MINUTES_PER_HOUR * MS_PER_MINUTE;
/// Node submit/me window (`MS_PER_MINUTE`).
pub const PARTNERS_MINUTE_WINDOW_MS: u64 = MS_PER_MINUTE;

/// Node `RATE_LIMIT_MAX` in `partner-games.controller.ts`.
pub const PARTNER_GAMES_RATE_LIMIT_MAX: u64 = 60;
/// Node partner-games window (`MS_PER_MINUTE`).
pub const PARTNER_GAMES_WINDOW_MS: u64 = MS_PER_MINUTE;

const HTTP_TOO_MANY_REQUESTS: u16 = 429;
const RATE_LIMIT_CODE: &str = "RATE_LIMIT";

const _: () = assert!(PROFILE_RATE_LIMIT_WINDOW_MINUTES == 15);
const _: () = assert!(PROFILE_IDENTITY_LIMIT_MAX == 40);
const _: () = assert!(PROFILE_PASSWORD_LIMIT_MAX == 12);
const _: () = assert!(PARTNERS_SUBMIT_RATE_LIMIT_MAX == 12);
const _: () = assert!(PARTNERS_ME_RATE_LIMIT_MAX == 60);
const _: () = assert!(PARTNERS_APPLY_RATE_LIMIT_MAX == 5);
const _: () = assert!(PARTNER_GAMES_RATE_LIMIT_MAX == 60);
const _: () = assert!(PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS == MINUTES_PER_HOUR * MS_PER_MINUTE);

/// Node profile key: `ip:scope:userId`.
pub fn profile_rate_key(ip: &str, scope: &str, user_id: i64) -> String {
    format!("{ip}:{scope}:{user_id}")
}

/// Node partners / partner-games key: `scope:userId|ip`.
pub fn scoped_actor_key(scope: &str, user_id: Option<i64>, ip: &str) -> String {
    match user_id {
        Some(uid) => format!("{scope}:{uid}"),
        None => format!("{scope}:{ip}"),
    }
}

/// Fixed-window counter. `Ok(true)` = allowed; `Ok(false)` = limited.
/// No Redis → allow. Redis error → allow (warn).
pub async fn fixed_window_allow(
    redis: Option<&ConnectionManager>,
    key: &str,
    max: u64,
    window_ms: u64,
) -> bool {
    let Some(manager) = redis else {
        return true;
    };
    let mut conn = manager.clone();
    let count: u64 = match conn.incr(key, 1u64).await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, key, "rate-limit INCR failed — fail-open");
            return true;
        }
    };
    if count == 1 {
        if let Err(e) = redis::cmd("PEXPIRE")
            .arg(key)
            .arg(window_ms)
            .query_async::<()>(&mut conn)
            .await
        {
            warn!(err = %e, key, "rate-limit PEXPIRE failed");
        }
    }
    count <= max
}

/// Returns `Some(429)` when limited; `None` when the request may proceed.
pub async fn enforce(
    state: &AppState,
    key: &str,
    max: u64,
    window_ms: u64,
    error_message: &str,
) -> Option<Response> {
    let allowed = fixed_window_allow(state.redis.as_ref(), key, max, window_ms).await;
    if allowed {
        return None;
    }
    Some(json_status(
        HTTP_TOO_MANY_REQUESTS,
        json!({ "error": error_message, "code": RATE_LIMIT_CODE }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consts_match_node_profile() {
        assert_eq!(PROFILE_RATE_LIMIT_WINDOW_MINUTES, 15);
        assert_eq!(
            PROFILE_RATE_LIMIT_WINDOW_MS,
            PROFILE_RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE
        );
        assert_eq!(PROFILE_IDENTITY_LIMIT_MAX, 40);
        assert_eq!(PROFILE_PASSWORD_LIMIT_MAX, 12);
        assert_eq!(SCOPE_PROFILE_IDENTITY, "profile_identity");
        assert_eq!(SCOPE_PROFILE_PASSWORD, "profile_password");
    }

    #[test]
    fn consts_match_node_partners() {
        assert_eq!(PARTNERS_SUBMIT_RATE_LIMIT_MAX, 12);
        assert_eq!(PARTNERS_ME_RATE_LIMIT_MAX, 60);
        assert_eq!(PARTNERS_APPLY_RATE_LIMIT_MAX, 5);
        assert_eq!(
            PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS,
            MINUTES_PER_HOUR * MS_PER_MINUTE
        );
        assert_eq!(PARTNERS_MINUTE_WINDOW_MS, MS_PER_MINUTE);
    }

    #[test]
    fn consts_match_node_partner_games() {
        assert_eq!(PARTNER_GAMES_RATE_LIMIT_MAX, 60);
        assert_eq!(PARTNER_GAMES_WINDOW_MS, MS_PER_MINUTE);
    }

    #[test]
    fn profile_key_matches_node_pattern() {
        assert_eq!(
            profile_rate_key("1.2.3.4", SCOPE_PROFILE_IDENTITY, 99),
            "1.2.3.4:profile_identity:99"
        );
        assert_eq!(
            profile_rate_key("1.2.3.4", SCOPE_PROFILE_PASSWORD, 7),
            "1.2.3.4:profile_password:7"
        );
    }

    #[test]
    fn scoped_actor_key_matches_node_partners() {
        assert_eq!(
            scoped_actor_key("partners-submit", Some(42), "9.9.9.9"),
            "partners-submit:42"
        );
        assert_eq!(
            scoped_actor_key("partners-apply", None, "9.9.9.9"),
            "partners-apply:9.9.9.9"
        );
        assert_eq!(
            scoped_actor_key("partner-games", Some(1), "ip"),
            "partner-games:1"
        );
    }

    #[tokio::test]
    async fn no_redis_fail_open() {
        assert!(fixed_window_allow(None, "k", 1, MS_PER_MINUTE).await);
    }
}
