//! Public guide — Node `GET /api/guide` (`listPublishedGuide`).

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use super::{i32_cell, i64_cell, now_ms, string_cell, PlayerReadError};

const ACTIVE_FLAG: i32 = 1;

const _: () = assert!(ACTIVE_FLAG == 1);

pub async fn run_guide(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let cats = conn
        .query(
            "SELECT id, title, sort_order, is_published, created_at, updated_at
               FROM guide_categories
              WHERE is_published = $1
              ORDER BY sort_order ASC, title ASC",
            &[&ACTIVE_FLAG],
        )
        .await?;
    let pages = conn
        .query(
            "SELECT p.id, p.category_id, p.title, p.slug, p.content_html, p.sort_order,
                    p.is_published, p.created_at, p.updated_at
               FROM guide_pages p
               INNER JOIN guide_categories c ON c.id = p.category_id
              WHERE p.is_published = $1 AND c.is_published = $1
              ORDER BY p.sort_order ASC, p.title ASC",
            &[&ACTIVE_FLAG],
        )
        .await?;
    let mut by_cat: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for p in &pages {
        by_cat
            .entry(string_cell(p, "category_id"))
            .or_default()
            .push(map_page(p));
    }
    let categories: Vec<Value> = cats
        .iter()
        .map(|c| {
            let id = string_cell(c, "id");
            json!({
                "id": id,
                "title": string_cell(c, "title"),
                "sortOrder": i32_cell(c, "sort_order"),
                "isPublished": i32_cell(c, "is_published") == ACTIVE_FLAG,
                "pages": by_cat.get(&id).cloned().unwrap_or_default(),
                "createdAt": ts_or_now(i64_cell(c, "created_at")),
                "updatedAt": ts_or_now(i64_cell(c, "updated_at")),
            })
        })
        .collect();
    Ok(json!({ "categories": categories }))
}

fn map_page(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": string_cell(r, "id"),
        "categoryId": string_cell(r, "category_id"),
        "title": string_cell(r, "title"),
        "slug": string_cell(r, "slug"),
        "contentHtml": string_cell(r, "content_html"),
        "sortOrder": i32_cell(r, "sort_order"),
        "isPublished": i32_cell(r, "is_published") == ACTIVE_FLAG,
        "createdAt": ts_or_now(i64_cell(r, "created_at")),
        "updatedAt": ts_or_now(i64_cell(r, "updated_at")),
    })
}

fn ts_or_now(v: i64) -> i64 {
    if v == 0 {
        now_ms()
    } else {
        v
    }
}
