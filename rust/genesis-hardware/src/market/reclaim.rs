//! Legacy TTL reclaim: unlist in-process then DELETE. Never DELETE without unlist.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;

use tracing::warn;

use crate::p2p::{p2p_instances_apply, P2pInstancesInput, P2P_OP_UNLIST};
use crate::pg_types::pg_user_id;

use super::errors::{MarketError, ERR_LISTING_INSTANCE_COUNT};
use super::{
    current_now_ms, finish_tx, listing_qty_from_row, select_listing_instance_ids,
    set_market_tx_timeouts, RECLAIM_BATCH_SIZE, RECLAIM_BATCH_SIZE_MAX, RECLAIM_MAX_ROUNDS,
};

const SELECT_EXPIRED_SQL: &str = "SELECT id, user_id, item_id, qty
        FROM player_listings
        WHERE status = 'active'
          AND expires_at <= $1
          AND (reserved_until IS NULL OR reserved_until < $1)
          AND user_id > 0
          AND TRIM(item_id) <> ''
        ORDER BY expires_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED";

const DELETE_JOINS_SQL: &str =
    "DELETE FROM player_listing_instances WHERE listing_id = ANY($1::text[])";
const DELETE_LISTINGS_SQL: &str = "DELETE FROM player_listings WHERE id = ANY($1::text[])";

const CLEAR_EXPIRED_RESERVATIONS_SQL: &str =
    "UPDATE player_listings SET reserved_by = NULL, reserved_until = NULL
    WHERE status = 'active' AND reserved_until IS NOT NULL AND reserved_until < $1";

pub struct ReclaimOpts {
    pub now_ms: Option<i64>,
    pub batch_size: Option<i64>,
    pub max_rounds: Option<i64>,
}

pub async fn clear_expired_reservations(pool: &Pool, now_ms: i64) -> Result<(), MarketError> {
    let conn = pool.get().await?;
    conn.execute(CLEAR_EXPIRED_RESERVATIONS_SQL, &[&now_ms])
        .await
        .map_err(MarketError::transport)?;
    Ok(())
}

struct ReclaimRound {
    visited: i64,
    credited: i64,
}

pub async fn reclaim_expired(pool: &Pool, opts: ReclaimOpts) -> Result<i64, MarketError> {
    let now_ms = opts.now_ms.unwrap_or_else(current_now_ms);
    let batch = opts
        .batch_size
        .unwrap_or(RECLAIM_BATCH_SIZE)
        .clamp(1, RECLAIM_BATCH_SIZE_MAX);
    let max_rounds = opts.max_rounds.unwrap_or(RECLAIM_MAX_ROUNDS).max(1);
    let mut reclaimed: i64 = 0;
    for _ in 0..max_rounds {
        let round = reclaim_one_round(pool, now_ms, batch).await?;
        reclaimed += round.credited;
        if round.visited < batch || round.credited == 0 {
            break;
        }
    }
    Ok(reclaimed)
}

async fn reclaim_one_round(
    pool: &Pool,
    now_ms: i64,
    batch: i64,
) -> Result<ReclaimRound, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = reclaim_round_on_tx(&tx, now_ms, batch).await;
    finish_tx(tx, result).await
}

async fn reclaim_round_on_tx<C: GenericClient>(
    client: &C,
    now_ms: i64,
    batch: i64,
) -> Result<ReclaimRound, MarketError> {
    let rows = client
        .query(SELECT_EXPIRED_SQL, &[&now_ms, &batch])
        .await
        .map_err(MarketError::transport)?;
    let visited = i64::try_from(rows.len()).unwrap_or(0);
    if rows.is_empty() {
        return Ok(ReclaimRound {
            visited: 0,
            credited: 0,
        });
    }
    let mut credited_ids: Vec<String> = Vec::new();
    for row in &rows {
        let id: String = row.get("id");
        let user_id: i32 = row.get("user_id");
        let item_id: String = row.get("item_id");
        let item_id = item_id.trim().to_string();
        let qty = listing_qty_from_row(row.get("qty"));
        if id.is_empty() || user_id <= 0 || item_id.is_empty() {
            continue;
        }
        if unlist_reclaimed(client, &id, i64::from(user_id), &item_id, qty).await? {
            credited_ids.push(id);
        }
    }
    if !credited_ids.is_empty() {
        client
            .execute(DELETE_JOINS_SQL, &[&credited_ids])
            .await
            .map_err(MarketError::transport)?;
        client
            .execute(DELETE_LISTINGS_SQL, &[&credited_ids])
            .await
            .map_err(MarketError::transport)?;
    }
    let credited = i64::try_from(credited_ids.len()).unwrap_or(0);
    Ok(ReclaimRound { visited, credited })
}

/// `Ok(true)` = unlist done (caller may DELETE). `Ok(false)` = skip (no unlist, no DELETE).
async fn unlist_reclaimed<C: GenericClient>(
    client: &C,
    listing_id: &str,
    user_id: i64,
    item_id: &str,
    qty: i32,
) -> Result<bool, MarketError> {
    let _ = pg_user_id(user_id).map_err(MarketError::transport)?;
    let ids = select_listing_instance_ids(client, listing_id).await?;
    let need = usize::try_from(qty).unwrap_or(0);
    if ids.len() != need {
        warn!(
            listing_id,
            qty,
            have = ids.len(),
            "{ERR_LISTING_INSTANCE_COUNT} — skip reclaim"
        );
        return Ok(false);
    }
    p2p_instances_apply(
        client,
        P2pInstancesInput {
            user_id,
            item_id,
            op: P2P_OP_UNLIST,
            qty: None,
            to_user_id: None,
            instance_ids: Some(&ids),
        },
    )
    .await
    .map_err(MarketError::from_p2p)?;
    Ok(true)
}

fn absorb_reclaim_transport(err: MarketError, context: &'static str) -> Result<(), MarketError> {
    match err {
        MarketError::Transport(e) => {
            warn!(err = %e, "{context}: reclaim transport — serving read");
            Ok(())
        }
        other => Err(other),
    }
}

pub async fn prepare_market_book_reads(pool: &Pool, now_ms: i64) -> Result<(), MarketError> {
    clear_expired_reservations(pool, now_ms).await?;
    if let Err(e) = reclaim_expired(
        pool,
        ReclaimOpts {
            now_ms: Some(now_ms),
            batch_size: None,
            max_rounds: None,
        },
    )
    .await
    {
        absorb_reclaim_transport(e, "prepare_market_book_reads")?;
    }
    Ok(())
}

pub async fn reclaim_expired_for_reads(pool: &Pool, opts: ReclaimOpts) -> Result<(), MarketError> {
    if let Err(e) = reclaim_expired(pool, opts).await {
        absorb_reclaim_transport(e, "sellable_stock")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclaim_select_then_unlist_then_delete() {
        assert!(SELECT_EXPIRED_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(SELECT_EXPIRED_SQL.contains("expires_at <= $1"));
        assert!(DELETE_LISTINGS_SQL.contains("DELETE FROM player_listings"));
        assert!(DELETE_JOINS_SQL.contains("player_listing_instances"));
        assert!(!SELECT_EXPIRED_SQL.contains("DELETE"));
        assert!(!SELECT_EXPIRED_SQL.contains("gen_random_uuid"));
        assert!(!DELETE_LISTINGS_SQL.contains("unlist"));
    }

    #[test]
    fn reclaim_does_not_delete_without_unlist() {
        let src = include_str!("reclaim.rs");
        assert!(src.contains("unlist_reclaimed"));
        assert!(src.contains("ERR_LISTING_INSTANCE_COUNT"));
        assert!(src.contains("credited_ids"));
        let round_fn = src.find("async fn reclaim_round_on_tx").expect("round fn");
        let unlist_call = src[round_fn..]
            .find("unlist_reclaimed")
            .expect("unlist call");
        let delete_call = src[round_fn..]
            .find("DELETE_LISTINGS_SQL")
            .expect("delete after unlist");
        assert!(unlist_call < delete_call);
    }

    #[test]
    fn reclaim_skips_count_mismatch_does_not_err() {
        let src = include_str!("reclaim.rs");
        let unlist_fn = src.find("async fn unlist_reclaimed").expect("unlist fn");
        let next = src[unlist_fn..]
            .find("fn absorb_reclaim_transport")
            .expect("next fn");
        let body = &src[unlist_fn..unlist_fn + next];
        assert!(body.contains("return Ok(false)"));
        assert!(!body.contains("return Err"));
        assert!(src.contains("round.visited < batch || round.credited == 0"));
    }

    #[test]
    fn batch_constants_match_node() {
        assert_eq!(RECLAIM_BATCH_SIZE, 200);
        assert_eq!(RECLAIM_BATCH_SIZE_MAX, 500);
        assert_eq!(RECLAIM_MAX_ROUNDS, 40);
    }
}
