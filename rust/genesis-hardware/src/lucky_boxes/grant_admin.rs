//! Admin upgrade package grant — port of Node `grantAdminUpgradeRewardsInTx` + expand.
//! Used in-process by lucky-box open (no HTTP hop).

use deadpool_postgres::GenericClient;

use crate::persist::credit_stock;
use crate::pg_types::pg_user_id;

use super::errors::{LuckyBoxError, CODE_UPGRADE_NOT_FOUND, ERR_UPGRADE_NOT_FOUND, HTTP_CONFLICT};

/// Node `GENESIS_BUNDLE_UPGRADE_ID`.
pub const GENESIS_BUNDLE_UPGRADE_ID: &str = "53f0c699-0471-4e65-a147-17064e3aafe0";
/// Node `GENESIS_ROOM_ID`.
pub const GENESIS_ROOM_ID: &str = "room_1765936323521";
/// Node `GENESIS_ROOM_UNLOCKED_SLOTS`.
pub const GENESIS_ROOM_UNLOCKED_SLOTS: i32 = 0;

const SELECT_ADMIN_UPGRADE_SQL: &str =
    "SELECT grant_usdc::double precision AS grant_usdc, grant_access_level_id FROM admin_upgrades WHERE id = $1";
const INC_USDC_SQL: &str = "UPDATE game_states SET usdc = usdc + $2 WHERE user_id = $1";
const SELECT_ADMIN_COINS_SQL: &str =
    "SELECT coin_id, amount::double precision AS amount FROM admin_upgrade_coins WHERE upgrade_id = $1";
const UPSERT_COIN_SQL: &str =
    "INSERT INTO coin_balances (user_id, coin_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, coin_id) DO UPDATE SET amount = coin_balances.amount + EXCLUDED.amount";
const SELECT_ADMIN_ITEMS_SQL: &str =
    "SELECT item_id, qty FROM admin_upgrade_items WHERE upgrade_id = $1";
const SELECT_ADMIN_BOXES_SQL: &str =
    "SELECT box_id, qty FROM admin_upgrade_boxes WHERE upgrade_id = $1";
const UPSERT_UNOPENED_SQL: &str =
    "INSERT INTO unopened_boxes (user_id, box_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, box_id) DO UPDATE SET qty = unopened_boxes.qty + EXCLUDED.qty";
const SELECT_ADMIN_PASSES_SQL: &str =
    "SELECT pass_id FROM admin_upgrade_passes WHERE upgrade_id = $1";
const SELECT_PASS_SEASON_SQL: &str = "SELECT season_id FROM season_passes WHERE id = $1";
const INSERT_SEASON_PURCHASE_SQL: &str =
    "INSERT INTO season_purchases (user_id, pass_id, season_id, purchased_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING";
const UPDATE_USER_ACCESS_SQL: &str = "UPDATE users SET access_level_id = $2 WHERE id = $1";
const INSERT_USER_ACCESS_SQL: &str =
    "INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING";
const SELECT_BOXES_BY_TRIGGER_SQL: &str = "SELECT id FROM loot_boxes WHERE trigger = $1";
const SELECT_RIG_ROOM_SQL: &str = "SELECT id FROM rig_rooms WHERE id = $1";
const INSERT_USER_RIG_ROOM_SQL: &str =
    "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING";
const SELECT_PASS_REWARDS_SQL: &str =
    "SELECT type, coin_id, item_id, qty::double precision AS qty FROM season_pass_rewards WHERE pass_id = $1";
const SELECT_PASS_BOXES_SQL: &str =
    "SELECT id FROM loot_boxes WHERE LOWER(trigger) = LOWER($1) OR LOWER(trigger) = LOWER($2)";

#[derive(Debug, Clone)]
pub struct ExpandedReward {
    pub reward_type: String,
    pub id: String,
    pub qty: f64,
}

async fn grant_pass_rewards<C: GenericClient>(
    client: &C,
    user_id: i64,
    pass_id: &str,
    season_id: &str,
) -> Result<(), LuckyBoxError> {
    let uid_pg = pg_user_id(user_id).map_err(LuckyBoxError::transport)?;
    let rewards = client
        .query(SELECT_PASS_REWARDS_SQL, &[&pass_id])
        .await
        .map_err(LuckyBoxError::transport)?;

    for r in &rewards {
        let ty: String = r.get("type");
        let qty: f64 = r.get("qty");
        if !qty.is_finite() || qty == 0.0 {
            continue;
        }
        if ty == "currency" {
            let coin_id: Option<String> = r.get("coin_id");
            let cid = coin_id.unwrap_or_default();
            if cid == "usdc" {
                client
                    .execute(INC_USDC_SQL, &[&uid_pg, &qty])
                    .await
                    .map_err(LuckyBoxError::transport)?;
            } else if !cid.is_empty() {
                client
                    .execute(UPSERT_COIN_SQL, &[&uid_pg, &cid, &qty])
                    .await
                    .map_err(LuckyBoxError::transport)?;
            }
        } else if ty == "item" {
            let item_id: Option<String> = r.get("item_id");
            let iid = item_id.unwrap_or_default();
            let q = qty.floor() as i64;
            if !iid.is_empty() && q > 0 {
                credit_stock(client, user_id, &iid, q, None, None)
                    .await
                    .map_err(LuckyBoxError::transport)?;
            }
        }
    }

    let pass_t = pass_id.trim();
    let season_t = format!("season:{}", season_id.trim());
    let boxes = client
        .query(SELECT_PASS_BOXES_SQL, &[&pass_t, &season_t])
        .await
        .map_err(LuckyBoxError::transport)?;
    for b in &boxes {
        let id: String = b.get("id");
        let one: i32 = 1;
        client
            .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &id, &one])
            .await
            .map_err(LuckyBoxError::transport)?;
    }
    Ok(())
}

pub async fn grant_admin_upgrade_rewards<C: GenericClient>(
    client: &C,
    user_id: i64,
    upgrade_id: &str,
    now_ms: i64,
) -> Result<(), LuckyBoxError> {
    let uid_pg = pg_user_id(user_id).map_err(LuckyBoxError::transport)?;
    let rows = client
        .query(SELECT_ADMIN_UPGRADE_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(upgrade) = rows.first() else {
        return Err(LuckyBoxError::domain_code(
            HTTP_CONFLICT,
            ERR_UPGRADE_NOT_FOUND,
            CODE_UPGRADE_NOT_FOUND,
        ));
    };

    let grant_usdc: Option<f64> = upgrade.get("grant_usdc");
    if let Some(u) = grant_usdc {
        if u.is_finite() && u > 0.0 {
            client
                .execute(INC_USDC_SQL, &[&uid_pg, &u])
                .await
                .map_err(LuckyBoxError::transport)?;
        }
    }

    let coins = client
        .query(SELECT_ADMIN_COINS_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for c in &coins {
        let coin_id: String = c.get("coin_id");
        let amt: f64 = c.get("amount");
        if !amt.is_finite() || amt == 0.0 {
            continue;
        }
        client
            .execute(UPSERT_COIN_SQL, &[&uid_pg, &coin_id, &amt])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    let items = client
        .query(SELECT_ADMIN_ITEMS_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for it in &items {
        let item_id: String = it.get("item_id");
        let qty: i32 = it.get("qty");
        let q = i64::from(qty);
        if q <= 0 {
            continue;
        }
        credit_stock(client, user_id, &item_id, q, None, None)
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    let boxes = client
        .query(SELECT_ADMIN_BOXES_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for b in &boxes {
        let box_id: String = b.get("box_id");
        let qty: i32 = b.get("qty");
        if qty <= 0 {
            continue;
        }
        client
            .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &box_id, &qty])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    let passes = client
        .query(SELECT_ADMIN_PASSES_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for p in &passes {
        let pass_id: String = p.get("pass_id");
        let season_rows = client
            .query(SELECT_PASS_SEASON_SQL, &[&pass_id])
            .await
            .map_err(LuckyBoxError::transport)?;
        let Some(season_row) = season_rows.first() else {
            continue;
        };
        let season_id: String = season_row.get("season_id");
        client
            .execute(
                INSERT_SEASON_PURCHASE_SQL,
                &[&uid_pg, &pass_id, &season_id, &now_ms],
            )
            .await
            .map_err(LuckyBoxError::transport)?;
        grant_pass_rewards(client, user_id, &pass_id, &season_id).await?;
    }

    let al: Option<String> = upgrade.get("grant_access_level_id");
    if let Some(alid) = al.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        client
            .execute(UPDATE_USER_ACCESS_SQL, &[&uid_pg, &alid])
            .await
            .map_err(LuckyBoxError::transport)?;
        client
            .execute(INSERT_USER_ACCESS_SQL, &[&uid_pg, &alid, &now_ms])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    let box_rewards = client
        .query(SELECT_BOXES_BY_TRIGGER_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for box_row in &box_rewards {
        let id: String = box_row.get("id");
        let one: i32 = 1;
        client
            .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &id, &one])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    if upgrade_id == GENESIS_BUNDLE_UPGRADE_ID {
        let room = client
            .query(SELECT_RIG_ROOM_SQL, &[&GENESIS_ROOM_ID])
            .await
            .map_err(LuckyBoxError::transport)?;
        if room.is_empty() {
            tracing::error!(
                event = "genesis_bundle_room_missing",
                upgrade_id,
                room_id = GENESIS_ROOM_ID,
                user_id,
                "GENESIS_ROOM_ID missing — confirm seed"
            );
        }
        client
            .execute(
                INSERT_USER_RIG_ROOM_SQL,
                &[
                    &uid_pg,
                    &GENESIS_ROOM_ID,
                    &now_ms,
                    &GENESIS_ROOM_UNLOCKED_SLOTS,
                ],
            )
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    Ok(())
}

pub async fn expand_admin_upgrade_bundle<C: GenericClient>(
    client: &C,
    upgrade_id: &str,
    multiplier: f64,
) -> Result<Vec<ExpandedReward>, LuckyBoxError> {
    let m = multiplier.floor().max(0.0) as i64;
    if m <= 0 {
        return Ok(Vec::new());
    }
    let rows = client
        .query(SELECT_ADMIN_UPGRADE_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(upgrade) = rows.first() else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    let usdc: Option<f64> = upgrade.get("grant_usdc");
    if let Some(u) = usdc {
        if u.is_finite() && u > 0.0 {
            out.push(ExpandedReward {
                reward_type: "currency".into(),
                id: "usdc".into(),
                qty: u * m as f64,
            });
        }
    }

    let items = client
        .query(SELECT_ADMIN_ITEMS_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for it in &items {
        let item_id: String = it.get("item_id");
        let qty: i32 = it.get("qty");
        if qty <= 0 {
            continue;
        }
        out.push(ExpandedReward {
            reward_type: "item".into(),
            id: item_id,
            qty: f64::from(qty) * m as f64,
        });
    }

    let coins = client
        .query(SELECT_ADMIN_COINS_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for c in &coins {
        let coin_id: String = c.get("coin_id");
        let amt: f64 = c.get("amount");
        if !amt.is_finite() || amt == 0.0 {
            continue;
        }
        out.push(ExpandedReward {
            reward_type: "coin".into(),
            id: coin_id,
            qty: amt * m as f64,
        });
    }

    let boxes = client
        .query(SELECT_ADMIN_BOXES_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for b in &boxes {
        let box_id: String = b.get("box_id");
        let qty: i32 = b.get("qty");
        if qty <= 0 {
            continue;
        }
        out.push(ExpandedReward {
            reward_type: "box".into(),
            id: box_id,
            qty: f64::from(qty) * m as f64,
        });
    }

    let passes = client
        .query(SELECT_ADMIN_PASSES_SQL, &[&upgrade_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    for p in &passes {
        let pass_id: String = p.get("pass_id");
        out.push(ExpandedReward {
            reward_type: "pass".into(),
            id: pass_id,
            qty: m as f64,
        });
    }

    let al: Option<String> = upgrade.get("grant_access_level_id");
    if let Some(alid) = al.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        out.push(ExpandedReward {
            reward_type: "access_level".into(),
            id: alid,
            qty: m as f64,
        });
    }

    Ok(out)
}
