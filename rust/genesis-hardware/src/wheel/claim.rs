//! Roleta claim — Node `roletaClaimInTransaction`.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::market::assert_active_user;
use crate::market::errors::MarketError;
use crate::pg_types::pg_user_id;

use super::errors::{
    WheelError, ERR_CLAIM_FINALIZE, ERR_CLAIM_INTEGRITY, ERR_CODE_NOT_REDEEMED,
    ERR_INVALID_CLAIM_DATA, ERR_INVALID_CODE_TYPE, ERR_INVALID_SESSION, ERR_MUST_SPIN_FIRST,
    ERR_REWARD_ALREADY_CLAIMED,
};
use super::paid_spin::grant_wheel_prize_unopened_box;
use super::promo_code::{
    normalize_promo_code, parse_won_item_id, promo_code_row_eligible_for_roleta_flow,
    throw_if_promo_code_expired,
};
use super::promo_redeem::{set_promo_tx_timeouts, LOCK_TIMEOUT_MS};

pub const ROLETA_CLAIM_PATH: &str = "/v1/roleta/claim";

const SELECT_REDEMPTION_FOR_UPDATE_SQL: &str = "SELECT reward_granted, won_item_id
     FROM promo_code_redemptions WHERE code = $1 AND user_id = $2 FOR UPDATE";
const SELECT_PROMO_META_SQL: &str =
    "SELECT type, loot_box_id, expires_at FROM promo_codes WHERE code = $1 LIMIT 1";
const UPDATE_CLAIM_SQL: &str = "UPDATE promo_code_redemptions
     SET reward_granted = 1, roulette_claimed_at = $3
     WHERE code = $1 AND user_id = $2 AND reward_granted = 0";

#[derive(Debug, Clone)]
pub struct RoletaClaimOutcome {
    pub box_id: String,
    /// Present for Node parity (`RoletaClaimResult.boxName`); API body only exposes `boxId`.
    #[allow(dead_code)]
    pub box_name: String,
}

impl RoletaClaimOutcome {
    pub fn to_json(&self) -> Value {
        json!({ "ok": true, "boxId": self.box_id })
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

pub async fn roleta_claim_in_transaction<C: GenericClient>(
    client: &C,
    user_id: i64,
    normalized_code: &str,
    won_item_id: &str,
    server_now_ms: i64,
) -> Result<RoletaClaimOutcome, WheelError> {
    let uid_pg = pg_user_id(user_id).map_err(WheelError::transport)?;
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
        return Err(WheelError::bad(ERR_CODE_NOT_REDEEMED));
    };
    let reward_granted: Option<i32> = redemption.get("reward_granted");
    if reward_granted == Some(1) {
        return Err(WheelError::bad(ERR_REWARD_ALREADY_CLAIMED));
    }
    let drawn: Option<String> = redemption.get("won_item_id");
    let Some(drawn) = drawn.filter(|s| !s.is_empty()) else {
        return Err(WheelError::bad(ERR_MUST_SPIN_FIRST));
    };
    if drawn != won_item_id {
        return Err(WheelError::forbidden(ERR_CLAIM_INTEGRITY));
    }

    let code_rows = client
        .query(SELECT_PROMO_META_SQL, &[&normalized_code])
        .await
        .map_err(WheelError::transport)?;
    if let Some(promo) = code_rows.first() {
        let expires_at: Option<i64> = promo.get("expires_at");
        throw_if_promo_code_expired(expires_at, server_now_ms)?;
        let promo_type: String = promo.get("type");
        let loot_box_id: Option<String> = promo.get("loot_box_id");
        let claim_ok =
            promo_code_row_eligible_for_roleta_flow(client, &promo_type, loot_box_id.as_deref())
                .await?;
        if !claim_ok {
            return Err(WheelError::bad(ERR_INVALID_CODE_TYPE));
        }
    } else {
        return Err(WheelError::bad(ERR_INVALID_CODE_TYPE));
    }

    let granted = client
        .execute(
            UPDATE_CLAIM_SQL,
            &[&normalized_code, &uid_pg, &server_now_ms],
        )
        .await
        .map_err(WheelError::transport)?;
    if granted == 0 {
        return Err(WheelError::conflict(ERR_CLAIM_FINALIZE));
    }

    let (box_id, box_name) = grant_wheel_prize_unopened_box(client, user_id, won_item_id).await?;
    Ok(RoletaClaimOutcome { box_id, box_name })
}

pub async fn claim(
    pool: &Pool,
    user_id: i64,
    code: &str,
    won_item_id: &str,
    server_now_ms: Option<i64>,
) -> Result<RoletaClaimOutcome, WheelError> {
    if user_id <= 0 {
        return Err(WheelError::unauthorized(ERR_INVALID_SESSION));
    }
    let Some(normalized) = normalize_promo_code(code) else {
        return Err(WheelError::bad(ERR_INVALID_CLAIM_DATA));
    };
    let Some(won) = parse_won_item_id(won_item_id) else {
        return Err(WheelError::bad(ERR_INVALID_CLAIM_DATA));
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
    match roleta_claim_in_transaction(&tx, user_id, &normalized, &won, now_ms).await {
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
