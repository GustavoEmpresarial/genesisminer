//! Elegibilidade check-in premium (legado).
//!
//! Produto: check-in é **só diário** — `premium_weekly` fica sempre `false`.
//! Settings / unlock / spend permanecem na BD mas são inertes para o cadenciamento.

use genesis_core::checkin::{
    DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS, DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
};

const UNLOCKED_FLAG: i32 = 1;

pub struct PremiumWeeklyContext {
    pub premium_weekly: bool,
    pub interval_days: i32,
    pub min_usdc: f64,
}

const LIFETIME_SPEND_SQL: &str = r#"
SELECT COALESCE(SUM(amt), 0)::float8 AS spent
FROM (
  SELECT total_cost AS amt FROM shop_checkout_idempotency WHERE user_id = $1
  UNION ALL
  SELECT buyer_paid_usdc FROM p2p_market_trade_history WHERE buyer_id = $1
  UNION ALL
  SELECT charged_usdc FROM wheel_spins WHERE user_id = $1 AND COALESCE(charged_usdc, 0) > 0
  UNION ALL
  SELECT fee_usdc FROM merge_history WHERE user_id = $1 AND COALESCE(fee_usdc, 0) > 0
  UNION ALL
  SELECT COALESCE(u.price_usdc, 0)
  FROM admin_upgrade_purchases p
  JOIN admin_upgrades u ON u.id = p.upgrade_id
  WHERE p.user_id = $1
  UNION ALL
  SELECT COALESCE(pass.price_usdc, 0)
  FROM season_purchases sp
  JOIN season_passes pass ON pass.id = sp.pass_id
  WHERE sp.user_id = $1
) s
"#;

/// Se já unlocked OU gasto ≥ min → true; ao cruzar limiar persiste unlock.
/// Mantido para admin/grant legado; o check-in runtime já não usa isto para cadência.
pub async fn user_has_premium_usdc_spend(
    client: &tokio_postgres::Client,
    user_id: i32,
    min_usdc: f64,
) -> Result<bool, tokio_postgres::Error> {
    let unlocked = client
        .query_opt(
            r#"SELECT 1 FROM game_states
               WHERE user_id = $1 AND COALESCE(checkin_premium_unlocked, 0) = $2
               LIMIT 1"#,
            &[&user_id, &UNLOCKED_FLAG],
        )
        .await?
        .is_some();
    if unlocked {
        return Ok(true);
    }

    let spent_row = client.query_one(LIFETIME_SPEND_SQL, &[&user_id]).await?;
    let spent: f64 = spent_row.try_get("spent").unwrap_or(0.0);
    if !(spent.is_finite() && spent >= min_usdc) {
        return Ok(false);
    }

    client
        .execute(
            r#"UPDATE game_states
               SET checkin_premium_unlocked = $2
               WHERE user_id = $1
                 AND COALESCE(checkin_premium_unlocked, 0) <> $2"#,
            &[&user_id, &UNLOCKED_FLAG],
        )
        .await?;
    Ok(true)
}

/// Sempre diário: `premium_weekly` é sempre `false`.
pub async fn resolve_premium_weekly_checkin(
    _client: &tokio_postgres::Client,
    _user_id: i32,
) -> PremiumWeeklyContext {
    PremiumWeeklyContext {
        premium_weekly: false,
        interval_days: DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
        min_usdc: DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
    }
}
