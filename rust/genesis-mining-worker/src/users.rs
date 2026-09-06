//! Node `requireActiveUser` — `users.is_blocked` gate (read-only).
//!
//! Mirrors `server/shared/auth/require-active-user.ts` (no `FOR UPDATE`).

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};

/// Node `BLOCKED_FLAG`.
const BLOCKED_FLAG: i32 = 1;
/// Node `HTTP_NOT_FOUND`.
const HTTP_NOT_FOUND: u16 = 404;
/// Node `HTTP_FORBIDDEN`.
const HTTP_FORBIDDEN: u16 = 403;
/// Node `HTTP_BAD_REQUEST`.
const HTTP_BAD_REQUEST: u16 = 400;
/// Internal worker failure.
const HTTP_INTERNAL: u16 = 500;

pub const USERS_ASSERT_ACTIVE_PATH: &str = "/v1/users/assert-active";

const ASSERT_ACTIVE_SQL: &str = "SELECT is_blocked FROM users WHERE id = $1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertActiveRequest {
    pub user_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertActiveResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug)]
pub struct AssertActiveError {
    pub http_status: u16,
    pub code: &'static str,
    pub message: String,
}

impl AssertActiveError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_BAD_REQUEST,
            code: "VALIDATION",
            message: message.into(),
        }
    }
    fn not_found() -> Self {
        Self {
            http_status: HTTP_NOT_FOUND,
            code: "NOT_FOUND",
            message: "User not found.".into(),
        }
    }
    fn forbidden() -> Self {
        Self {
            http_status: HTTP_FORBIDDEN,
            code: "FORBIDDEN",
            message: "Account blocked.".into(),
        }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            code: "INTERNAL",
            message: message.into(),
        }
    }
}

impl AssertActiveResponse {
    pub fn from_err(e: AssertActiveError) -> Self {
        Self {
            ok: false,
            error: Some(e.message),
            code: Some(e.code.to_string()),
        }
    }
}

fn pg_user_id(user_id: i64) -> Result<i32, AssertActiveError> {
    i32::try_from(user_id).map_err(|_| AssertActiveError::validation("Invalid userId."))
}

pub async fn run_assert_active_user(
    pool: &Pool,
    req: AssertActiveRequest,
) -> Result<AssertActiveResponse, AssertActiveError> {
    let uid = pg_user_id(req.user_id)?;
    let client = pool
        .get()
        .await
        .map_err(|e| AssertActiveError::internal(e.to_string()))?;
    let rows = client
        .query(ASSERT_ACTIVE_SQL, &[&uid])
        .await
        .map_err(|e| AssertActiveError::internal(e.to_string()))?;
    let Some(row) = rows.first() else {
        return Err(AssertActiveError::not_found());
    };
    let blocked: i32 = row.try_get("is_blocked").unwrap_or(0);
    if blocked == BLOCKED_FLAG {
        return Err(AssertActiveError::forbidden());
    }
    Ok(AssertActiveResponse {
        ok: true,
        error: None,
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matches_node_client() {
        assert_eq!(USERS_ASSERT_ACTIVE_PATH, "/v1/users/assert-active");
    }

    #[test]
    fn blocked_flag_matches_node() {
        assert_eq!(BLOCKED_FLAG, 1);
    }
}
