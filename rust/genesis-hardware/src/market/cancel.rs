//! Cancel own active listing: unlist in-process + DELETE join/listing.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use genesis_core::market::is_reservation_active;

use crate::p2p::{p2p_instances_apply, P2pInstancesInput, P2P_OP_UNLIST};
use crate::pg_types::pg_user_id;

use super::errors::{
    MarketError, ERR_LISTING_INSTANCE_COUNT, ERR_LISTING_NOT_CANCELLABLE, ERR_LISTING_NOT_FOUND,
    ERR_LISTING_RESERVED,
};
use super::{
    assert_active_user, bump_game_state, current_now_ms, delete_listing, delete_listing_instances,
    finish_tx, listing_qty_from_row, lock_game_state, select_listing_instance_ids,
    set_market_tx_timeouts, LISTING_STATUS_ACTIVE,
};

const SELECT_LISTING_FOR_UPDATE_SQL: &str =
    "SELECT * FROM player_listings WHERE id = $1 FOR UPDATE";

pub struct CancelOutcome {
    pub item_id: String,
    pub qty: i32,
    pub price: f64,
}

pub async fn cancel(
    pool: &Pool,
    user_id: i64,
    listing_id: &str,
) -> Result<CancelOutcome, MarketError> {
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = cancel_on_tx(&tx, user_id, listing_id).await;
    finish_tx(tx, result).await
}

async fn cancel_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    listing_id: &str,
) -> Result<CancelOutcome, MarketError> {
    assert_active_user(client, user_id).await?;
    lock_game_state(client, user_id).await?;
    let rows = client
        .query(SELECT_LISTING_FOR_UPDATE_SQL, &[&listing_id])
        .await
        .map_err(MarketError::transport)?;
    let Some(l) = rows.first() else {
        return Err(MarketError::not_found(ERR_LISTING_NOT_FOUND, None));
    };
    let owner: i32 = l.get("user_id");
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    if owner != uid {
        return Err(MarketError::not_found(ERR_LISTING_NOT_FOUND, None));
    }
    let status: Option<String> = l.get("status");
    if status.as_deref() != Some(LISTING_STATUS_ACTIVE) {
        return Err(MarketError::bad(ERR_LISTING_NOT_CANCELLABLE));
    }
    let now = current_now_ms();
    let reserved_until: Option<i64> = l.get("reserved_until");
    let reserved_by: Option<i32> = l.get("reserved_by");
    if reserved_by.is_some() && is_reservation_active(reserved_until, now) {
        return Err(MarketError::conflict(ERR_LISTING_RESERVED));
    }
    let qty = listing_qty_from_row(l.get("qty"));
    let item_id: String = l.get("item_id");
    let price: f64 = l.get("price");
    let instance_ids = select_listing_instance_ids(client, listing_id).await?;
    if instance_ids.len() != usize::try_from(qty).unwrap_or(0) {
        return Err(MarketError::conflict(ERR_LISTING_INSTANCE_COUNT));
    }
    p2p_instances_apply(
        client,
        P2pInstancesInput {
            user_id,
            item_id: &item_id,
            op: P2P_OP_UNLIST,
            qty: None,
            to_user_id: None,
            instance_ids: Some(&instance_ids),
        },
    )
    .await
    .map_err(MarketError::from_p2p)?;
    delete_listing_instances(client, listing_id).await?;
    delete_listing(client, listing_id).await?;
    bump_game_state(client, user_id, now).await?;
    Ok(CancelOutcome {
        item_id,
        qty,
        price,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_sql_no_mint() {
        assert!(SELECT_LISTING_FOR_UPDATE_SQL.contains("FOR UPDATE"));
        assert!(!SELECT_LISTING_FOR_UPDATE_SQL.contains("gen_random_uuid"));
        assert!(!SELECT_LISTING_FOR_UPDATE_SQL.contains("consume"));
    }
}
