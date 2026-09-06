//! Quest reward claim — mark `user_quest_progress.claimed_at` + USDC credit in one TX.
//!
//! Mirrors Node `server/modules/quests/services/quest.ts` `claimQuestReward`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::checkin::{utc_checkin_period_start_ms, utc_day_from_ms};
use genesis_core::utc_week::utc_week_start_ms;
use serde::Serialize;

use crate::config::{current_unix_ms, WALLET_LOCK_TIMEOUT_MS};
use crate::errors::{
    WalletError, HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE,
};
use crate::pg_types::pg_user_id;

/// Node `REWARD_USDC_DECIMALS`.
const REWARD_USDC_DECIMALS: f64 = 1_000_000.0;
/// Node quest id trim bound (practical).
const QUEST_ID_MAX_LEN: usize = 120;

pub const QUEST_CLAIM_PATH: &str = "/v1/wallet/quests/claim";

pub const CODE_BAD_QUEST: &str = "BAD_QUEST";
pub const CODE_NOT_FOUND: &str = "NOT_FOUND";
pub const CODE_NO_PROGRESS: &str = "NO_PROGRESS";
pub const CODE_INCOMPLETE: &str = "INCOMPLETE";
pub const CODE_ALREADY_CLAIMED: &str = "ALREADY_CLAIMED";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestClaimOk {
    pub ok: bool,
    pub reward_usdc: f64,
    pub new_usdc: f64,
}

fn round_reward_usdc(raw: f64) -> f64 {
    if !raw.is_finite() || raw <= 0.0 {
        return 0.0;
    }
    (raw * REWARD_USDC_DECIMALS).round() / REWARD_USDC_DECIMALS
}

fn quest_period_key(period: &str, now_ms: i64) -> String {
    if period == "weekly" {
        let start = utc_week_start_ms(now_ms);
        format!("w:{}", utc_day_from_ms(start))
    } else {
        let start = utc_checkin_period_start_ms(now_ms);
        format!("d:{}", utc_day_from_ms(start))
    }
}

pub async fn run_quest_claim(
    pool: &Pool,
    user_id: i64,
    quest_id: &str,
    server_now_ms: Option<i64>,
) -> Result<QuestClaimOk, WalletError> {
    let id = quest_id.trim();
    if id.is_empty() || id.len() > QUEST_ID_MAX_LEN {
        return Err(WalletError::domain_code(
            HTTP_BAD_REQUEST,
            "Invalid quest.",
            CODE_BAD_QUEST,
        ));
    }
    if user_id <= 0 {
        return Err(WalletError::unauthorized("Sessão necessária."));
    }
    let now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let out = match run_inner(&tx, uid, id, now).await {
        Ok(o) => {
            tx.commit().await.map_err(WalletError::transport)?;
            o
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };
    Ok(out)
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    quest_id: &str,
    now_ms: i64,
) -> Result<QuestClaimOk, WalletError> {
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {WALLET_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WalletError::transport)?;

    let def_rows = client
        .query(
            "SELECT period, target_count, reward_usdc::float8 AS reward_usdc
               FROM quest_definitions WHERE id = $1 AND enabled = 1",
            &[&quest_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(def) = def_rows.first() else {
        return Err(WalletError::domain_code(
            HTTP_NOT_FOUND,
            "Quest not found.",
            CODE_NOT_FOUND,
        ));
    };
    let period: String = def.get("period");
    let target_count: i32 = def.get("target_count");
    let reward_raw: Option<f64> = def.get("reward_usdc");
    let reward = round_reward_usdc(reward_raw.unwrap_or(0.0));
    let pk = quest_period_key(period.trim(), now_ms);

    let prog_rows = client
        .query(
            "SELECT progress, completed_at, claimed_at FROM user_quest_progress
              WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE",
            &[&uid, &quest_id, &pk],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(prog) = prog_rows.first() else {
        return Err(WalletError::domain_code(
            HTTP_UNPROCESSABLE,
            "No progress on this quest yet.",
            CODE_NO_PROGRESS,
        ));
    };
    let progress_raw: Option<i32> = prog.get("progress");
    let progress = progress_raw.unwrap_or(0).max(0);
    let completed_at: Option<i64> = prog.get("completed_at");
    let claimed_at: Option<i64> = prog.get("claimed_at");
    if progress < target_count && completed_at.is_none() {
        return Err(WalletError::domain_code(
            HTTP_UNPROCESSABLE,
            "Quest still incomplete.",
            CODE_INCOMPLETE,
        ));
    }
    if claimed_at.is_some() {
        return Err(WalletError::domain_code(
            HTTP_CONFLICT,
            "Reward already claimed.",
            CODE_ALREADY_CLAIMED,
        ));
    }

    let claim = client
        .execute(
            "UPDATE user_quest_progress
                SET claimed_at = $4, completed_at = COALESCE(completed_at, $4), updated_at = $4
              WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 AND claimed_at IS NULL",
            &[&uid, &quest_id, &pk, &now_ms],
        )
        .await
        .map_err(WalletError::transport)?;
    if claim == 0 {
        return Err(WalletError::domain_code(
            HTTP_CONFLICT,
            "Reward already claimed.",
            CODE_ALREADY_CLAIMED,
        ));
    }

    client
        .execute(
            "INSERT INTO game_states (
               user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
               last_updated_at, server_updated_at, black_market_balance
             ) VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
             ON CONFLICT (user_id) DO NOTHING",
            &[&uid, &now_ms],
        )
        .await
        .map_err(WalletError::transport)?;

    let new_usdc = if reward > 0.0 {
        let upd = client
            .query(
                "UPDATE game_states
                    SET usdc = usdc + $2, server_updated_at = $3, last_updated_at = $3
                  WHERE user_id = $1
                  RETURNING usdc::float8 AS usdc",
                &[&uid, &reward, &now_ms],
            )
            .await
            .map_err(WalletError::transport)?;
        upd.first()
            .and_then(|r| r.get::<_, Option<f64>>("usdc"))
            .unwrap_or(0.0)
    } else {
        let cur = client
            .query(
                "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
                &[&uid],
            )
            .await
            .map_err(WalletError::transport)?;
        cur.first()
            .and_then(|r| r.get::<_, Option<f64>>("usdc"))
            .unwrap_or(0.0)
    };

    Ok(QuestClaimOk {
        ok: true,
        reward_usdc: reward,
        new_usdc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_reward_matches_node_decimals() {
        assert_eq!(round_reward_usdc(0.05), 0.05);
        assert_eq!(round_reward_usdc(0.0), 0.0);
        assert_eq!(round_reward_usdc(-1.0), 0.0);
    }

    #[test]
    fn period_keys_prefix() {
        let daily = quest_period_key("daily", 1_767_799_800_000);
        assert!(daily.starts_with("d:"));
        let weekly = quest_period_key("weekly", 1_767_799_800_000);
        assert!(weekly.starts_with("w:"));
    }
}
