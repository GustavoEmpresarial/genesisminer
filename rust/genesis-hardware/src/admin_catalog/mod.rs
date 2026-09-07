//! Admin catalog / settings writes — the `/api/*` admin tabs that live outside
//! the `/api/admin` prefix and used to be served by Express.
//!
//! Ports:
//! - `server/modules/catalog/services/{access-levels,news,mining-coins,season-passes}.ts`
//! - `server/modules/admin/loot-boxes/services/catalog.ts` (`upsertLootBoxCatalog`)
//! - `server/modules/rooms/services/rooms-admin.ts` (`upsertRigRoomsCatalog`)
//!
//! `POST /api/upgrades` is **not** here — it keeps its own OCC twin in
//! [`crate::catalog`]. Admin authorization stays in genesis-api (`require_admin`).

pub mod access_levels;
pub mod http;
pub mod js;
pub mod loot_boxes;
pub mod mining_coins;
pub mod news;
pub mod rig_rooms;
pub mod season_passes;

pub const ACCESS_LEVELS_REPLACE_PATH: &str = "/v1/catalog/access-levels/replace";
pub const LOOT_BOXES_UPSERT_PATH: &str = "/v1/catalog/loot-boxes/upsert";
pub const LOOT_BOXES_DELETE_PATH: &str = "/v1/catalog/loot-boxes/delete";
pub const LOOT_BOX_REDEMPTIONS_PATH: &str = "/v1/lucky-boxes/admin/redemptions";
pub const ADMIN_USER_BOXES_PATH: &str = "/v1/lucky-boxes/admin/user-boxes";
pub const ADMIN_DELETE_USER_BOX_PATH: &str = "/v1/lucky-boxes/admin/delete-user-box";
pub const MINING_COINS_UPSERT_PATH: &str = "/v1/catalog/mining-coins/upsert";
pub const MINING_COINS_ECONOMY_SETTINGS_PATH: &str = "/v1/catalog/mining-coins/economy-settings";
pub const NEWS_UPSERT_PATH: &str = "/v1/catalog/news/upsert";
pub const NEWS_DELETE_PATH: &str = "/v1/catalog/news/delete";
pub const NEWS_FEE_PERSIST_PATH: &str = "/v1/settings/news-fee/persist";
pub const NEWS_EXPIRE_DAYS_PERSIST_PATH: &str = "/v1/settings/news-expire-days/persist";
pub const SEASON_PASSES_REPLACE_PATH: &str = "/v1/catalog/season-passes/replace";
pub const RIG_ROOMS_UPSERT_PATH: &str = "/v1/rooms/catalog/upsert";

use deadpool_postgres::GenericClient;

use crate::catalog::replace::CATALOG_REPLACE_TX_TIMEOUT_MS;
use crate::player_reads::PlayerReadError;

/// Node wraps each of these writes in a `$transaction` with `timeout: 60_000`;
/// the same budget the upgrades catalog replace already uses.
pub const ADMIN_CATALOG_TX_TIMEOUT_MS: u64 = CATALOG_REPLACE_TX_TIMEOUT_MS;

const _: () = assert!(ADMIN_CATALOG_TX_TIMEOUT_MS == 60_000);

pub async fn set_tx_timeout<C: GenericClient>(client: &C) -> Result<(), PlayerReadError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {ADMIN_CATALOG_TX_TIMEOUT_MS}"),
            &[],
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_match_genesis_api_client() {
        assert_eq!(
            ACCESS_LEVELS_REPLACE_PATH,
            "/v1/catalog/access-levels/replace"
        );
        assert_eq!(LOOT_BOXES_UPSERT_PATH, "/v1/catalog/loot-boxes/upsert");
        assert_eq!(MINING_COINS_UPSERT_PATH, "/v1/catalog/mining-coins/upsert");
        assert_eq!(NEWS_UPSERT_PATH, "/v1/catalog/news/upsert");
        assert_eq!(NEWS_DELETE_PATH, "/v1/catalog/news/delete");
        assert_eq!(NEWS_FEE_PERSIST_PATH, "/v1/settings/news-fee/persist");
        assert_eq!(
            NEWS_EXPIRE_DAYS_PERSIST_PATH,
            "/v1/settings/news-expire-days/persist"
        );
        assert_eq!(
            SEASON_PASSES_REPLACE_PATH,
            "/v1/catalog/season-passes/replace"
        );
        assert_eq!(RIG_ROOMS_UPSERT_PATH, "/v1/rooms/catalog/upsert");
    }

    #[test]
    fn tx_timeout_matches_node_prisma_option() {
        assert_eq!(ADMIN_CATALOG_TX_TIMEOUT_MS, 60_000);
    }
}
