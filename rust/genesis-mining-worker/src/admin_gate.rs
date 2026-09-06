//! Admin gate twin — Node `loadAdminGateContext` (`users.is_admin` + super + perms).
//!
//! Mirrors `server/modules/auth/services/admin-guard.ts`: read-only load of the
//! three admin columns. Node returns `null` when the row is missing or
//! `is_admin` is falsy and the Express middleware answers 403; here the worker
//! reports `isAdmin: false` and genesis-api owns the 403.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::{pg_user_id, PlayerReadError};

pub const USERS_ADMIN_GATE_PATH: &str = "/v1/users/admin-gate";

const ADMIN_GATE_SQL: &str =
    "SELECT is_admin, is_super_admin, admin_permissions FROM users WHERE id = $1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminGateRequest {
    pub user_id: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdminGateContext {
    pub is_admin: bool,
    pub is_super_admin: bool,
    pub admin_permissions: Value,
}

impl AdminGateContext {
    /// Node `loadAdminGateContext` → `null` (middleware answers 403).
    pub fn denied() -> Self {
        Self {
            is_admin: false,
            is_super_admin: false,
            admin_permissions: Value::Null,
        }
    }

    pub fn payload(&self) -> Value {
        json!({
            "isAdmin": self.is_admin,
            "isSuperAdmin": self.is_super_admin,
            "adminPermissions": self.admin_permissions,
        })
    }
}

/// Node `row.admin_permissions ? JSON.parse(...) : null` with `catch → null`.
fn parse_admin_permissions(raw: Option<&str>) -> Value {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Value::Null;
    };
    serde_json::from_str(s).unwrap_or(Value::Null)
}

/// Node `resolveIsSuperAdminFromUserRow` / `!row.is_admin` — `0`/`NULL` is falsy.
fn truthy_db_int(v: Option<i32>) -> bool {
    v.unwrap_or(0) != 0
}

fn opt_i32_cell(row: &tokio_postgres::Row, col: &str) -> Option<i32> {
    if let Ok(v) = row.try_get::<_, Option<i32>>(col) {
        return v;
    }
    row.try_get::<_, i32>(col).ok()
}

pub async fn run_admin_gate(
    pool: &Pool,
    req: AdminGateRequest,
) -> Result<AdminGateContext, PlayerReadError> {
    let uid = pg_user_id(req.user_id)?;
    let conn = pool.get().await?;
    let Some(row) = conn.query_opt(ADMIN_GATE_SQL, &[&uid]).await? else {
        return Ok(AdminGateContext::denied());
    };
    if !truthy_db_int(opt_i32_cell(&row, "is_admin")) {
        return Ok(AdminGateContext::denied());
    }
    let raw_permissions: Option<String> = row.try_get("admin_permissions").unwrap_or(None);
    Ok(AdminGateContext {
        is_admin: true,
        is_super_admin: truthy_db_int(opt_i32_cell(&row, "is_super_admin")),
        admin_permissions: parse_admin_permissions(raw_permissions.as_deref()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matches_genesis_api_client() {
        assert_eq!(USERS_ADMIN_GATE_PATH, "/v1/users/admin-gate");
    }

    #[test]
    fn denied_payload_has_no_admin() {
        let payload = AdminGateContext::denied().payload();
        assert_eq!(payload["isAdmin"], false);
        assert_eq!(payload["isSuperAdmin"], false);
        assert_eq!(payload["adminPermissions"], Value::Null);
    }

    #[test]
    fn permissions_parse_like_node() {
        assert_eq!(parse_admin_permissions(None), Value::Null);
        assert_eq!(parse_admin_permissions(Some("")), Value::Null);
        assert_eq!(parse_admin_permissions(Some("   ")), Value::Null);
        assert_eq!(parse_admin_permissions(Some("not-json")), Value::Null);
        assert_eq!(
            parse_admin_permissions(Some(r#"["users","reports"]"#)),
            json!(["users", "reports"])
        );
        assert_eq!(
            parse_admin_permissions(Some(r#"{"users":true}"#)),
            json!({ "users": true })
        );
    }

    #[test]
    fn db_int_truthiness_matches_node() {
        assert!(!truthy_db_int(None));
        assert!(!truthy_db_int(Some(0)));
        assert!(truthy_db_int(Some(1)));
        assert!(truthy_db_int(Some(-1)));
    }

    #[test]
    fn admin_payload_keeps_camel_case_contract() {
        let ctx = AdminGateContext {
            is_admin: true,
            is_super_admin: true,
            admin_permissions: json!({ "reports": true }),
        };
        let payload = ctx.payload();
        assert_eq!(payload["isAdmin"], true);
        assert_eq!(payload["isSuperAdmin"], true);
        assert_eq!(payload["adminPermissions"]["reports"], true);
    }
}
