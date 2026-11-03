//! Site kill-switch — `settings.site_maintenance` (`1` / `0`).
//!
//! Public probe + admin persist for `GET /api/site-status` and
//! `POST /api/admin/site-maintenance`.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

/// Settings row matching the public admin API name.
pub const SETTING_KEY: &str = "site_maintenance";
/// Stored when maintenance is on — same convention as `admin_security` bools.
pub const SETTING_ON: &str = "1";
/// Stored when maintenance is off.
pub const SETTING_OFF: &str = "0";

pub const SITE_STATUS_PATH: &str = "/v1/site-status";
pub const SITE_MAINTENANCE_SET_PATH: &str = "/v1/site-maintenance";

const SELECT_SQL: &str = "SELECT value FROM settings WHERE key = $1";
const UPSERT_SQL: &str = "INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

/// Node `HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid payload.' })`.
const ERR_INVALID_PAYLOAD: &str = "Invalid payload.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMaintenanceSetRequest {
    pub maintenance: bool,
}

pub fn parse_bool_setting(v: Option<&str>) -> bool {
    matches!(
        v.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn setting_value(on: bool) -> &'static str {
    if on {
        SETTING_ON
    } else {
        SETTING_OFF
    }
}

pub async fn run_site_status(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let row = c.query_opt(SELECT_SQL, &[&SETTING_KEY]).await?;
    let raw = row.and_then(|r| r.try_get::<_, Option<String>>("value").ok().flatten());
    Ok(json!({ "maintenance": parse_bool_setting(raw.as_deref()) }))
}

pub async fn run_site_maintenance_set(
    pool: &Pool,
    body: &SiteMaintenanceSetRequest,
) -> Result<Value, PlayerReadError> {
    let value = setting_value(body.maintenance);
    let c = pool.get().await?;
    c.execute(UPSERT_SQL, &[&SETTING_KEY, &value]).await?;
    Ok(json!({ "maintenance": body.maintenance }))
}

/// Reject a JSON body that is not `{ maintenance: bool }`.
pub fn parse_set_request(body: &Value) -> Result<SiteMaintenanceSetRequest, PlayerReadError> {
    serde_json::from_value(body.clone()).map_err(|_| PlayerReadError::bad(ERR_INVALID_PAYLOAD))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match_genesis_api() {
        assert_eq!(SITE_STATUS_PATH, "/v1/site-status");
        assert_eq!(SITE_MAINTENANCE_SET_PATH, "/v1/site-maintenance");
        assert_eq!(SETTING_KEY, "site_maintenance");
    }

    #[test]
    fn parse_bool_setting_accepts_known_truthy() {
        assert!(parse_bool_setting(Some("1")));
        assert!(parse_bool_setting(Some("true")));
        assert!(parse_bool_setting(Some("YES")));
        assert!(parse_bool_setting(Some(" On ")));
        assert!(!parse_bool_setting(Some("0")));
        assert!(!parse_bool_setting(Some("false")));
        assert!(!parse_bool_setting(Some("")));
        assert!(!parse_bool_setting(None));
    }

    #[test]
    fn setting_value_is_one_or_zero() {
        assert_eq!(setting_value(true), SETTING_ON);
        assert_eq!(setting_value(false), SETTING_OFF);
    }

    #[test]
    fn parse_set_request_requires_bool() {
        assert!(parse_set_request(&json!({ "maintenance": true })).is_ok());
        assert!(parse_set_request(&json!({ "maintenance": false })).is_ok());
        assert!(parse_set_request(&json!({})).is_err());
        assert!(parse_set_request(&json!({ "maintenance": "1" })).is_err());
    }
}
