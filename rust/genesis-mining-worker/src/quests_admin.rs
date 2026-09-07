//! Admin quest definitions — ports `listAllQuestDefinitionsAdmin` /
//! `saveQuestDefinitionAdmin` from `server/modules/quests/services/quest.ts`.
//!
//! Admin auth stays in `genesis-api` (`admin_quests.rs`, tab
//! `settings:monetization`); player `/api/quests/*` already runs in
//! [`crate::player_reads::quests`].

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::quests::ensure_quest_schema;
use crate::player_reads::{f64_cell, i32_cell, i64_cell, now_ms, string_cell, PlayerReadError};

pub const QUESTS_ADMIN_LIST_PATH: &str = "/v1/quests/admin/list";
pub const QUESTS_ADMIN_SAVE_PATH: &str = "/v1/quests/admin/save";

const TITLE_MAX_LENGTH: usize = 120;
const DESCRIPTION_MAX_LENGTH: usize = 400;
const TARGET_COUNT_MAX: i64 = 10_000;
const REWARD_USDC_MAX: f64 = 1_000_000.0;
const REWARD_USDC_DECIMALS: f64 = 1_000_000.0;

const SELECT_COLS: &str = "id, period, action_type, title, description, target_count, \
     reward_usdc::double precision AS reward_usdc, sort_order, enabled, updated_at";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestSaveRequest {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, alias = "target_count")]
    pub target_count: Option<Value>,
    #[serde(default, alias = "reward_usdc")]
    pub reward_usdc: Option<Value>,
    #[serde(default, alias = "sort_order")]
    pub sort_order: Option<Value>,
    #[serde(default)]
    pub enabled: Option<Value>,
}

fn map_def_row(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": string_cell(r, "id"),
        "period": string_cell(r, "period"),
        "action_type": string_cell(r, "action_type"),
        "title": string_cell(r, "title"),
        "description": string_cell(r, "description"),
        "target_count": i32_cell(r, "target_count").max(1),
        "reward_usdc": f64_cell(r, "reward_usdc").max(0.0),
        "sort_order": i32_cell(r, "sort_order"),
        "enabled": if i32_cell(r, "enabled") == 1 { 1 } else { 0 },
        "updated_at": i64_cell(r, "updated_at"),
    })
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub async fn run_quests_admin_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    ensure_quest_schema(&conn, now_ms()).await?;
    let rows = conn
        .query(
            &format!(
                "SELECT {SELECT_COLS} FROM quest_definitions ORDER BY sort_order ASC, id ASC"
            ),
            &[],
        )
        .await?;
    Ok(json!({ "definitions": rows.iter().map(map_def_row).collect::<Vec<_>>() }))
}

pub async fn run_quests_admin_save(
    pool: &Pool,
    req: QuestSaveRequest,
) -> Result<Value, PlayerReadError> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err(PlayerReadError::not_found("Quest not found."));
    }
    let conn = pool.get().await?;
    ensure_quest_schema(&conn, now_ms()).await?;

    let cur = conn
        .query_opt(
            &format!("SELECT {SELECT_COLS} FROM quest_definitions WHERE id = $1"),
            &[&id],
        )
        .await?;
    let Some(cur) = cur else {
        return Err(PlayerReadError::not_found("Quest not found."));
    };

    let title = match req.title {
        Some(raw) => {
            let t: String = raw.trim().chars().take(TITLE_MAX_LENGTH).collect();
            if t.is_empty() {
                return Err(PlayerReadError::not_found("Quest not found."));
            }
            t
        }
        None => string_cell(&cur, "title"),
    };
    let description = match req.description {
        Some(raw) => raw
            .trim()
            .chars()
            .take(DESCRIPTION_MAX_LENGTH)
            .collect::<String>(),
        None => string_cell(&cur, "description"),
    };
    let target_count: i32 = match req.target_count.as_ref().and_then(value_to_f64) {
        Some(n) => (n.floor() as i64).clamp(1, TARGET_COUNT_MAX) as i32,
        None => i32_cell(&cur, "target_count").max(1),
    };
    let reward_usdc: f64 = match req.reward_usdc.as_ref().and_then(value_to_f64) {
        Some(n) => {
            let rounded = (n * REWARD_USDC_DECIMALS).round() / REWARD_USDC_DECIMALS;
            rounded.clamp(0.0, REWARD_USDC_MAX)
        }
        None => f64_cell(&cur, "reward_usdc").max(0.0),
    };
    let sort_order: i32 = match req.sort_order.as_ref().and_then(value_to_f64) {
        Some(n) => n.floor() as i32,
        None => i32_cell(&cur, "sort_order"),
    };
    let enabled: i32 = match req.enabled.as_ref() {
        Some(Value::Bool(b)) => i32::from(*b),
        Some(Value::Number(n)) => i32::from(n.as_i64() == Some(1)),
        Some(Value::String(s)) => i32::from(s == "1" || s.eq_ignore_ascii_case("true")),
        Some(_) => 0,
        None => {
            if i32_cell(&cur, "enabled") == 1 {
                1
            } else {
                0
            }
        }
    };

    let now = now_ms();
    conn.execute(
        "UPDATE quest_definitions
            SET title = $2, description = $3, target_count = $4, reward_usdc = $5,
                sort_order = $6, enabled = $7, updated_at = $8
          WHERE id = $1",
        &[
            &id,
            &title,
            &description,
            &target_count,
            &reward_usdc,
            &sort_order,
            &enabled,
            &now,
        ],
    )
    .await?;

    let next = conn
        .query_one(
            &format!("SELECT {SELECT_COLS} FROM quest_definitions WHERE id = $1"),
            &[&id],
        )
        .await?;
    Ok(json!({ "definition": map_def_row(&next) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(QUESTS_ADMIN_LIST_PATH, "/v1/quests/admin/list");
        assert_eq!(QUESTS_ADMIN_SAVE_PATH, "/v1/quests/admin/save");
    }

    #[test]
    fn value_to_f64_parses() {
        assert_eq!(value_to_f64(&json!(3)), Some(3.0));
        assert_eq!(value_to_f64(&json!("2.5")), Some(2.5));
        assert_eq!(value_to_f64(&json!(null)), None);
    }
}
