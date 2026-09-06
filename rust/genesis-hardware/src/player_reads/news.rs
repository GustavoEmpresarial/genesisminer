//! System news GETs — Node `GET /api/news`, `/api/news-fee`, `/api/news-expire-days`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::time::MS_PER_DAY;
use serde_json::{json, Value};

use crate::config::current_unix_ms;

use super::{i32_cell, i64_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError};

const SETTING_NEWS_FEE: &str = "news_post_fee_usdc";
const SETTING_NEWS_EXPIRE: &str = "news_post_expire_days";

const _: () = assert!(MS_PER_DAY == 86_400_000);

pub async fn run_news_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    expire_old_news(&conn).await?;
    let rows = conn
        .query(
            "SELECT id, text, link, active, duration, author_name, created_at
               FROM system_news
              ORDER BY created_at DESC",
            &[],
        )
        .await?;
    let items: Vec<Value> = rows.iter().map(map_news_row).collect();
    Ok(json!({ "items": items }))
}

pub async fn run_news_fee(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let fee = setting_number(&conn, SETTING_NEWS_FEE).await?;
    Ok(json!({ "feeUsdc": fee }))
}

pub async fn run_news_expire_days(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let days = setting_number(&conn, SETTING_NEWS_EXPIRE).await?;
    Ok(json!({ "days": days }))
}

async fn expire_old_news<C: GenericClient>(client: &C) -> Result<(), PlayerReadError> {
    let days = setting_number(client, SETTING_NEWS_EXPIRE).await?;
    if days <= 0.0 {
        return Ok(());
    }
    let cutoff = current_unix_ms() - (days as i64) * (MS_PER_DAY as i64);
    client
        .execute("DELETE FROM system_news WHERE created_at < $1", &[&cutoff])
        .await?;
    Ok(())
}

async fn setting_number<C: GenericClient>(client: &C, key: &str) -> Result<f64, PlayerReadError> {
    let row = client
        .query_opt("SELECT value FROM settings WHERE key = $1", &[&key])
        .await?;
    let Some(r) = row else {
        return Ok(0.0);
    };
    Ok(parse_setting_number(
        opt_string_cell(&r, "value").as_deref(),
    ))
}

fn parse_setting_number(raw: Option<&str>) -> f64 {
    let Some(s) = raw.filter(|v| !v.is_empty()) else {
        return 0.0;
    };
    s.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .filter(|v| *v != 0.0)
        .unwrap_or(0.0)
}

fn map_news_row(r: &tokio_postgres::Row) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("id".into(), json!(string_cell(r, "id")));
    obj.insert("text".into(), json!(string_cell(r, "text")));
    if let Some(link) = opt_string_cell(r, "link") {
        obj.insert("link".into(), json!(link));
    }
    obj.insert("active".into(), json!(i32_cell(r, "active") != 0));
    if let Some(d) = opt_i32_cell(r, "duration") {
        obj.insert("duration".into(), json!(d));
    }
    if let Some(a) = opt_string_cell(r, "author_name") {
        obj.insert("authorName".into(), json!(a));
    }
    obj.insert("createdAt".into(), json!(i64_cell(r, "created_at")));
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_invalid_setting_is_zero() {
        assert_eq!(parse_setting_number(None), 0.0);
        assert_eq!(parse_setting_number(Some("")), 0.0);
        assert_eq!(parse_setting_number(Some("abc")), 0.0);
        assert_eq!(parse_setting_number(Some("0")), 0.0);
        assert_eq!(parse_setting_number(Some("7")), 7.0);
    }
}
