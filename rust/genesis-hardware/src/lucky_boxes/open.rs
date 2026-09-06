//! Lucky-box open — consume box + roll + credit USDC/coins/items + history/idem in one TX.
//!
//! Mirrors Node `executeLootBoxOpenInTransaction`. Items via `credit_stock` in-process.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use genesis_core::lucky_boxes::{
    roll_grant_all, roll_independent, LootBoxItem, LootRewardGrant, RolledLootPayload,
    PROBABILITY_MAX,
};
use serde_json::json;
use uuid::Uuid;

use crate::config::current_unix_ms;
use crate::market::{
    BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH, TX_BUY_TIMEOUT_MS,
};
use crate::persist::credit_stock;
use crate::pg_types::pg_user_id;

use super::buy::FINGERPRINT_MAX_LENGTH;
use super::errors::{
    LuckyBoxError, ERR_BOX_NOT_FOUND, ERR_GAME_STATE_OPEN, ERR_IDEMPOTENCY_CORRUPT,
    ERR_IDEMPOTENCY_IN_FLIGHT, ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
    ERR_INVALID_SESSION, ERR_NO_BOXES_INVENTORY, ERR_NO_PRIZES_OPEN, ERR_ROLETA_ITEM_MISSING,
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNPROCESSABLE_ENTITY,
};
use super::grant_admin::{expand_admin_upgrade_bundle, grant_admin_upgrade_rewards};

/// Node open scope.
pub const OPEN_SCOPE: &str = "open";
/// Advisory lock label (Node `hashtext('lucky_box_open')`).
pub const OPEN_LOCK_LABEL: &str = "lucky_box_open";
/// Node `REWARD_FOR_ITEM_ID_RE` length bound.
pub const REWARD_ITEM_ID_MAX_LEN: usize = 200;

pub const LUCKY_BOX_OPEN_PATH: &str = "/v1/lucky-boxes/open";

const ADVISORY_LOCK_HASHTEXT_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))";
const SELECT_IDEM_SQL: &str = "SELECT http_status, body_json, request_fingerprint
     FROM lucky_box_idempotency
     WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE";
const INSERT_IDEM_SQL: &str = "INSERT INTO lucky_box_idempotency
     (user_id, scope, idempotency_key, http_status, body_json, created_at, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)";
const SELECT_UNOPENED_SQL: &str =
    "SELECT qty FROM unopened_boxes WHERE user_id = $1 AND box_id = $2 FOR UPDATE";
const DELETE_UNOPENED_SQL: &str = "DELETE FROM unopened_boxes WHERE user_id = $1 AND box_id = $2";
const DECR_UNOPENED_SQL: &str =
    "UPDATE unopened_boxes SET qty = qty - 1 WHERE user_id = $1 AND box_id = $2";
const SELECT_BOX_SQL: &str = "SELECT name, trigger, description FROM loot_boxes WHERE id = $1";
const SELECT_ITEMS_SQL: &str = "SELECT item_type, item_id,
            min_qty::double precision AS min_qty,
            max_qty::double precision AS max_qty,
            probability::double precision AS probability
     FROM loot_box_items WHERE box_id = $1";
const SELECT_UPGRADE_EXISTS_SQL: &str = "SELECT id FROM upgrades WHERE id = $1";
const INSERT_LOOT_ITEM_SQL: &str =
    "INSERT INTO loot_box_items (box_id, item_type, item_id, min_qty, max_qty, probability)
     VALUES ($1, 'item', $2, 1, 1, $3)";
const SELECT_USDC_FOR_UPDATE_SQL: &str =
    "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
const INC_USDC_BONUS_SQL: &str =
    "UPDATE game_states SET usdc = usdc + $2, usdc_bonus = COALESCE(usdc_bonus, 0) + $2 WHERE user_id = $1";
const UPSERT_COIN_SQL: &str =
    "INSERT INTO coin_balances (user_id, coin_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, coin_id) DO UPDATE SET amount = coin_balances.amount + EXCLUDED.amount";
const INSERT_OPENING_SQL: &str = "INSERT INTO lucky_box_openings
     (id, user_id, box_id, rewards_json, gained_usdc, created_at, idempotency_key)
     VALUES ($1, $2, $3, $4::jsonb, $5::numeric, $6, $7)
     RETURNING id";

#[derive(Debug, Clone)]
pub struct OpenReward {
    pub reward_type: String,
    pub id: String,
    pub qty: f64,
}

#[derive(Debug, Clone)]
pub struct OpenOutcome {
    pub rewards: Vec<OpenReward>,
    pub gained_usdc: f64,
    pub box_name: String,
    pub opening_id: String,
    pub cached: bool,
}

fn normalize_idem_key(raw: &str) -> Result<String, LuckyBoxError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(LuckyBoxError::open(
            HTTP_BAD_REQUEST,
            ERR_IDEMPOTENCY_KEY_REQUIRED,
        ));
    }
    Ok(key)
}

fn normalize_fingerprint(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let clipped = if s.len() > FINGERPRINT_MAX_LENGTH {
        s[..FINGERPRINT_MAX_LENGTH].to_string()
    } else {
        s.to_string()
    };
    Some(clipped)
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code().map(|c| c.code() == "23505").unwrap_or(false)
}

fn random_unit() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    let u = u64::from_le_bytes(bytes);
    (u as f64) / (u64::MAX as f64)
}

fn generate_samples(count: usize) -> Vec<f64> {
    (0..count).map(|_| random_unit()).collect()
}

fn samples_needed_independent(eligible: usize) -> usize {
    eligible.saturating_mul(2)
}

fn samples_needed_grant_all(eligible: usize) -> usize {
    eligible
}

fn reward_for_item_id(desc: &str) -> Option<String> {
    // Node `REWARD_FOR_ITEM_ID_RE = /^reward_for_([a-zA-Z0-9_.-]{1,200})$/`
    const PREFIX: &str = "reward_for_";
    if !desc.starts_with(PREFIX) {
        return None;
    }
    let rest = &desc[PREFIX.len()..];
    if rest.is_empty() || rest.len() > REWARD_ITEM_ID_MAX_LEN {
        return None;
    }
    if rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        Some(rest.to_string())
    } else {
        None
    }
}

fn map_loot_item(row: &tokio_postgres::Row) -> LootBoxItem {
    LootBoxItem {
        item_type: row.get("item_type"),
        item_id: row.get("item_id"),
        min_qty: row.get("min_qty"),
        max_qty: row.get("max_qty"),
        probability: row.get("probability"),
    }
}

fn grant_to_open_reward(g: &LootRewardGrant) -> OpenReward {
    OpenReward {
        reward_type: g.reward_type.clone(),
        id: g.id.clone(),
        qty: g.qty,
    }
}

fn rewards_to_json(rewards: &[OpenReward]) -> serde_json::Value {
    json!(rewards
        .iter()
        .map(|r| json!({
            "type": r.reward_type,
            "id": r.id,
            "qty": r.qty,
        }))
        .collect::<Vec<_>>())
}

async fn set_open_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), LuckyBoxError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(LuckyBoxError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(LuckyBoxError::transport)?;
    Ok(())
}

pub async fn open(
    pool: &Pool,
    user_id: i64,
    box_id: &str,
    idempotency_key: &str,
    idempotency_fingerprint: Option<&str>,
) -> Result<OpenOutcome, LuckyBoxError> {
    if user_id <= 0 {
        return Err(LuckyBoxError::unauthorized(ERR_INVALID_SESSION));
    }
    let box_id = box_id.trim();
    if box_id.is_empty() {
        return Err(LuckyBoxError::open(HTTP_NOT_FOUND, ERR_BOX_NOT_FOUND));
    }
    let idem_key = normalize_idem_key(idempotency_key)?;
    let idem_fp = normalize_fingerprint(idempotency_fingerprint);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(LuckyBoxError::transport)?;
    set_open_tx_timeouts(&tx).await?;
    match open_on_tx(&tx, user_id, box_id, &idem_key, idem_fp.as_deref()).await {
        Ok(v) => {
            tx.commit().await.map_err(LuckyBoxError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn open_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    box_id: &str,
    idem_key: &str,
    idem_fp: Option<&str>,
) -> Result<OpenOutcome, LuckyBoxError> {
    let uid_pg = pg_user_id(user_id).map_err(LuckyBoxError::transport)?;
    let lock_payload = format!("{user_id}:{idem_key}");
    client
        .execute(
            ADVISORY_LOCK_HASHTEXT_SQL,
            &[&OPEN_LOCK_LABEL, &lock_payload],
        )
        .await
        .map_err(LuckyBoxError::transport)?;

    let existing = client
        .query(SELECT_IDEM_SQL, &[&uid_pg, &OPEN_SCOPE, &idem_key])
        .await
        .map_err(LuckyBoxError::transport)?;
    if let Some(row) = existing.first() {
        let http_status: i32 = row.get("http_status");
        if http_status >= i32::from(HTTP_OK) && http_status < i32::from(HTTP_BAD_REQUEST) {
            let stored_fp: Option<String> = row.get("request_fingerprint");
            let stored_fp = stored_fp.unwrap_or_default().trim().to_string();
            if !stored_fp.is_empty() {
                if let Some(fp) = idem_fp {
                    if stored_fp != fp {
                        return Err(LuckyBoxError::open(
                            HTTP_CONFLICT,
                            ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
                        ));
                    }
                }
            }
            let body_json: String = row.get("body_json");
            // Fail-closed on corrupt cache — never invent empty opening with cached:true.
            let v: serde_json::Value = serde_json::from_str(&body_json)
                .map_err(|_| LuckyBoxError::open(HTTP_CONFLICT, ERR_IDEMPOTENCY_CORRUPT))?;
            let opening_id = v
                .get("openingId")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| LuckyBoxError::open(HTTP_CONFLICT, ERR_IDEMPOTENCY_CORRUPT))?
                .to_string();
            let rewards = v
                .get("rewards")
                .and_then(|r| r.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| {
                            Some(OpenReward {
                                reward_type: x.get("type")?.as_str()?.to_string(),
                                id: x.get("id")?.as_str()?.to_string(),
                                qty: x.get("qty")?.as_f64()?,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let gained_usdc = v
                .get("gainedUsdc")
                .and_then(|x| x.as_f64())
                .filter(|n| n.is_finite())
                .unwrap_or(0.0);
            return Ok(OpenOutcome {
                rewards,
                gained_usdc,
                box_name: String::new(),
                opening_id,
                cached: true,
            });
        }
    }

    let locked = client
        .query(SELECT_UNOPENED_SQL, &[&uid_pg, &box_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(box_count) = locked.first() else {
        return Err(LuckyBoxError::open(
            HTTP_BAD_REQUEST,
            ERR_NO_BOXES_INVENTORY,
        ));
    };
    let qty: i32 = box_count.get("qty");
    if qty < 1 {
        return Err(LuckyBoxError::open(
            HTTP_BAD_REQUEST,
            ERR_NO_BOXES_INVENTORY,
        ));
    }

    let box_rows = client
        .query(SELECT_BOX_SQL, &[&box_id])
        .await
        .map_err(LuckyBoxError::transport)?;
    let Some(box_def) = box_rows.first() else {
        return Err(LuckyBoxError::open(HTTP_NOT_FOUND, ERR_BOX_NOT_FOUND));
    };
    let box_name: String = box_def.get("name");
    let trigger: String = box_def.get("trigger");
    let description: Option<String> = box_def.get("description");

    let mut item_rows = client
        .query(SELECT_ITEMS_SQL, &[&box_id])
        .await
        .map_err(LuckyBoxError::transport)?;

    if item_rows.is_empty() && trigger.trim() == "roleta_reward" {
        let desc = description.unwrap_or_default();
        if let Some(recovered) = reward_for_item_id(&desc) {
            let exists = client
                .query(SELECT_UPGRADE_EXISTS_SQL, &[&recovered])
                .await
                .map_err(LuckyBoxError::transport)?;
            if exists.first().is_some() {
                client
                    .execute(
                        INSERT_LOOT_ITEM_SQL,
                        &[&box_id, &recovered, &PROBABILITY_MAX],
                    )
                    .await
                    .map_err(LuckyBoxError::transport)?;
                tracing::warn!(
                    event = "roleta_reward_box_repair",
                    box_id,
                    recovered,
                    "repaired empty roleta_reward loot_box_items"
                );
                item_rows = client
                    .query(SELECT_ITEMS_SQL, &[&box_id])
                    .await
                    .map_err(LuckyBoxError::transport)?;
            } else {
                tracing::error!(
                    event = "roleta_reward_box_missing_upgrade",
                    box_id,
                    recovered,
                    "prize box points to missing upgrade — not consuming"
                );
                return Err(LuckyBoxError::open(
                    HTTP_UNPROCESSABLE_ENTITY,
                    ERR_ROLETA_ITEM_MISSING,
                ));
            }
        }
    }

    if item_rows.is_empty() {
        tracing::error!(
            event = "loot_box_open_empty",
            box_id,
            box_name = %box_name,
            "box has no prizes configured"
        );
        return Err(LuckyBoxError::open(
            HTTP_UNPROCESSABLE_ENTITY,
            ERR_NO_PRIZES_OPEN,
        ));
    }

    let items: Vec<LootBoxItem> = item_rows.iter().map(map_loot_item).collect();
    let eligible = items
        .iter()
        .filter(|it| {
            let p = if it.probability.is_finite() {
                it.probability
            } else {
                0.0
            };
            p.max(0.0) > 0.0
        })
        .count();
    let trig = trigger.trim();
    let use_grant_all = trig == "registration" || trig == "upgrade_package";
    let samples = if use_grant_all {
        generate_samples(samples_needed_grant_all(eligible))
    } else {
        generate_samples(samples_needed_independent(eligible))
    };
    let mut rolled: RolledLootPayload = if use_grant_all {
        roll_grant_all(&items, &samples)
            .map_err(|e| LuckyBoxError::transport(anyhow::anyhow!(e)))?
    } else {
        roll_independent(&items, &samples)
            .map_err(|e| LuckyBoxError::transport(anyhow::anyhow!(e)))?
    };

    if qty <= 1 {
        client
            .execute(DELETE_UNOPENED_SQL, &[&uid_pg, &box_id])
            .await
            .map_err(LuckyBoxError::transport)?;
    } else {
        client
            .execute(DECR_UNOPENED_SQL, &[&uid_pg, &box_id])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    let now = current_unix_ms();
    if rolled.gained_usdc > 0.0 {
        let gs = client
            .query(SELECT_USDC_FOR_UPDATE_SQL, &[&uid_pg])
            .await
            .map_err(LuckyBoxError::transport)?;
        if gs.is_empty() {
            return Err(LuckyBoxError::open(
                HTTP_UNPROCESSABLE_ENTITY,
                ERR_GAME_STATE_OPEN,
            ));
        }
        client
            .execute(INC_USDC_BONUS_SQL, &[&uid_pg, &rolled.gained_usdc])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    for (item_id, qty_f) in &rolled.gained_items {
        let q = qty_f.floor() as i64;
        if q <= 0 {
            continue;
        }
        credit_stock(client, user_id, item_id, q, None, None)
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    for (coin_id, qty_f) in &rolled.gained_coins {
        if !qty_f.is_finite() || *qty_f == 0.0 {
            continue;
        }
        client
            .execute(UPSERT_COIN_SQL, &[&uid_pg, coin_id, qty_f])
            .await
            .map_err(LuckyBoxError::transport)?;
    }

    for b in &rolled.gained_bundles {
        let n = b.qty.floor().max(0.0) as i64;
        for _ in 0..n {
            grant_admin_upgrade_rewards(client, user_id, &b.id, now).await?;
        }
    }

    let mut rewards: Vec<OpenReward> = rolled.rewards.iter().map(grant_to_open_reward).collect();
    if !rolled.gained_bundles.is_empty() {
        let mut expanded = Vec::new();
        for r in &rewards {
            if r.reward_type != "bundle" {
                expanded.push(r.clone());
                continue;
            }
            let more = expand_admin_upgrade_bundle(client, &r.id, r.qty).await?;
            for e in more {
                expanded.push(OpenReward {
                    reward_type: e.reward_type,
                    id: e.id,
                    qty: e.qty,
                });
            }
        }
        rewards = expanded;
    }

    let opening_uuid = Uuid::new_v4();
    let opening_id = opening_uuid.to_string();
    let rewards_json = rewards_to_json(&rewards);
    let rewards_str = serde_json::to_string(&rewards_json).map_err(LuckyBoxError::transport)?;
    let gained = if rolled.gained_usdc.is_finite() {
        rolled.gained_usdc
    } else {
        0.0
    };
    client
        .query(
            INSERT_OPENING_SQL,
            &[
                &opening_uuid,
                &uid_pg,
                &box_id,
                &rewards_str,
                &gained,
                &now,
                &idem_key,
            ],
        )
        .await
        .map_err(LuckyBoxError::transport)?;

    let payload = json!({
        "ok": true,
        "rewards": rewards_json,
        "openingId": opening_id,
        "gainedUsdc": gained,
        "version": 1,
    });
    let body_json = serde_json::to_string(&payload).map_err(LuckyBoxError::transport)?;
    let http_ok: i32 = i32::from(HTTP_OK);
    let fp_bind: Option<&str> = idem_fp;
    match client
        .execute(
            INSERT_IDEM_SQL,
            &[
                &uid_pg,
                &OPEN_SCOPE,
                &idem_key,
                &http_ok,
                &body_json,
                &now,
                &fp_bind,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            return Err(LuckyBoxError::open(
                HTTP_CONFLICT,
                ERR_IDEMPOTENCY_IN_FLIGHT,
            ));
        }
        Err(e) => return Err(LuckyBoxError::transport(e)),
    }

    Ok(OpenOutcome {
        rewards,
        gained_usdc: gained,
        box_name,
        opening_id,
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reward_for_regex() {
        assert_eq!(reward_for_item_id("reward_for_gpu_1"), Some("gpu_1".into()));
        assert!(reward_for_item_id("reward_for_").is_none());
        assert!(reward_for_item_id("nope").is_none());
    }

    #[test]
    fn open_sql_guards() {
        assert!(INC_USDC_BONUS_SQL.contains("usdc_bonus"));
        assert!(INSERT_OPENING_SQL.contains("lucky_box_openings"));
    }
}
