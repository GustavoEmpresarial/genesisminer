//! Public roadmap — Node `GET /api/roadmap` (`listPublishedRoadmap`).

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use super::{i32_cell, i64_cell, now_ms, opt_string, string_cell, PlayerReadError};

const ACTIVE_FLAG: i32 = 1;
const DEFAULT_STATUS: &str = "planned";
const ROADMAP_STATUSES: &[&str] = &["planned", "in_dev", "testing", "done", "cancelled"];

const _: () = assert!(ACTIVE_FLAG == 1);

pub async fn run_roadmap(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, title, description, status, planned_date, image_url,
                    is_highlight, sort_order, is_published, created_at, updated_at
               FROM roadmap_steps
              WHERE is_published = $1
              ORDER BY sort_order ASC, created_at ASC",
            &[&ACTIVE_FLAG],
        )
        .await?;
    let steps: Vec<Value> = rows.iter().map(map_step).collect();
    Ok(json!({ "steps": steps }))
}

fn map_step(r: &tokio_postgres::Row) -> Value {
    let raw_status = string_cell(r, "status");
    let status = if ROADMAP_STATUSES.contains(&raw_status.as_str()) {
        raw_status
    } else {
        DEFAULT_STATUS.to_string()
    };
    json!({
        "id": string_cell(r, "id"),
        "title": string_cell(r, "title"),
        "description": string_cell(r, "description"),
        "status": status,
        "plannedDate": opt_string(r, "planned_date"),
        "imageUrl": opt_string(r, "image_url"),
        "isHighlight": i32_cell(r, "is_highlight") == ACTIVE_FLAG,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_status_falls_back() {
        assert!(ROADMAP_STATUSES.contains(&DEFAULT_STATUS));
        assert!(!ROADMAP_STATUSES.contains(&"nope"));
    }
}
