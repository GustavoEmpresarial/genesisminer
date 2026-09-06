//! `POST /api/season-passes` twin — Node `replaceSeasonPasses`.
//!
//! The panel posts the whole catalog: each incoming pass is upserted with its
//! rewards rewritten, and passes that disappeared are dropped together with
//! their rewards and purchases.

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

use super::{js, set_tx_timeout};

/// Node `type: rew.type || 'item'`.
const DEFAULT_REWARD_TYPE: &str = "item";

const EXISTING_IDS_SQL: &str = "SELECT id FROM season_passes";

const PASS_UPSERT_SQL: &str = "INSERT INTO season_passes
       (id, season_id, name, description, price_usdc, emblem_url, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       season_id = EXCLUDED.season_id,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       price_usdc = EXCLUDED.price_usdc,
       emblem_url = EXCLUDED.emblem_url,
       is_active = EXCLUDED.is_active";

const REWARDS_DELETE_SQL: &str = "DELETE FROM season_pass_rewards WHERE pass_id = $1";
const REWARD_INSERT_SQL: &str = "INSERT INTO season_pass_rewards
       (pass_id, type, item_id, coin_id, qty)
     VALUES ($1, $2, $3, $4, $5)";
const PURCHASES_DELETE_SQL: &str = "DELETE FROM season_purchases WHERE pass_id = $1";
const PASS_DELETE_SQL: &str = "DELETE FROM season_passes WHERE id = $1";

#[derive(Debug, Clone, PartialEq)]
pub struct SeasonPassRewardRow {
    pub reward_type: String,
    pub item_id: Option<String>,
    pub coin_id: Option<String>,
    pub qty: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeasonPassRow {
    pub id: String,
    pub season_id: String,
    pub name: String,
    pub description: String,
    pub price_usdc: f64,
    pub emblem_url: Option<String>,
    pub is_active: i32,
    pub rewards: Vec<SeasonPassRewardRow>,
}

/// Node skips entries with a falsy `id` (`if (!p.id) continue`).
pub fn parse_season_pass_rows(passes: &[Value]) -> Vec<SeasonPassRow> {
    passes.iter().filter_map(parse_season_pass_row).collect()
}

fn parse_season_pass_row(pass: &Value) -> Option<SeasonPassRow> {
    let obj = pass.as_object();
    let field = |key: &str| obj.and_then(|m| m.get(key));
    if !js::truthy(field("id")) {
        return None;
    }
    Some(SeasonPassRow {
        id: js::string(field("id")),
        season_id: js::string_or(field("seasonId"), ""),
        name: js::string_or(field("name"), ""),
        description: js::string_or(field("description"), ""),
        price_usdc: js::number_or_zero(field("priceUsdc")),
        // Node `p.emblemUrl || null` — an empty string stores NULL.
        emblem_url: js::truthy(field("emblemUrl")).then(|| js::string(field("emblemUrl"))),
        is_active: i32::from(js::truthy(field("isActive"))),
        rewards: parse_rewards(field("rewards")),
    })
}

fn parse_rewards(raw: Option<&Value>) -> Vec<SeasonPassRewardRow> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .map(|rew| {
            let obj = rew.as_object();
            let field = |key: &str| obj.and_then(|m| m.get(key));
            SeasonPassRewardRow {
                reward_type: js::string_or(field("type"), DEFAULT_REWARD_TYPE),
                item_id: js::nullish_string(field("itemId")),
                coin_id: js::nullish_string(field("coinId")),
                qty: js::number_or_zero(field("qty")),
            }
        })
        .collect()
}

pub async fn run_replace_season_passes(
    pool: &Pool,
    passes: &[Value],
) -> Result<Value, PlayerReadError> {
    let rows = parse_season_pass_rows(passes);
    let incoming_ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_tx_timeout(&tx).await?;

    // Node snapshots the existing ids before the transaction; reading them
    // inside it is strictly safer and keeps the prune consistent.
    let existing: Vec<String> = tx
        .query(EXISTING_IDS_SQL, &[])
        .await?
        .iter()
        .map(|r| r.get::<_, String>("id"))
        .collect();

    for row in &rows {
        tx.execute(
            PASS_UPSERT_SQL,
            &[
                &row.id,
                &row.season_id,
                &row.name,
                &row.description,
                &row.price_usdc,
                &row.emblem_url,
                &row.is_active,
            ],
        )
        .await?;
        tx.execute(REWARDS_DELETE_SQL, &[&row.id]).await?;
        for rew in &row.rewards {
            tx.execute(
                REWARD_INSERT_SQL,
                &[
                    &row.id,
                    &rew.reward_type,
                    &rew.item_id,
                    &rew.coin_id,
                    &rew.qty,
                ],
            )
            .await?;
        }
    }

    for id in existing {
        if incoming_ids.contains(&id) {
            continue;
        }
        tx.execute(REWARDS_DELETE_SQL, &[&id]).await?;
        tx.execute(PURCHASES_DELETE_SQL, &[&id]).await?;
        tx.execute(PASS_DELETE_SQL, &[&id]).await?;
    }

    tx.commit().await?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falsy_ids_are_skipped() {
        let rows = parse_season_pass_rows(&[
            json!({ "id": "" }),
            json!({ "id": null }),
            json!({}),
            json!("x"),
            json!({ "id": "s1" }),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "s1");
    }

    #[test]
    fn defaults_match_node() {
        let rows = parse_season_pass_rows(&[json!({ "id": "s1" })]);
        let row = &rows[0];
        assert_eq!(row.season_id, "");
        assert_eq!(row.name, "");
        assert_eq!(row.description, "");
        assert_eq!(row.price_usdc, 0.0);
        assert_eq!(row.emblem_url, None);
        assert_eq!(row.is_active, 0);
        assert!(row.rewards.is_empty());
    }

    #[test]
    fn empty_emblem_url_stores_null() {
        let rows = parse_season_pass_rows(&[json!({ "id": "s1", "emblemUrl": "" })]);
        assert_eq!(rows[0].emblem_url, None);
        let rows = parse_season_pass_rows(&[json!({ "id": "s1", "emblemUrl": "e.png" })]);
        assert_eq!(rows[0].emblem_url.as_deref(), Some("e.png"));
    }

    #[test]
    fn rewards_default_type_and_numeric_qty() {
        let rows = parse_season_pass_rows(&[json!({
            "id": "s1",
            "rewards": [
                { "qty": "3" },
                { "type": "coin", "coinId": "gemt", "qty": 5 },
                { "type": "item", "itemId": "rack", "qty": "abc" }
            ]
        })]);
        let rewards = &rows[0].rewards;
        assert_eq!(rewards[0].reward_type, DEFAULT_REWARD_TYPE);
        assert_eq!(rewards[0].qty, 3.0);
        assert_eq!(rewards[0].item_id, None);
        assert_eq!(rewards[1].coin_id.as_deref(), Some("gemt"));
        assert_eq!(rewards[1].qty, 5.0);
        assert_eq!(rewards[2].qty, 0.0);
    }

    #[test]
    fn non_array_rewards_are_empty() {
        let rows = parse_season_pass_rows(&[json!({ "id": "s1", "rewards": null })]);
        assert!(rows[0].rewards.is_empty());
    }

    #[test]
    fn price_accepts_numeric_strings() {
        let rows = parse_season_pass_rows(&[json!({ "id": "s1", "priceUsdc": "9.5" })]);
        assert_eq!(rows[0].price_usdc, 9.5);
    }
}
