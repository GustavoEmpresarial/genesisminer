//! Access-level → referral-model assignments.
//!
//! Public twins: `GET/POST /api/admin/access-level-referral-assignments`.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::player_reads::{i32_cell, string_cell, PlayerReadError};

pub const ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH: &str =
    "/v1/admin/users/access-level-referral-assignments/list";
pub const ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH: &str =
    "/v1/admin/users/access-level-referral-assignments/save";

const LIST_SQL: &str = "SELECT access_level_id, referral_model_id
  FROM access_level_referral_models
 WHERE referral_model_id IS NOT NULL";

const UPSERT_SQL: &str = "INSERT INTO access_level_referral_models
   (access_level_id, referral_model_id)
 VALUES ($1, $2)
 ON CONFLICT (access_level_id) DO UPDATE SET
   referral_model_id = EXCLUDED.referral_model_id";

const DELETE_SQL: &str =
    "DELETE FROM access_level_referral_models WHERE access_level_id = $1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessLevelReferralSaveRequest {
    #[serde(default)]
    pub assignments: Value,
}

/// Build `Record<access_level_id, referral_model_id>` skipping nulls.
pub fn map_assignment_rows(rows: &[tokio_postgres::Row]) -> Map<String, Value> {
    let mut out = Map::new();
    for r in rows {
        let level_id = string_cell(r, "access_level_id");
        if level_id.is_empty() {
            continue;
        }
        let model_id = i32_cell(r, "referral_model_id");
        if model_id <= 0 {
            continue;
        }
        out.insert(level_id, json!(model_id));
    }
    out
}

pub async fn run_access_level_referral_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn.query(LIST_SQL, &[]).await?;
    Ok(json!({ "assignments": Value::Object(map_assignment_rows(&rows)) }))
}

/// Parse one assignment value — number or null. Invalid → skip.
fn parse_assignment_value(v: &Value) -> Option<Option<i32>> {
    match v {
        Value::Null => Some(None),
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !f.is_finite() || f <= 0.0 {
                return Some(None);
            }
            let id = f.floor() as i64;
            Some(i32::try_from(id).ok().filter(|i| *i > 0))
        }
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Some(None);
            }
            let f: f64 = t.parse().ok()?;
            if !f.is_finite() || f <= 0.0 {
                return Some(None);
            }
            let id = f.floor() as i64;
            Some(i32::try_from(id).ok().filter(|i| *i > 0))
        }
        _ => None,
    }
}

pub async fn run_access_level_referral_save(
    pool: &Pool,
    req: &AccessLevelReferralSaveRequest,
) -> Result<Value, PlayerReadError> {
    let Some(obj) = req.assignments.as_object() else {
        return Ok(json!({}));
    };
    let conn = pool.get().await?;
    for (level_id, raw) in obj {
        let level_id = level_id.trim();
        if level_id.is_empty() {
            continue;
        }
        let Some(parsed) = parse_assignment_value(raw) else {
            continue;
        };
        match parsed {
            Some(model_id) => {
                conn.execute(UPSERT_SQL, &[&level_id, &model_id]).await?;
            }
            None => {
                conn.execute(DELETE_SQL, &[&level_id]).await?;
            }
        }
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH,
            "/v1/admin/users/access-level-referral-assignments/list"
        );
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH,
            "/v1/admin/users/access-level-referral-assignments/save"
        );
    }

    #[test]
    fn parse_assignment_value_cases() {
        assert_eq!(parse_assignment_value(&Value::Null), Some(None));
        assert_eq!(parse_assignment_value(&json!(5)), Some(Some(5)));
        assert_eq!(parse_assignment_value(&json!("9")), Some(Some(9)));
        assert_eq!(parse_assignment_value(&json!(0)), Some(None));
        assert_eq!(parse_assignment_value(&json!("")), Some(None));
        assert_eq!(parse_assignment_value(&json!(true)), None);
    }
}
