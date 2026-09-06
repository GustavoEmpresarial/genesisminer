//! Player-game nav — Node `GET /api/player-game/nav`.

use deadpool_postgres::Pool;
use genesis_core::game_nav::{build_game_nav_items, GameNavBuildInput};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{i32_cell, pg_user_id, string_cell, PlayerReadError};

const ROLETA_HIDDEN: &[&str] = &["0", "false", "no", "off", "hidden", "hide"];
const ROLETA_LABEL_KEY: &str = "nav.roleta_tab_visible";
const ACCOUNT_MANAGER_ENV: &str = "ACCOUNT_MANAGER_ENABLED";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavRequest {
    pub user_id: i64,
    #[serde(default)]
    pub managing: Option<bool>,
}

pub async fn run_nav(pool: &Pool, user_id: i64, managing: bool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let row = conn
        .query_opt(
            "SELECT is_admin, is_super_admin FROM users WHERE id = $1",
            &[&uid],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::not_found("Not authenticated."));
    };
    let labels = conn
        .query("SELECT key, value FROM ui_display_labels", &[])
        .await?;
    let mut roleta_raw = String::new();
    for r in &labels {
        if string_cell(r, "key") == ROLETA_LABEL_KEY {
            roleta_raw = string_cell(r, "value");
        }
    }
    let show_roleta = {
        let s = roleta_raw.trim().to_ascii_lowercase();
        s.is_empty() || !ROLETA_HIDDEN.iter().any(|h| *h == s)
    };
    let account_manager = std::env::var(ACCOUNT_MANAGER_ENV)
        .ok()
        .map(|v| {
            let s = v.trim().to_ascii_lowercase();
            s == "1" || s == "true" || s == "yes" || s == "on"
        })
        .unwrap_or(false);
    let out = build_game_nav_items(&GameNavBuildInput {
        is_managing_account: managing,
        manager_mode: managing,
        is_admin: i32_cell(&row, "is_admin") == 1,
        is_super_admin: i32_cell(&row, "is_super_admin") == 1,
        merge_enabled: true,
        account_manager_enabled: account_manager,
        show_roleta_in_nav: show_roleta,
    });
    Ok(json!(out))
}
