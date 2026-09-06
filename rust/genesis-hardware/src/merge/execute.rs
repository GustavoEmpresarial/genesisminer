//! Merge execute — USDC fee + stock adjust + merge_history in one worker TX.
//!
//! Node validates catalog / rarity / stats and sends a closed plan.
//! Stock adjust reuses [`crate::adjust::adjust_stock`] in-process (no HTTP).

use std::collections::HashMap;

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;

use crate::adjust::{adjust_stock, AdjustLine, INSUFFICIENT_STOCK};
use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{assert_active_user, BUY_LOCK_TIMEOUT_MS, TX_BUY_TIMEOUT_MS};
use crate::pg_types::pg_user_id;

/// Node `MERGE_MAX_COUNT` in `server/modules/merge/services/constants.ts`.
pub const MERGE_MAX_COUNT: i32 = 50;
/// Node `FEE_ROUND_FACTOR` in `merge.ts`.
pub const FEE_ROUND_FACTOR: f64 = 100.0;
/// Node `USDC_ROUND_FACTOR` in `merge.ts`.
pub const USDC_ROUND_FACTOR: f64 = 1_000_000.0;
/// Node `USDC_EPSILON`.
pub const USDC_EPSILON: f64 = 1e-9;

pub const MERGE_EXECUTE_PATH: &str = "/v1/merge/execute";

const SELECT_USDC_SQL: &str = "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
const PAY_USDC_SQL: &str =
    "UPDATE game_states SET usdc = $1, last_updated_at = $2, server_updated_at = $2 WHERE user_id = $3 AND usdc >= $4 RETURNING usdc";
const INSERT_HISTORY_SQL: &str = "INSERT INTO merge_history (user_id, source_item_id, result_item_id, source_rarity, result_rarity, fee_usdc, created_at)
         SELECT $1, $2, $3, $4, $5, $6, unnest($7::bigint[])";

#[derive(Debug, Clone)]
pub struct MergeLine {
    pub item_id: String,
    pub qty: i64,
}

#[derive(Debug, Clone)]
pub struct MergeExecuteInput {
    pub user_id: i64,
    pub source_item_id: String,
    pub result_item_id: String,
    pub source_rarity: String,
    pub result_rarity: String,
    pub fee_unit_usdc: f64,
    pub count: i32,
    pub debit: Vec<MergeLine>,
    pub credit: Vec<MergeLine>,
    pub history_timestamps: Option<Vec<i64>>,
}

#[derive(Debug, Clone)]
pub struct MergeExecuteOutcome {
    pub new_usdc: f64,
    pub stock: HashMap<String, i64>,
    pub result_qty: i64,
}

#[derive(Debug)]
pub enum MergeError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
    },
    Transport(anyhow::Error),
}

impl MergeError {
    pub fn bad(code: &str, error: impl Into<String>) -> Self {
        Self::Domain {
            status: 400,
            error: error.into(),
            code: Some(code.to_string()),
        }
    }

    pub fn unprocessable(code: &str, error: impl Into<String>) -> Self {
        Self::Domain {
            status: 422,
            error: error.into(),
            code: Some(code.to_string()),
        }
    }

    pub fn not_found(code: &str, error: impl Into<String>) -> Self {
        Self::Domain {
            status: 404,
            error: error.into(),
            code: Some(code.to_string()),
        }
    }

    pub fn transport(e: impl Into<anyhow::Error>) -> Self {
        Self::Transport(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for MergeError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}

fn market_to_merge(e: MarketError) -> MergeError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => MergeError::Domain {
            status,
            error,
            code,
        },
        MarketError::Transport(err) => MergeError::Transport(err),
    }
}

pub(crate) fn round_fee_total(fee_unit: f64, count: i32) -> f64 {
    ((fee_unit * f64::from(count) * FEE_ROUND_FACTOR).round()) / FEE_ROUND_FACTOR
}

fn round_usdc(v: f64) -> f64 {
    (v * USDC_ROUND_FACTOR).round() / USDC_ROUND_FACTOR
}

pub(crate) async fn set_merge_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), MergeError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_BUY_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MergeError::transport)?;
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {BUY_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(MergeError::transport)?;
    Ok(())
}

pub async fn execute(
    pool: &Pool,
    input: MergeExecuteInput,
) -> Result<MergeExecuteOutcome, MergeError> {
    if input.user_id <= 0 {
        return Err(MergeError::bad("BAD_USER", "Invalid session."));
    }
    if input.count < 1 || input.count > MERGE_MAX_COUNT {
        return Err(MergeError::bad("BAD_COUNT", "Invalid merge count."));
    }
    if !input.fee_unit_usdc.is_finite() || input.fee_unit_usdc < 0.0 {
        return Err(MergeError::bad("BAD_FEE", "Invalid merge fee."));
    }
    let source = input.source_item_id.trim();
    let result = input.result_item_id.trim();
    if source.is_empty() || result.is_empty() {
        return Err(MergeError::bad("BAD_ITEM", "Invalid item."));
    }

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MergeError::transport)?;
    set_merge_tx_timeouts(&tx).await?;
    match execute_on_tx(&tx, &input).await {
        Ok(v) => {
            tx.commit().await.map_err(MergeError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

pub(crate) async fn execute_on_tx<C: GenericClient>(
    client: &C,
    input: &MergeExecuteInput,
) -> Result<MergeExecuteOutcome, MergeError> {
    assert_active_user(client, input.user_id)
        .await
        .map_err(market_to_merge)?;
    let uid_pg = pg_user_id(input.user_id).map_err(MergeError::transport)?;

    let fee_total = round_fee_total(input.fee_unit_usdc, input.count);
    let gs = client
        .query(SELECT_USDC_SQL, &[&uid_pg])
        .await
        .map_err(MergeError::transport)?;
    let Some(row) = gs.first() else {
        return Err(MergeError::not_found("NO_STATE", "Game state not found."));
    };
    let usdc_before: f64 = row.get("usdc");
    if usdc_before + USDC_EPSILON < fee_total {
        return Err(MergeError::unprocessable(
            "INSUFFICIENT_USDC",
            format!(
                "Insufficient USDC. Total fee: {fee_total:.2} ({}× {:.2}).",
                input.count, input.fee_unit_usdc
            ),
        ));
    }
    let usdc_after = round_usdc(usdc_before - fee_total);
    let now = current_unix_ms();
    let pay = client
        .query(PAY_USDC_SQL, &[&usdc_after, &now, &uid_pg, &fee_total])
        .await
        .map_err(MergeError::transport)?;
    if pay.is_empty() {
        return Err(MergeError::unprocessable(
            "INSUFFICIENT_USDC",
            format!("Insufficient USDC. Total fee: {fee_total:.2}."),
        ));
    }
    let new_usdc: f64 = pay[0].get("usdc");

    let debit: Vec<AdjustLine> = input
        .debit
        .iter()
        .map(|l| AdjustLine {
            item_id: l.item_id.clone(),
            qty: l.qty,
        })
        .collect();
    let credit: Vec<AdjustLine> = input
        .credit
        .iter()
        .map(|l| AdjustLine {
            item_id: l.item_id.clone(),
            qty: l.qty,
        })
        .collect();

    let stock = match adjust_stock(client, input.user_id, &debit, &credit).await {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            if msg.starts_with(INSUFFICIENT_STOCK) {
                return Err(MergeError::unprocessable(
                    "INSUFFICIENT_STOCK",
                    "You need at least 2 identical units in stock.",
                ));
            }
            return Err(MergeError::transport(e));
        }
    };

    let timestamps: Vec<i64> = match &input.history_timestamps {
        Some(ts) if !ts.is_empty() => ts.clone(),
        _ => (0..input.count).map(|i| now + i64::from(i)).collect(),
    };
    if timestamps.len() != usize::try_from(input.count).unwrap_or(0) {
        return Err(MergeError::bad(
            "BAD_HISTORY",
            "historyTimestamps length must match count.",
        ));
    }

    client
        .execute(
            INSERT_HISTORY_SQL,
            &[
                &uid_pg,
                &input.source_item_id.trim(),
                &input.result_item_id.trim(),
                &input.source_rarity,
                &input.result_rarity,
                &input.fee_unit_usdc,
                &timestamps,
            ],
        )
        .await
        .map_err(MergeError::transport)?;

    let result_qty = stock
        .get(input.result_item_id.trim())
        .copied()
        .unwrap_or_else(|| i64::from(input.count));

    Ok(MergeExecuteOutcome {
        new_usdc,
        stock,
        result_qty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_round_matches_node() {
        assert_eq!(round_fee_total(1.234, 3), 3.7);
        assert_eq!(round_fee_total(10.0, 1), 10.0);
    }

    #[test]
    fn usdc_round_matches_node() {
        let v = round_usdc(1000.0 - 3.7);
        assert!((v - 996.3).abs() < 1e-9);
    }

    #[test]
    fn merge_max_count_matches_node_constant() {
        assert_eq!(MERGE_MAX_COUNT, 50);
        let src = include_str!("execute.rs");
        let prod = src.split("#[cfg(test)]").next().expect("prod");
        assert!(prod.contains("input.count > MERGE_MAX_COUNT"));
    }

    #[test]
    fn merge_sql_covers_usdc_history_no_http() {
        assert!(PAY_USDC_SQL.contains("usdc >="));
        assert!(INSERT_HISTORY_SQL.contains("merge_history"));
        assert!(INSERT_HISTORY_SQL.contains("unnest"));
        let src = include_str!("execute.rs");
        let prod = src.split("#[cfg(test)]").next().expect("prod");
        assert!(prod.contains("adjust_stock"));
        assert!(!prod.contains("callHardware"));
    }
}
