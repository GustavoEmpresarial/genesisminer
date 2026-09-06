//! Referral sender USDC credit when referred user verifies email.
//!
//! Mirrors Node `creditReferralBonusOnEmailVerified` (idempotent via
//! `game_states.referral_bonus_claimed` on the verified user).

use deadpool_postgres::{GenericClient, Pool};
use serde::Serialize;

use crate::config::{current_unix_ms, WALLET_LOCK_TIMEOUT_MS};
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;

/// Node `DEFAULT_REFERRAL_SENDER_REWARD_USDC`.
const DEFAULT_REFERRAL_SENDER_REWARD_USDC: f64 = 1.0;
/// Node `REFERRAL_BONUS_CLAIMED` / `REFERRAL_BONUS_NOT_CLAIMED`.
const REFERRAL_BONUS_CLAIMED: i32 = 1;
const REFERRAL_BONUS_NOT_CLAIMED: i32 = 0;
/// Node `DEFAULT_ACCESS_LEVEL_ID`.
const DEFAULT_ACCESS_LEVEL_ID: &str = "normal";
/// Active referral model flag.
const REFERRAL_MODEL_ACTIVE: i32 = 1;

pub const REFERRAL_CREDIT_PATH: &str = "/v1/wallet/referral/credit-on-email-verified";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralCreditOk {
    pub ok: bool,
    /// True when no credit was needed (no link / already claimed / zero reward marked).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credited_usdc: Option<f64>,
}

pub async fn run_referral_credit_on_email_verified(
    pool: &Pool,
    verified_user_id: i64,
    server_now_ms: Option<i64>,
) -> Result<ReferralCreditOk, WalletError> {
    if verified_user_id <= 0 {
        return Err(WalletError::unauthorized("Sessão necessária."));
    }
    let now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(verified_user_id).map_err(WalletError::transport)?;

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let out = match run_inner(&tx, uid, verified_user_id, now).await {
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
    verified_uid: i32,
    verified_user_id: i64,
    now_ms: i64,
) -> Result<ReferralCreditOk, WalletError> {
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {WALLET_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WalletError::transport)?;

    let user_rows = client
        .query(
            "SELECT username, referred_by FROM users WHERE id = $1",
            &[&verified_uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(user) = user_rows.first() else {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    };
    let username: Option<String> = user.get("username");
    let referred_by: Option<String> = user.get("referred_by");
    let username = username.unwrap_or_default().trim().to_string();
    let referred_by = referred_by.unwrap_or_default().trim().to_string();
    if username.is_empty() || referred_by.is_empty() {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    }

    let referrer_rows = client
        .query(
            "SELECT id, access_level_id FROM users
              WHERE lower(referral_code) = lower($1)
              LIMIT 1",
            &[&referred_by],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(referrer) = referrer_rows.first() else {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    };
    let referrer_id: i32 = referrer.get("id");
    if i64::from(referrer_id) == verified_user_id {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    }
    let access_level_id: Option<String> = referrer.get("access_level_id");
    let access_level_id = access_level_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ACCESS_LEVEL_ID.to_string());

    let link_rows = client
        .query(
            "SELECT 1 FROM referrals WHERE user_id = $1 AND referred_username = $2 LIMIT 1",
            &[&referrer_id, &username],
        )
        .await
        .map_err(WalletError::transport)?;
    if link_rows.is_empty() {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    }

    // FOR UPDATE: race of two email confirms must not pay USDC twice.
    let claimed_rows = client
        .query(
            "SELECT referral_bonus_claimed FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&verified_uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let already = claimed_rows
        .first()
        .and_then(|r| r.get::<_, Option<i32>>("referral_bonus_claimed"))
        .unwrap_or(0);
    if already == REFERRAL_BONUS_CLAIMED {
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    }

    let sender_usdc = resolve_sender_reward(client, &access_level_id).await?;

    if !(sender_usdc > 0.0) {
        upsert_verified_claimed(client, verified_uid, now_ms).await?;
        return Ok(ReferralCreditOk {
            ok: true,
            skipped: Some(true),
            credited_usdc: None,
        });
    }

    client
        .query(
            "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&referrer_id],
        )
        .await
        .map_err(WalletError::transport)?;

    // Upsert referrer credit (Node game_states.upsert increment).
    let upd = client
        .execute(
            "UPDATE game_states
                SET usdc = COALESCE(usdc, 0) + $2, last_updated_at = $3
              WHERE user_id = $1",
            &[&referrer_id, &sender_usdc, &now_ms],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd == 0 {
        client
            .execute(
                "INSERT INTO game_states (
                   user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
                   last_updated_at, black_market_balance
                 ) VALUES ($1, $2, $3, 0, $4, $3, 0)
                 ON CONFLICT (user_id) DO UPDATE
                   SET usdc = COALESCE(game_states.usdc, 0) + EXCLUDED.usdc,
                       last_updated_at = EXCLUDED.last_updated_at",
                &[
                    &referrer_id,
                    &sender_usdc,
                    &now_ms,
                    &REFERRAL_BONUS_NOT_CLAIMED,
                ],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    upsert_verified_claimed(client, verified_uid, now_ms).await?;

    Ok(ReferralCreditOk {
        ok: true,
        skipped: None,
        credited_usdc: Some(sender_usdc),
    })
}

async fn resolve_sender_reward<C: GenericClient>(
    client: &C,
    access_level_id: &str,
) -> Result<f64, WalletError> {
    let link = client
        .query(
            "SELECT referral_model_id FROM access_level_referral_models WHERE access_level_id = $1",
            &[&access_level_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(row) = link.first() else {
        return Ok(DEFAULT_REFERRAL_SENDER_REWARD_USDC);
    };
    let model_id: Option<i32> = row.get("referral_model_id");
    let Some(mid) = model_id else {
        return Ok(DEFAULT_REFERRAL_SENDER_REWARD_USDC);
    };
    let models = client
        .query(
            "SELECT sender_reward_usdc::float8 AS sender_reward_usdc
               FROM referral_models WHERE id = $1 AND is_active = $2",
            &[&mid, &REFERRAL_MODEL_ACTIVE],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(m) = models.first() else {
        return Ok(DEFAULT_REFERRAL_SENDER_REWARD_USDC);
    };
    Ok(m.get::<_, Option<f64>>("sender_reward_usdc").unwrap_or(0.0))
}

async fn upsert_verified_claimed<C: GenericClient>(
    client: &C,
    verified_uid: i32,
    now_ms: i64,
) -> Result<(), WalletError> {
    let upd = client
        .execute(
            "UPDATE game_states
                SET referral_bonus_claimed = $2, last_updated_at = $3
              WHERE user_id = $1",
            &[&verified_uid, &REFERRAL_BONUS_CLAIMED, &now_ms],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd == 0 {
        client
            .execute(
                "INSERT INTO game_states (
                   user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
                   last_updated_at, black_market_balance
                 ) VALUES ($1, 0, $2, 0, $3, $2, 0)
                 ON CONFLICT (user_id) DO UPDATE
                   SET referral_bonus_claimed = EXCLUDED.referral_bonus_claimed,
                       last_updated_at = EXCLUDED.last_updated_at",
                &[&verified_uid, &now_ms, &REFERRAL_BONUS_CLAIMED],
            )
            .await
            .map_err(WalletError::transport)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_node() {
        assert_eq!(DEFAULT_REFERRAL_SENDER_REWARD_USDC, 1.0);
        assert_eq!(REFERRAL_BONUS_CLAIMED, 1);
        assert_eq!(DEFAULT_ACCESS_LEVEL_ID, "normal");
    }
}
