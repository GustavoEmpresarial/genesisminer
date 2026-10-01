//! Elegibilidade check-in premium por gasto USDC vitalício + flag unlock.
//! Espelha `server/modules/checkin/services/premium-policy.ts`.

use genesis_core::checkin::{DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS, DEFAULT_CHECKIN_PREMIUM_MIN_USDC};
use tracing::warn;

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

/// Carrega settings + resolve elegibilidade (igual `load_premium` / progress).
pub async fn resolve_premium_weekly_checkin(
    client: &tokio_postgres::Client,
    user_id: i32,
) -> PremiumWeeklyContext {
    let fallback = PremiumWeeklyContext {
        premium_weekly: false,
        interval_days: DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
        min_usdc: DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
    };

    let setting_keys: Vec<String> = vec![
        "checkin_premium_enabled".to_string(),
        "checkin_premium_min_usdc".to_string(),
        "checkin_premium_interval_days".to_string(),
    ];
    let settings_rows = match client
        .query(
            r#"SELECT key, value FROM settings WHERE key = ANY($1)"#,
            &[&setting_keys],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!(user_id, err = %e, "premium settings query failed — non-premium");
            return fallback;
        }
    };

    let mut enabled_raw: Option<String> = None;
    let mut min_usdc_raw: Option<String> = None;
    let mut interval_days_raw: Option<String> = None;
    for row in &settings_rows {
        let key: String = row.get("key");
        let value: String = row.try_get("value").unwrap_or_default();
        match key.as_str() {
            "checkin_premium_enabled" => enabled_raw = Some(value),
            "checkin_premium_min_usdc" => min_usdc_raw = Some(value),
            "checkin_premium_interval_days" => interval_days_raw = Some(value),
            _ => {}
        }
    }

    let enabled = match enabled_raw.as_deref() {
        None | Some("") => true,
        Some(v) => v == "1",
    };

    let min_parsed = min_usdc_raw
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(DEFAULT_CHECKIN_PREMIUM_MIN_USDC);
    let min_usdc = if min_parsed.is_finite() && min_parsed >= 0.0 {
        min_parsed
    } else {
        DEFAULT_CHECKIN_PREMIUM_MIN_USDC
    };

    let days_parsed = interval_days_raw
        .as_deref()
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS);
    let interval_days = if days_parsed >= 1 {
        days_parsed
    } else {
        DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS
    };

    if !enabled {
        return PremiumWeeklyContext {
            premium_weekly: false,
            interval_days,
            min_usdc,
        };
    }

    let eligible = match user_has_premium_usdc_spend(client, user_id, min_usdc).await {
        Ok(v) => v,
        Err(e) => {
            warn!(
                user_id,
                err = %e,
                "premium USDC spend query failed — non-premium"
            );
            false
        }
    };

    PremiumWeeklyContext {
        premium_weekly: eligible,
        interval_days,
        min_usdc,
    }
}
