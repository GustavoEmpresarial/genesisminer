//! Reserve / cancel-reserve — same SQL as Node `mutations.ts`.

use deadpool_postgres::Pool;
use genesis_core::market::compute_reserved_until;

use crate::pg_types::pg_user_id;

use super::errors::MarketError;
use super::{current_now_ms, finish_tx, set_market_tx_timeouts};

const RESERVE_SQL: &str = "UPDATE player_listings
      SET reserved_by = $1, reserved_until = $2
      WHERE id = $3 AND status = 'active' AND expires_at > $4
        AND user_id <> $1
        AND (reserved_until IS NULL OR reserved_until < $4 OR reserved_by = $1)
      RETURNING id";

const CANCEL_RESERVE_SQL: &str =
    "UPDATE player_listings SET reserved_by = NULL, reserved_until = NULL
      WHERE id = $1 AND status = 'active' AND reserved_by = $2
      RETURNING id";

pub async fn reserve(pool: &Pool, user_id: i64, listing_id: &str) -> Result<i64, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let now = current_now_ms();
    let until = compute_reserved_until(now);
    let uid = match pg_user_id(user_id) {
        Ok(v) => v,
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(MarketError::transport(e));
        }
    };
    let result = tx
        .query(RESERVE_SQL, &[&uid, &until, &listing_id, &now])
        .await
        .map_err(MarketError::transport)
        .map(|rows| if rows.is_empty() { 0 } else { until });
    finish_tx(tx, result).await
}

pub async fn cancel_reserve(
    pool: &Pool,
    user_id: i64,
    listing_id: &str,
) -> Result<bool, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let uid = match pg_user_id(user_id) {
        Ok(v) => v,
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(MarketError::transport(e));
        }
    };
    let result = tx
        .query(CANCEL_RESERVE_SQL, &[&listing_id, &uid])
        .await
        .map_err(MarketError::transport)
        .map(|rows| !rows.is_empty());
    finish_tx(tx, result).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_sql_matches_node_predicates() {
        assert!(RESERVE_SQL.contains("user_id <> $1"));
        assert!(RESERVE_SQL
            .contains("reserved_until IS NULL OR reserved_until < $4 OR reserved_by = $1"));
        assert!(RESERVE_SQL.contains("expires_at > $4"));
        assert!(!RESERVE_SQL.contains("gen_random_uuid"));
        assert!(CANCEL_RESERVE_SQL.contains("reserved_by = $2"));
    }
}
