//! Promo wheel roll — Node `wheelRollInTransaction`.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::market::assert_active_user;
use crate::market::errors::MarketError;
use crate::pg_types::pg_user_id;

use super::errors::{
    WheelError, ERR_CODE_FULLY_USED, ERR_CODE_NO_WHEEL, ERR_INVALID_OR_MISSING_CODE,
    ERR_INVALID_SESSION, ERR_MUST_REDEEM_FIRST, ERR_ROLL_CONFLICT, ERR_WHEEL_CONFIG_NOT_FOUND,
};
use super::paid_spin::{
    load_prizes_eligible_for_roll, pick_weighted_prize, query_prize_by_item_id, WheelPrizeDto,
};
use super::promo_code::{
    normalize_promo_code, promo_code_row_eligible_for_roleta_flow, throw_if_promo_code_expired,
};
use super::promo_redeem::{set_promo_tx_timeouts, LOCK_TIMEOUT_MS};

pub const WHEEL_ROLL_PATH: &str = "/v1/wheel/roll";

const SELECT_REDEMPTION_FOR_UPDATE_SQL: &str = "SELECT reward_granted, won_item_id
     FROM promo_code_redemptions WHERE code = $1 AND user_id = $2 FOR UPDATE";
const SELECT_PROMO_META_SQL: &str =
    "SELECT type, loot_box_id, expires_at FROM promo_codes WHERE code = $1 LIMIT 1";
const UPDATE_WON_SQL: &str = "UPDATE promo_code_redemptions
     SET won_item_id = $3, roulette_rolled_at = $4
     WHERE code = $1 AND user_id = $2 AND won_item_id IS NULL AND reward_granted = 0";
const SELECT_WON_AGAIN_SQL: &str =
    "SELECT won_item_id FROM promo_code_redemptions WHERE code = $1 AND user_id = $2";

#[derive(Debug, Clone)]
pub struct WheelRollOutcome {
    pub won_item_id: String,
    pub item: Option<WheelPrizeDto>,
    /// True when `won_item_id` already existed (Node `idempotent`).
    #[allow(dead_code)]
    pub idempotent: bool,
}

impl WheelRollOutcome {
    pub fn to_json(&self) -> Value {
        let item = self.item.as_ref().map(|p| {
            json!({
                "id": p.id,
                "label": p.label,
                "weight": p.weight,
                "color": p.color,
                "item_id": p.item_id,
                "image": p.image,
            })
        });
        json!({
            "ok": true,
            "wonItemId": self.won_item_id,
            "item": item,
        })
    }
}

fn market_to_wheel(e: MarketError) -> WheelError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => WheelError::Domain {
            status,
            error,
            code,
        },
        MarketError::Transport(err) => WheelError::Transport(err),
    }
}

pub async fn wheel_roll_in_transaction<C: GenericClient>(
    client: &C,
    user_id: i64,
    normalized_code: &str,
    server_now_ms: i64,
) -> Result<WheelRollOutcome, WheelError> {
    let uid_pg = pg_user_id(user_id).map_err(WheelError::transport)?;
    // Node `spin.ts` sets lock_timeout again inside the txn body.
    client
        .execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"), &[])
        .await
        .map_err(WheelError::transport)?;

    let red_res = client
        .query(
            SELECT_REDEMPTION_FOR_UPDATE_SQL,
            &[&normalized_code, &uid_pg],
        )
        .await
        .map_err(WheelError::transport)?;
    let Some(redemption) = red_res.first() else {
        return Err(WheelError::bad(ERR_MUST_REDEEM_FIRST));
    };
    let reward_granted: Option<i32> = redemption.get("reward_granted");
    if reward_granted == Some(1) {
        return Err(WheelError::bad(ERR_CODE_FULLY_USED));
    }

    let prow_rows = client
        .query(SELECT_PROMO_META_SQL, &[&normalized_code])
        .await
        .map_err(WheelError::transport)?;
    if let Some(prow) = prow_rows.first() {
        let expires_at: Option<i64> = prow.get("expires_at");
        throw_if_promo_code_expired(expires_at, server_now_ms)?;
        let promo_type: String = prow.get("type");
        let loot_box_id: Option<String> = prow.get("loot_box_id");
        let wheel_ok =
            promo_code_row_eligible_for_roleta_flow(client, &promo_type, loot_box_id.as_deref())
                .await?;
        if !wheel_ok {
            return Err(WheelError::bad(ERR_CODE_NO_WHEEL));
        }
    } else {
        return Err(WheelError::bad(ERR_CODE_NO_WHEEL));
    }

    let existing_won: Option<String> = redemption.get("won_item_id");
    if let Some(wid) = existing_won.filter(|s| !s.is_empty()) {
        let item = query_prize_by_item_id(client, &wid).await?;
        return Ok(WheelRollOutcome {
            won_item_id: wid,
            item,
            idempotent: true,
        });
    }

    let prizes = load_prizes_eligible_for_roll(client).await?;
    if prizes.is_empty() {
        return Err(WheelError::internal(ERR_WHEEL_CONFIG_NOT_FOUND));
    }
    let selected = pick_weighted_prize(&prizes)?;
    let selected_item_id = selected.item_id.clone();
    let selected_item = selected.clone();

    let upd = client
        .execute(
            UPDATE_WON_SQL,
            &[&normalized_code, &uid_pg, &selected_item_id, &server_now_ms],
        )
        .await
        .map_err(WheelError::transport)?;
    if upd == 0 {
        let again = client
            .query(SELECT_WON_AGAIN_SQL, &[&normalized_code, &uid_pg])
            .await
            .map_err(WheelError::transport)?;
        if let Some(row) = again.first() {
            let wid: Option<String> = row.get("won_item_id");
            if let Some(wid) = wid.filter(|s| !s.is_empty()) {
                let item = query_prize_by_item_id(client, &wid).await?;
                return Ok(WheelRollOutcome {
                    won_item_id: wid,
                    item,
                    idempotent: true,
                });
            }
        }
        return Err(WheelError::conflict(ERR_ROLL_CONFLICT));
    }

    Ok(WheelRollOutcome {
        won_item_id: selected_item_id,
        item: Some(selected_item),
        idempotent: false,
    })
}

pub async fn roll(
    pool: &Pool,
    user_id: i64,
    code: &str,
    server_now_ms: Option<i64>,
) -> Result<WheelRollOutcome, WheelError> {
    if user_id <= 0 {
        return Err(WheelError::unauthorized(ERR_INVALID_SESSION));
    }
    let Some(normalized) = normalize_promo_code(code) else {
        return Err(WheelError::bad(ERR_INVALID_OR_MISSING_CODE));
    };
    let now_ms = server_now_ms
        .filter(|n| *n > 0)
        .unwrap_or_else(current_unix_ms);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(WheelError::transport)?;
    set_promo_tx_timeouts(&tx).await?;
    assert_active_user(&tx, user_id)
        .await
        .map_err(market_to_wheel)?;
    match wheel_roll_in_transaction(&tx, user_id, &normalized, now_ms).await {
        Ok(v) => {
            tx.commit().await.map_err(WheelError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}
