//! Admin: conceder check-in premium de N dias (unlock + activar janela agora).

use deadpool_postgres::Pool;
use genesis_core::checkin::{
    utc_day_from_ms, DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS, DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

use super::{CODE_NOT_FOUND, CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_NOT_FOUND};

pub const ADMIN_GRANT_PREMIUM_CHECKIN_PATH: &str = "/v1/admin/users/grant-premium-checkin";

const UNLOCKED_FLAG: i32 = 1;
const ERR_INVALID_USER: &str = "Invalid user id.";
const ERR_USER_NOT_FOUND: &str = "User not found.";
const ERR_NO_GAME_STATE: &str = "User has no game state.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPremiumCheckinRequest {
    pub user_id: i64,
    /// Epoch ms; se omitido, worker usa now.
    #[serde(default)]
    pub now_ms: Option<i64>,
}

pub async fn run_grant_premium_checkin(
    pool: &Pool,
    req: &GrantPremiumCheckinRequest,
) -> Result<Value, PlayerReadError> {
    if req.user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_USER,
            CODE_VALIDATION,
        ));
    }
    let uid = crate::player_reads::pg_user_id(req.user_id)?;
    let now_ms = req
        .now_ms
        .filter(|n| *n > 0)
        .unwrap_or_else(|| chrono_now_ms());
    let day = utc_day_from_ms(now_ms);

    let conn = pool.get().await?;

    let exists = conn
        .query_opt("SELECT 1 FROM users WHERE id = $1", &[&uid])
        .await?;
    if exists.is_none() {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    }

    let interval_days = load_interval_days(&conn).await?;

    let updated = conn
        .execute(
            r#"UPDATE game_states
               SET checkin_premium_unlocked = $2,
                   last_checkin_at_ms = $3,
                   last_checkin_day = $4
               WHERE user_id = $1"#,
            &[&uid, &UNLOCKED_FLAG, &now_ms, &day],
        )
        .await?;
    if updated == 0 {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_NO_GAME_STATE,
            CODE_NOT_FOUND,
        ));
    }

    Ok(json!({
        "ok": true,
        "unlocked": true,
        "lastCheckinAtMs": now_ms,
        "lastCheckinDay": day,
        "intervalDays": interval_days,
        "minUsdc": DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
    }))
}

async fn load_interval_days(
    conn: &deadpool_postgres::Object,
) -> Result<i32, PlayerReadError> {
    let row = conn
        .query_opt(
            "SELECT value FROM settings WHERE key = 'checkin_premium_interval_days'",
            &[],
        )
        .await?;
    let Some(r) = row else {
        return Ok(DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS);
    };
    let raw: String = r.try_get("value").unwrap_or_default();
    let parsed = raw.parse::<i32>().unwrap_or(DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS);
    Ok(if parsed >= 1 {
        parsed
    } else {
        DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS
    })
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_constant() {
        assert_eq!(
            ADMIN_GRANT_PREMIUM_CHECKIN_PATH,
            "/v1/admin/users/grant-premium-checkin"
        );
    }
}
