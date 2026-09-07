//! Admin balance writes — absolute `coin_balances` SET + save-game USDC/coins.
//!
//! Mirrors Node `setAdminCoinBalance` and the money parts of
//! `applyAdminSaveGameOverride`. Auth stays in Node; this worker only runs PG.

use std::collections::HashMap;

use deadpool_postgres::{GenericClient, Pool};
use serde::Serialize;

use crate::config::current_unix_ms;
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;

/// Node `COIN_ID_MAX` in admin-coin-balance / admin-game-state.
const COIN_ID_MAX: usize = 128;

const ERR_SET_FIELDS: &str = "Missing fields: userId, coinId, amount";
const ERR_SAVE_USER: &str = "Invalid user id.";
const ERR_SAVE_EMPTY: &str = "No balance changes.";

pub const ADMIN_SET_COIN_BALANCE_PATH: &str = "/v1/wallet/admin/coin-balance/set";
pub const ADMIN_SAVE_GAME_BALANCES_PATH: &str = "/v1/wallet/admin/save-game-balances";
pub const ADMIN_BULK_COIN_BALANCE_PATH: &str = "/v1/wallet/admin/coin-balance/bulk";

const ERR_BULK_FIELDS: &str = "Campos ausentes: coinId, amount";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBalancesOk {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBulkCoinBalanceOk {
    pub ok: bool,
    pub count: i64,
}

fn parse_user_id(raw: i64) -> Result<i32, WalletError> {
    if raw <= 0 {
        return Err(WalletError::bad(ERR_SET_FIELDS));
    }
    pg_user_id(raw).map_err(|_| WalletError::bad(ERR_SET_FIELDS))
}

fn parse_coin_id(raw: &str) -> Result<String, WalletError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > COIN_ID_MAX {
        return Err(WalletError::bad(ERR_SET_FIELDS));
    }
    Ok(id.to_string())
}

fn parse_finite_amount(raw: f64) -> Result<f64, WalletError> {
    if !raw.is_finite() {
        return Err(WalletError::bad(ERR_SET_FIELDS));
    }
    Ok(raw)
}

/// Absolute SET (`ON CONFLICT … amount = EXCLUDED.amount`) — legacy AdminRanking.
pub async fn run_admin_set_coin_balance(
    pool: &Pool,
    user_id: i64,
    coin_id: &str,
    amount: f64,
) -> Result<AdminBalancesOk, WalletError> {
    let uid = parse_user_id(user_id)?;
    let coin_id = parse_coin_id(coin_id)?;
    let amount = parse_finite_amount(amount)?;

    let client = pool.get().await.map_err(WalletError::transport)?;
    client
        .execute(
            "INSERT INTO coin_balances (user_id, coin_id, amount)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, coin_id)
             DO UPDATE SET amount = EXCLUDED.amount",
            &[&uid, &coin_id, &amount],
        )
        .await
        .map_err(WalletError::transport)?;

    Ok(AdminBalancesOk { ok: true })
}

/// Bulk increment (`±amount`, floored at 0) over active miners of the coin
/// ∪ holders with balance > 0. Mirrors Node `runAdminBulkUpdateCoinBalance`.
pub async fn run_admin_bulk_coin_balance(
    pool: &Pool,
    coin_id: &str,
    amount: f64,
) -> Result<AdminBulkCoinBalanceOk, WalletError> {
    let coin_id = {
        let id = coin_id.trim();
        if id.is_empty() || id.len() > COIN_ID_MAX {
            return Err(WalletError::bad(ERR_BULK_FIELDS));
        }
        id.to_string()
    };
    if !amount.is_finite() {
        return Err(WalletError::bad(ERR_BULK_FIELDS));
    }

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;
    let out = match run_bulk_coin_balance_inner(&tx, &coin_id, amount).await {
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

async fn run_bulk_coin_balance_inner<C: GenericClient>(
    client: &C,
    coin_id: &str,
    amount: f64,
) -> Result<AdminBulkCoinBalanceOk, WalletError> {
    let user_rows = client
        .query(
            "SELECT DISTINCT user_id
               FROM placed_racks
              WHERE is_on = 1
                AND wiring_id IS NOT NULL
                AND battery_id IS NOT NULL
                AND selected_coin_id = $1
             UNION
             SELECT user_id FROM coin_balances WHERE coin_id = $1 AND amount > 0",
            &[&coin_id],
        )
        .await
        .map_err(WalletError::transport)?;

    let user_ids: Vec<i32> = user_rows
        .iter()
        .filter_map(|r| {
            let id: i32 = r.get("user_id");
            if id > 0 {
                Some(id)
            } else {
                None
            }
        })
        .collect();

    if !user_ids.is_empty() {
        client
            .execute(
                "INSERT INTO coin_balances (user_id, coin_id, amount)
                 SELECT u, $2, GREATEST(0, $3::double precision) FROM unnest($1::int[]) AS u
                 ON CONFLICT (user_id, coin_id)
                 DO UPDATE SET amount = GREATEST(0, coin_balances.amount + $3::double precision)",
                &[&user_ids, &coin_id, &amount],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    Ok(AdminBulkCoinBalanceOk {
        ok: true,
        count: user_ids.len() as i64,
    })
}

fn normalize_coin_balances(raw: &HashMap<String, f64>) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for (raw_id, raw_amount) in raw {
        let coin_id = raw_id.trim();
        if coin_id.is_empty() || coin_id.len() > COIN_ID_MAX {
            continue;
        }
        if !raw_amount.is_finite() {
            continue;
        }
        out.push((coin_id.to_string(), *raw_amount));
    }
    out
}

/// USDC absolute SET + optional coin_balances map from admin save-game override.
pub async fn run_admin_save_game_balances(
    pool: &Pool,
    user_id: i64,
    usdc: Option<f64>,
    coin_balances: Option<HashMap<String, f64>>,
    server_now_ms: Option<i64>,
) -> Result<AdminBalancesOk, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::bad_code(ERR_SAVE_USER, "VALIDATION"));
    }
    let uid =
        pg_user_id(user_id).map_err(|_| WalletError::bad_code(ERR_SAVE_USER, "VALIDATION"))?;

    let usdc = match usdc {
        Some(n) if n.is_finite() => Some(n),
        Some(_) => {
            return Err(WalletError::bad_code(ERR_SAVE_USER, "VALIDATION"));
        }
        None => None,
    };
    let coins = coin_balances
        .as_ref()
        .map(normalize_coin_balances)
        .unwrap_or_default();

    if usdc.is_none() && coins.is_empty() {
        return Err(WalletError::bad_code(ERR_SAVE_EMPTY, "VALIDATION"));
    }

    let now_ms = server_now_ms.unwrap_or_else(current_unix_ms);

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    match run_save_game_balances_inner(&tx, uid, usdc, &coins, now_ms).await {
        Ok(o) => {
            tx.commit().await.map_err(WalletError::transport)?;
            Ok(o)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn run_save_game_balances_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    usdc: Option<f64>,
    coins: &[(String, f64)],
    now_ms: i64,
) -> Result<AdminBalancesOk, WalletError> {
    if let Some(usdc_val) = usdc {
        client
            .execute(
                "INSERT INTO game_states (user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed, last_updated_at, server_updated_at, black_market_balance)
                 VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
                 ON CONFLICT (user_id) DO NOTHING",
                &[&uid, &now_ms],
            )
            .await
            .map_err(WalletError::transport)?;
        client
            .query(
                "SELECT 1 FROM game_states WHERE user_id = $1 FOR UPDATE",
                &[&uid],
            )
            .await
            .map_err(WalletError::transport)?;
        client
            .execute(
                "UPDATE game_states SET usdc = $2 WHERE user_id = $1",
                &[&uid, &usdc_val],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    for (coin_id, amount) in coins {
        client
            .execute(
                "INSERT INTO coin_balances (user_id, coin_id, amount)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, coin_id)
                 DO UPDATE SET amount = EXCLUDED.amount",
                &[&uid, coin_id, amount],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    Ok(AdminBalancesOk { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_user_id_rejects_non_positive() {
        assert!(parse_user_id(0).is_err());
        assert!(parse_user_id(-1).is_err());
        assert_eq!(parse_user_id(7).unwrap(), 7);
    }

    #[test]
    fn parse_coin_id_bounds() {
        assert!(parse_coin_id("").is_err());
        assert!(parse_coin_id("   ").is_err());
        assert!(parse_coin_id(&"x".repeat(COIN_ID_MAX + 1)).is_err());
        assert_eq!(parse_coin_id("btc").unwrap(), "btc");
    }

    #[test]
    fn parse_amount_rejects_non_finite() {
        assert!(parse_finite_amount(f64::NAN).is_err());
        assert!(parse_finite_amount(f64::INFINITY).is_err());
        assert_eq!(parse_finite_amount(-2.0).unwrap(), -2.0);
    }

    #[test]
    fn normalize_skips_bad_coin_entries() {
        let mut m = HashMap::new();
        m.insert("btc".into(), 1.5);
        m.insert("".into(), 9.0);
        m.insert("x".repeat(COIN_ID_MAX + 1), 1.0);
        m.insert("eth".into(), f64::NAN);
        let out = normalize_coin_balances(&m);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], ("btc".to_string(), 1.5));
    }
}
