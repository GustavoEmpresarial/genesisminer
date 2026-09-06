//! `POST /api/news`, `DELETE /api/news/:id`, `POST /api/news-fee` and
//! `POST /api/news-expire-days` twins — Node `catalog/services/news.ts`.
//!
//! The `id` / `text` presence check stays in genesis-api (Node keeps it in the
//! controller, with its own 400 body); everything below is the service half.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::player_reads::PlayerReadError;

use super::js;

/// Node `getSettingValue`/`upsertSettingsEntries` keys in news.ts.
const SETTING_NEWS_FEE: &str = "news_post_fee_usdc";
const SETTING_NEWS_EXPIRE: &str = "news_post_expire_days";

/// Node `author_name: input.authorName ?? 'Admin'`.
const DEFAULT_AUTHOR_NAME: &str = "Admin";
/// Node `active: 1` on create (an update never touches it).
const NEWS_ACTIVE_ON_CREATE: i32 = 1;

const KV_UPSERT_SQL: &str = "INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

const NEWS_UPSERT_SQL: &str = "INSERT INTO system_news
       (id, text, link, active, duration, author_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       text = EXCLUDED.text,
       link = EXCLUDED.link,
       duration = EXCLUDED.duration,
       author_name = EXCLUDED.author_name";

const NEWS_DELETE_SQL: &str = "DELETE FROM system_news WHERE id = $1";

/// Node `upsertSystemNews` input, already coerced to column types.
#[derive(Debug, Clone, PartialEq)]
pub struct NewsUpsertRow {
    pub id: String,
    pub text: String,
    pub link: Option<String>,
    pub duration: Option<i32>,
    pub author_name: String,
}

/// Node destructures `req.body` and passes `id.trim()`; `link`/`duration` use
/// `?? null` and `authorName` uses `?? 'Admin'`.
pub fn plan_news_upsert(body: &Value) -> NewsUpsertRow {
    let obj = body.as_object();
    let field = |key: &str| obj.and_then(|m| m.get(key));
    NewsUpsertRow {
        id: js::string_or_nullish(field("id"), "").trim().to_string(),
        text: js::string_or_nullish(field("text"), ""),
        link: js::nullish_string(field("link")),
        duration: nullish_i32(field("duration")),
        author_name: js::string_or_nullish(field("authorName"), DEFAULT_AUTHOR_NAME),
    }
}

/// `system_news.duration` is `Int?`; Prisma only accepts a number or `null`.
fn nullish_i32(raw: Option<&Value>) -> Option<i32> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64().and_then(|v| i32::try_from(v).ok()),
        Some(Value::String(s)) => s.trim().parse::<i32>().ok(),
        _ => None,
    }
}

pub async fn run_news_upsert(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let row = plan_news_upsert(body);
    let created_at = current_unix_ms();
    let conn = pool.get().await?;
    conn.execute(
        NEWS_UPSERT_SQL,
        &[
            &row.id,
            &row.text,
            &row.link,
            &NEWS_ACTIVE_ON_CREATE,
            &row.duration,
            &row.author_name,
            &created_at,
        ],
    )
    .await?;
    Ok(json!({}))
}

pub async fn run_news_delete(pool: &Pool, id: &str) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    conn.execute(NEWS_DELETE_SQL, &[&id]).await?;
    Ok(json!({}))
}

/// Node `setNewsFeeUsdc(Number(body.feeUsdc))` → `Number.isFinite(v) ? v : 0`.
pub fn plan_news_fee(payload: &Value) -> String {
    let fee = js::number(field_of(payload, "feeUsdc"));
    js::number_to_string(if fee.is_finite() { fee } else { 0.0 })
}

/// Node `setNewsExpireDays(Number(body.days))` → `Math.max(0, Math.floor(Number(days) || 0))`.
pub fn plan_news_expire_days(payload: &Value) -> String {
    let days = js::number_or_zero(field_of(payload, "days"));
    let floored = if days.is_finite() { days.floor() } else { days };
    js::number_to_string(floored.max(0.0))
}

/// Node reads `(req.body || {}).<key>`, so a non-object body reads as absent.
fn field_of<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|m| m.get(key))
}

pub async fn run_news_fee_persist(pool: &Pool, payload: &Value) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    upsert_setting(&conn, SETTING_NEWS_FEE, &plan_news_fee(payload)).await?;
    Ok(json!({}))
}

pub async fn run_news_expire_days_persist(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    upsert_setting(&conn, SETTING_NEWS_EXPIRE, &plan_news_expire_days(payload)).await?;
    Ok(json!({}))
}

async fn upsert_setting<C: GenericClient>(
    client: &C,
    key: &str,
    value: &str,
) -> Result<(), PlayerReadError> {
    client.execute(KV_UPSERT_SQL, &[&key, &value]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn news_upsert_defaults_author_and_nulls() {
        let row = plan_news_upsert(&json!({ "id": "  n1  ", "text": "hello" }));
        assert_eq!(row.id, "n1");
        assert_eq!(row.text, "hello");
        assert_eq!(row.link, None);
        assert_eq!(row.duration, None);
        assert_eq!(row.author_name, DEFAULT_AUTHOR_NAME);
    }

    #[test]
    fn news_upsert_keeps_explicit_fields() {
        let row = plan_news_upsert(&json!({
            "id": "n2",
            "text": "t",
            "link": "https://x",
            "duration": 15,
            "authorName": "Gus"
        }));
        assert_eq!(row.link.as_deref(), Some("https://x"));
        assert_eq!(row.duration, Some(15));
        assert_eq!(row.author_name, "Gus");
    }

    #[test]
    fn news_upsert_null_author_falls_back_but_empty_string_does_not() {
        let row = plan_news_upsert(&json!({ "id": "n", "text": "t", "authorName": null }));
        assert_eq!(row.author_name, DEFAULT_AUTHOR_NAME);
        let row = plan_news_upsert(&json!({ "id": "n", "text": "t", "authorName": "" }));
        assert_eq!(row.author_name, "");
    }

    #[test]
    fn news_fee_matches_node_number_coercion() {
        assert_eq!(plan_news_fee(&json!({ "feeUsdc": 2.5 })), "2.5");
        assert_eq!(plan_news_fee(&json!({ "feeUsdc": "3" })), "3");
        // `Number(undefined)` is NaN → stored as 0.
        assert_eq!(plan_news_fee(&json!({})), "0");
        assert_eq!(plan_news_fee(&json!({ "feeUsdc": "abc" })), "0");
        assert_eq!(plan_news_fee(&json!(null)), "0");
        // Negative fees are not clamped by Node.
        assert_eq!(plan_news_fee(&json!({ "feeUsdc": -1 })), "-1");
    }

    #[test]
    fn news_expire_days_floors_and_clamps_at_zero() {
        assert_eq!(plan_news_expire_days(&json!({ "days": 7.9 })), "7");
        assert_eq!(plan_news_expire_days(&json!({ "days": -4 })), "0");
        assert_eq!(plan_news_expire_days(&json!({ "days": "abc" })), "0");
        assert_eq!(plan_news_expire_days(&json!({})), "0");
        assert_eq!(plan_news_expire_days(&json!({ "days": "12" })), "12");
    }

    #[test]
    fn duration_accepts_numbers_and_numeric_strings_only() {
        assert_eq!(nullish_i32(Some(&json!(3))), Some(3));
        assert_eq!(nullish_i32(Some(&json!("4"))), Some(4));
        assert_eq!(nullish_i32(Some(&json!("x"))), None);
        assert_eq!(nullish_i32(Some(&json!(null))), None);
        assert_eq!(nullish_i32(None), None);
    }
}
