//! Season-pass catalog — Node `GET /api/season-passes`.

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use super::{f64_cell, i32_cell, opt_string_cell, string_cell, PlayerReadError};

pub async fn run_season_passes(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, season_id, name, description,
                    price_usdc::double precision AS price_usdc,
                    emblem_url, is_active
               FROM season_passes",
            &[],
        )
        .await?;
    if rows.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let pass_ids: Vec<String> = rows.iter().map(|r| string_cell(r, "id")).collect();
    let reward_rows = conn
        .query(
            "SELECT id, pass_id, type, item_id, coin_id, qty::double precision AS qty
               FROM season_pass_rewards
              WHERE pass_id = ANY($1::text[])",
            &[&pass_ids],
        )
        .await?;
    let mut rewards: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for r in &reward_rows {
        rewards
            .entry(string_cell(r, "pass_id"))
            .or_default()
            .push(json!({
                "id": i32_cell(r, "id"),
                "type": string_cell(r, "type"),
                "itemId": opt_string_cell(r, "item_id"),
                "coinId": opt_string_cell(r, "coin_id"),
                "qty": f64_cell(r, "qty"),
            }));
    }
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let id = string_cell(r, "id");
            json!({
                "id": id,
                "seasonId": string_cell(r, "season_id"),
                "name": string_cell(r, "name"),
                "description": string_cell(r, "description"),
                "priceUsdc": f64_cell(r, "price_usdc"),
                "emblemUrl": opt_string_cell(r, "emblem_url").unwrap_or_default(),
                "isActive": i32_cell(r, "is_active") != 0,
                "rewards": rewards.get(&id).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({ "items": items }))
}
