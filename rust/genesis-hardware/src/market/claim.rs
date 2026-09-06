//! Claim proceeds (USDC) and custody items (`transfer` in-process, no mint).

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;

use crate::p2p::{p2p_instances_apply, P2pInstancesInput, P2P_OP_TRANSFER};
use crate::pg_types::pg_user_id;

use super::errors::{
    MarketError, ERR_CUSTODY_NOT_FOUND, ERR_LISTING_INSTANCE_COUNT, ERR_NO_CUSTODY, ERR_NO_PROCEEDS,
};
use super::{
    assert_active_user, bump_game_state, current_now_ms, delete_listing, delete_listing_instances,
    finish_tx, listing_qty_from_row, lock_game_state, select_listing_instance_ids,
    set_market_tx_timeouts,
};

const CLAIM_PROCEEDS_SQL: &str = "WITH prev AS (
        SELECT user_id, COALESCE(black_market_balance, 0) AS bal
          FROM game_states
         WHERE user_id = $1
           AND COALESCE(black_market_balance, 0) > 0
         FOR UPDATE
      )
      UPDATE game_states gs
         SET usdc = COALESCE(gs.usdc, 0) + prev.bal,
             black_market_balance = 0,
             last_updated_at = $2,
             server_updated_at = $2
        FROM prev
       WHERE gs.user_id = prev.user_id
      RETURNING prev.bal AS moved";

const SELECT_ALL_CUSTODY_SQL: &str =
    "SELECT id, item_id, qty, user_id FROM player_listings WHERE status = 'awaiting_pickup' AND reserved_by = $1 FOR UPDATE";

const SELECT_ONE_CUSTODY_SQL: &str =
    "SELECT * FROM player_listings WHERE id = $1 AND status = 'awaiting_pickup' AND reserved_by = $2 FOR UPDATE";

pub async fn claim_proceeds(pool: &Pool, user_id: i64) -> Result<f64, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = claim_proceeds_on_tx(&tx, user_id).await;
    finish_tx(tx, result).await
}

async fn claim_proceeds_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<f64, MarketError> {
    assert_active_user(client, user_id).await?;
    let now = current_now_ms();
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let rows = client
        .query(CLAIM_PROCEEDS_SQL, &[&uid, &now])
        .await
        .map_err(MarketError::transport)?;
    let bal: f64 = rows
        .first()
        .map(|r| r.get::<_, f64>("moved"))
        .unwrap_or(0.0);
    if !(bal > 0.0) {
        return Err(MarketError::bad(ERR_NO_PROCEEDS));
    }
    Ok(bal)
}

pub async fn claim_all(pool: &Pool, user_id: i64) -> Result<Vec<String>, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = claim_all_on_tx(&tx, user_id).await;
    finish_tx(tx, result).await
}

async fn claim_all_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<Vec<String>, MarketError> {
    assert_active_user(client, user_id).await?;
    lock_game_state(client, user_id).await?;
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let rows = client
        .query(SELECT_ALL_CUSTODY_SQL, &[&uid])
        .await
        .map_err(MarketError::transport)?;
    if rows.is_empty() {
        return Err(MarketError::bad(ERR_NO_CUSTODY));
    }
    let mut claimed_ids = Vec::new();
    for row in &rows {
        let id: String = row.get("id");
        let item_id: String = row.get("item_id");
        let qty = listing_qty_from_row(row.get("qty"));
        let seller_id: i32 = row.get("user_id");
        transfer_custody(client, &id, i64::from(seller_id), user_id, &item_id, qty).await?;
        claimed_ids.push(id);
    }
    bump_game_state(client, user_id, current_now_ms()).await?;
    Ok(claimed_ids)
}

pub struct ClaimItemOutcome {
    pub item_id: String,
    pub qty: i32,
}

pub async fn claim_item(
    pool: &Pool,
    user_id: i64,
    listing_id: &str,
) -> Result<ClaimItemOutcome, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = claim_item_on_tx(&tx, user_id, listing_id).await;
    finish_tx(tx, result).await
}

async fn claim_item_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    listing_id: &str,
) -> Result<ClaimItemOutcome, MarketError> {
    assert_active_user(client, user_id).await?;
    lock_game_state(client, user_id).await?;
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    let rows = client
        .query(SELECT_ONE_CUSTODY_SQL, &[&listing_id, &uid])
        .await
        .map_err(MarketError::transport)?;
    let Some(l) = rows.first() else {
        return Err(MarketError::not_found(ERR_CUSTODY_NOT_FOUND, None));
    };
    let qty = listing_qty_from_row(l.get("qty"));
    let item_id: String = l.get("item_id");
    let seller_id: i32 = l.get("user_id");
    transfer_custody(
        client,
        listing_id,
        i64::from(seller_id),
        user_id,
        &item_id,
        qty,
    )
    .await?;
    bump_game_state(client, user_id, current_now_ms()).await?;
    Ok(ClaimItemOutcome { item_id, qty })
}

async fn transfer_custody<C: GenericClient>(
    client: &C,
    listing_id: &str,
    seller_id: i64,
    buyer_id: i64,
    item_id: &str,
    qty: i32,
) -> Result<(), MarketError> {
    let instance_ids = select_listing_instance_ids(client, listing_id).await?;
    if instance_ids.len() != usize::try_from(qty).unwrap_or(0) {
        return Err(MarketError::conflict(ERR_LISTING_INSTANCE_COUNT));
    }
    p2p_instances_apply(
        client,
        P2pInstancesInput {
            user_id: seller_id,
            item_id,
            op: P2P_OP_TRANSFER,
            qty: None,
            to_user_id: Some(buyer_id),
            instance_ids: Some(&instance_ids),
        },
    )
    .await
    .map_err(MarketError::from_p2p)?;
    delete_listing_instances(client, listing_id).await?;
    delete_listing(client, listing_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_sql_no_mint() {
        let sql = [
            CLAIM_PROCEEDS_SQL,
            SELECT_ALL_CUSTODY_SQL,
            SELECT_ONE_CUSTODY_SQL,
        ]
        .join("\n");
        assert!(!sql.to_ascii_lowercase().contains("gen_random_uuid"));
        assert!(!sql.to_ascii_lowercase().contains("consume"));
        assert!(!sql.to_ascii_lowercase().contains("mint"));
        assert!(CLAIM_PROCEEDS_SQL.contains("black_market_balance = 0"));
        assert!(SELECT_ALL_CUSTODY_SQL.contains("awaiting_pickup"));
    }
}
