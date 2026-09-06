//! Referral commission on P2P buy — Node `runReferralCommissionOnTx` without `console.log`.

use deadpool_postgres::GenericClient;

use crate::pg_types::pg_user_id;

use super::errors::MarketError;
use super::{ACCESS_LEVEL_DEFAULT, PERCENT_DIVISOR};

const SELECT_REFERRER_SQL: &str = "SELECT r.user_id as referrer_id, u.access_level_id
     FROM referrals r
     JOIN users u ON r.user_id = u.id
     WHERE r.referred_username = (SELECT username FROM users WHERE id = $1)";

const SELECT_MODEL_SQL: &str =
    "SELECT m.hardware_commission_percent, m.black_market_commission_percent
     FROM referral_models m
     JOIN access_level_referral_models a ON m.id = a.referral_model_id
     WHERE a.access_level_id = $1 AND m.is_active = 1";

const CREDIT_REFERRER_SQL: &str =
    "UPDATE game_states SET usdc = COALESCE(usdc, 0) + $1 WHERE user_id = $2";

pub async fn run_referral_commission_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    amount: f64,
) -> Result<(), MarketError> {
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let ref_rows = client
        .query(SELECT_REFERRER_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    let Some(row) = ref_rows.first() else {
        return Ok(());
    };
    let referrer_id: i32 = row.get("referrer_id");
    let access_level_id: Option<String> = row.get("access_level_id");
    let al_id = match access_level_id {
        Some(s) if !s.is_empty() => s,
        _ => ACCESS_LEVEL_DEFAULT.to_string(),
    };
    let model_rows = client
        .query(SELECT_MODEL_SQL, &[&al_id])
        .await
        .map_err(MarketError::transport)?;
    let Some(model) = model_rows.first() else {
        return Ok(());
    };
    let commission_percent: f64 = model
        .get::<_, Option<f64>>("black_market_commission_percent")
        .unwrap_or(0.0);
    if !(commission_percent > 0.0) {
        return Ok(());
    }
    let commission_amount = (amount * commission_percent) / PERCENT_DIVISOR;
    if !(commission_amount > 0.0) {
        return Ok(());
    }
    client
        .execute(CREDIT_REFERRER_SQL, &[&commission_amount, &referrer_id])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_has_no_console_and_no_mint() {
        let sql = [SELECT_REFERRER_SQL, SELECT_MODEL_SQL, CREDIT_REFERRER_SQL].join("\n");
        assert!(!sql.contains("console"));
        assert!(!sql.contains("gen_random_uuid"));
        assert!(!sql.contains("consume"));
        assert!(CREDIT_REFERRER_SQL.contains("usdc = COALESCE(usdc, 0) + $1"));
    }
}
