//! `POST /api/access-levels` twin — Node `replaceAccessLevels`.
//!
//! One transaction: prune levels missing from the payload, UPSERT the rest,
//! then re-home users whose level no longer exists onto the default one.

use deadpool_postgres::Pool;
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;

use crate::player_reads::PlayerReadError;

use super::{js, set_tx_timeout};

const DELETE_MISSING_SQL: &str =
    "DELETE FROM access_levels WHERE id NOT IN (SELECT unnest($1::text[]))";

const UPSERT_SQL: &str = "INSERT INTO access_levels
       (id, name, description, is_default, is_active, price_usdc, contract_address,
        inactive_message, news_posting_enabled, allowed_pages)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       is_default = EXCLUDED.is_default,
       is_active = EXCLUDED.is_active,
       price_usdc = EXCLUDED.price_usdc,
       contract_address = EXCLUDED.contract_address,
       inactive_message = EXCLUDED.inactive_message,
       news_posting_enabled = EXCLUDED.news_posting_enabled,
       allowed_pages = EXCLUDED.allowed_pages";

const REASSIGN_USERS_SQL: &str =
    "UPDATE users SET access_level_id = $1 WHERE access_level_id NOT IN (SELECT unnest($2::text[]))";

/// One row of the admin payload, already coerced to its column types.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessLevelRow {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub is_default: i32,
    pub is_active: i32,
    pub price_usdc: Option<f64>,
    pub contract_address: Option<String>,
    pub inactive_message: Option<String>,
    pub news_posting_enabled: i32,
    pub allowed_pages: String,
    /// JS truthiness of `id`, which is what `filter(Boolean)` keeps.
    pub id_is_truthy: bool,
}

pub fn parse_access_level_rows(levels: &[Value]) -> Vec<AccessLevelRow> {
    levels.iter().map(parse_access_level_row).collect()
}

fn parse_access_level_row(level: &Value) -> AccessLevelRow {
    let obj = level.as_object();
    let field = |key: &str| obj.and_then(|m| m.get(key));
    AccessLevelRow {
        id: js::nullish_string(field("id")),
        name: js::nullish_string(field("name")),
        description: js::nullish_string(field("description")),
        is_default: i32::from(js::truthy(field("isDefault"))),
        is_active: i32::from(js::truthy(field("isActive"))),
        price_usdc: js::nullish_number(field("priceUsdc")),
        contract_address: js::nullish_string(field("contractAddress")),
        inactive_message: js::nullish_string(field("inactiveMessage")),
        news_posting_enabled: i32::from(js::truthy(field("newsPostingEnabled"))),
        allowed_pages: serialize_allowed_pages(field("allowedPages")),
        id_is_truthy: js::truthy(field("id")),
    }
}

/// Node `JSON.stringify(Array.isArray(l.allowedPages) ? l.allowedPages : [])`.
fn serialize_allowed_pages(raw: Option<&Value>) -> String {
    match raw {
        Some(Value::Array(items)) => Value::Array(items.clone()).to_string(),
        _ => "[]".to_string(),
    }
}

/// Node `levels.map((l) => l.id).filter(Boolean)`.
pub fn incoming_ids(rows: &[AccessLevelRow]) -> Vec<String> {
    rows.iter()
        .filter(|r| r.id_is_truthy)
        .filter_map(|r| r.id.clone())
        .collect()
}

/// Node `levels.find((l) => l.isDefault)?.id || levels[0]?.id`.
pub fn resolve_default_id(rows: &[AccessLevelRow]) -> Option<String> {
    let flagged = rows
        .iter()
        .find(|r| r.is_default != 0)
        .and_then(|r| r.id.clone())
        .filter(|id| !id.is_empty());
    flagged.or_else(|| rows.first().and_then(|r| r.id.clone()))
}

pub async fn run_replace_access_levels(
    pool: &Pool,
    levels: &[Value],
) -> Result<Value, PlayerReadError> {
    let rows = parse_access_level_rows(levels);
    let ids = incoming_ids(&rows);

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_tx_timeout(&tx).await?;

    if !ids.is_empty() {
        tx.execute(DELETE_MISSING_SQL, &[&ids]).await?;
    }

    for row in &rows {
        let params: [&(dyn ToSql + Sync); 10] = [
            &row.id,
            &row.name,
            &row.description,
            &row.is_default,
            &row.is_active,
            &row.price_usdc,
            &row.contract_address,
            &row.inactive_message,
            &row.news_posting_enabled,
            &row.allowed_pages,
        ];
        tx.execute(UPSERT_SQL, &params).await?;
    }

    if let Some(default_id) = resolve_default_id(&rows) {
        if !default_id.is_empty() && !ids.is_empty() {
            tx.execute(REASSIGN_USERS_SQL, &[&default_id, &ids]).await?;
        }
    }

    tx.commit().await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_coercion_matches_node() {
        let rows = parse_access_level_rows(&[json!({
            "id": "vip",
            "name": "VIP",
            "description": "",
            "isDefault": 1,
            "isActive": false,
            "priceUsdc": "12.5",
            "allowedPages": ["shop", "market"]
        })]);
        let row = &rows[0];
        assert_eq!(row.id.as_deref(), Some("vip"));
        assert_eq!(row.description.as_deref(), Some(""));
        assert_eq!(row.is_default, 1);
        assert_eq!(row.is_active, 0);
        assert_eq!(row.price_usdc, Some(12.5));
        assert_eq!(row.contract_address, None);
        assert_eq!(row.news_posting_enabled, 0);
        assert_eq!(row.allowed_pages, r#"["shop","market"]"#);
    }

    #[test]
    fn allowed_pages_defaults_to_empty_json_array() {
        for raw in [json!(null), json!("shop"), json!({ "a": 1 })] {
            let rows = parse_access_level_rows(&[json!({ "id": "x", "allowedPages": raw })]);
            assert_eq!(rows[0].allowed_pages, "[]");
        }
        let rows = parse_access_level_rows(&[json!({ "id": "x" })]);
        assert_eq!(rows[0].allowed_pages, "[]");
    }

    #[test]
    fn incoming_ids_drop_falsy_like_filter_boolean() {
        let rows = parse_access_level_rows(&[
            json!({ "id": "a" }),
            json!({ "id": "" }),
            json!({ "id": null }),
            json!({ "name": "no id" }),
            json!({ "id": "b" }),
        ]);
        assert_eq!(incoming_ids(&rows), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn default_id_prefers_flagged_then_first() {
        let rows = parse_access_level_rows(&[
            json!({ "id": "free" }),
            json!({ "id": "vip", "isDefault": true }),
        ]);
        assert_eq!(resolve_default_id(&rows).as_deref(), Some("vip"));

        let rows = parse_access_level_rows(&[json!({ "id": "free" }), json!({ "id": "vip" })]);
        assert_eq!(resolve_default_id(&rows).as_deref(), Some("free"));

        assert_eq!(resolve_default_id(&[]), None);
    }

    #[test]
    fn non_object_entries_yield_null_columns() {
        let rows = parse_access_level_rows(&[json!("oops")]);
        assert_eq!(rows[0].id, None);
        assert!(!rows[0].id_is_truthy);
        assert!(incoming_ids(&rows).is_empty());
    }
}
