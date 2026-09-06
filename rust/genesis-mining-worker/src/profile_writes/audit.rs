//! `profile_audit_log` append + security-events list — Node `audit.ts`.

use deadpool_postgres::Pool;
use serde_json::{json, Map, Value};

use crate::player_reads::{i64_cell, now_ms, opt_string, pg_user_id, string_cell, PlayerReadError};

/// Node `META_MAX_CHARS`.
const META_MAX_CHARS: usize = 4000;
/// Node `META_STRING_FIELD_MAX_CHARS`.
const META_STRING_FIELD_MAX_CHARS: usize = 500;
/// Node `ACTION_MAX_CHARS`.
const ACTION_MAX_CHARS: usize = 120;
/// Node `ROUTE_MAX_CHARS`.
const ROUTE_MAX_CHARS: usize = 200;
/// Node `REQUEST_ID_MAX_CHARS`.
const REQUEST_ID_MAX_CHARS: usize = 64;
/// Node `SECURITY_EVENTS_MAX_LIMIT`.
const SECURITY_EVENTS_MAX_LIMIT: i64 = 100;
/// Node `SECURITY_EVENTS_DEFAULT_LIMIT`.
pub const SECURITY_EVENTS_DEFAULT_LIMIT: i64 = 50;

const _: () = assert!(META_MAX_CHARS == 4000);
const _: () = assert!(SECURITY_EVENTS_DEFAULT_LIMIT == 50);
const _: () = assert!(SECURITY_EVENTS_MAX_LIMIT == 100);

pub async fn append_profile_audit_log(
    pool: &Pool,
    user_id: Option<i32>,
    action: &str,
    route: Option<&str>,
    request_id: Option<&str>,
    meta: Option<&Map<String, Value>>,
) {
    let now = now_ms();
    let mut meta_str: Option<String> = None;
    if let Some(m) = meta {
        let mut safe = Map::new();
        for (k, v) in m {
            match v {
                Value::String(s) => {
                    let clipped: String = s.chars().take(META_STRING_FIELD_MAX_CHARS).collect();
                    safe.insert(k.clone(), Value::String(clipped));
                }
                Value::Number(_) | Value::Bool(_) | Value::Null => {
                    safe.insert(k.clone(), v.clone());
                }
                _ => {}
            }
        }
        let s = Value::Object(safe).to_string();
        meta_str = Some(s.chars().take(META_MAX_CHARS).collect());
    }
    let action_s: String = action.chars().take(ACTION_MAX_CHARS).collect();
    let route_s = route.map(|r| r.chars().take(ROUTE_MAX_CHARS).collect::<String>());
    let rid = request_id.map(|r| r.chars().take(REQUEST_ID_MAX_CHARS).collect::<String>());
    let Ok(conn) = pool.get().await else {
        tracing::warn!(event = "profile_audit_pool", "pool get failed");
        return;
    };
    if let Err(e) = conn
        .execute(
            "INSERT INTO profile_audit_log (user_id, action, route, request_id, meta, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[&user_id, &action_s, &route_s, &rid, &meta_str, &now],
        )
        .await
    {
        tracing::warn!(event = "profile_audit", err = %e, "insert failed");
    }
}

pub async fn list_profile_security_events(
    pool: &Pool,
    user_id: i64,
    limit: i64,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let take = limit.clamp(1, SECURITY_EVENTS_MAX_LIMIT);
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id::text AS id, action, route, request_id, created_at, meta
               FROM profile_audit_log
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2",
            &[&uid, &take],
        )
        .await?;
    let events: Vec<Value> = rows
        .iter()
        .map(|r| {
            let meta_raw = opt_string(r, "meta");
            let meta = meta_raw.and_then(|s| serde_json::from_str::<Value>(&s).ok());
            json!({
                "id": string_cell(r, "id"),
                "action": string_cell(r, "action"),
                "route": opt_string(r, "route"),
                "requestId": opt_string(r, "request_id"),
                "createdAt": i64_cell(r, "created_at"),
                "meta": meta
            })
        })
        .collect();
    Ok(json!({ "events": events }))
}
