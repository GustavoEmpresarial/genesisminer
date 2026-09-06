//! Create a P2P listing: catalog + band + `p2p_instances(list)` + INSERT.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use genesis_core::market::{clamp_price_band_percent, compute_p2p_band_reference_usd};

use crate::p2p::{p2p_instances_apply, P2pInstancesInput, P2P_OP_LIST};
use crate::pg_types::{pg_qty, pg_user_id};

use super::errors::{
    MarketError, ERR_INSUFFICIENT_STOCK_TO_LIST, ERR_ITEM_NOT_SELLABLE,
    ERR_LISTING_INSTANCES_MISSING,
};
use super::{
    assert_active_user, bump_game_state, current_now_ms, finish_tx, format_price_decimals,
    insert_listing_instances, lock_game_state, random_listing_id, set_market_tx_timeouts,
    validate_sell_input, BAND_EPSILON, ECONOMY_SETTINGS_SINGLETON_ID, IS_PLAYER_YES,
    LISTING_STATUS_ACTIVE, P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS, PERCENT_DIVISOR,
};

const SELECT_UPGRADE_SQL: &str =
    "SELECT id, sell_in_black_market, base_cost::double precision AS base_cost FROM upgrades WHERE id = $1 AND COALESCE(is_active, 1) = 1";
const SELECT_MEDIAN_ASK_SQL: &str =
    "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price::double precision) AS m
        FROM player_listings WHERE item_id = $1 AND status = 'active' AND expires_at > $2";
const SELECT_MIN_ASK_SQL: &str =
    "SELECT MIN(price::double precision) AS m FROM player_listings WHERE item_id = $1 AND status = 'active' AND expires_at > $2";
const SELECT_BAND_SQL: &str =
    "SELECT black_market_price_band_percent FROM economy_settings WHERE id = $1";
const SELECT_BAND_FALLBACK_SQL: &str = "SELECT value FROM settings WHERE key = $1";
const INSERT_LISTING_SQL: &str = "INSERT INTO player_listings (id, user_id, item_id, price, expires_at, is_player, qty, status, buyer_paid_usdc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)";

pub struct SellOutcome {
    pub listing_id: String,
}

pub async fn sell(
    pool: &Pool,
    user_id: i64,
    item_id: &str,
    price: f64,
    qty: i64,
) -> Result<SellOutcome, MarketError> {
    validate_sell_input(item_id, price, qty)?;
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(MarketError::transport)?;
    set_market_tx_timeouts(&tx).await?;
    let result = sell_on_tx(&tx, user_id, item_id, price, qty).await;
    finish_tx(tx, result).await
}

async fn sell_on_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    item_id: &str,
    price: f64,
    qty: i64,
) -> Result<SellOutcome, MarketError> {
    assert_active_user(client, user_id).await?;
    lock_game_state(client, user_id).await?;
    let up_rows = client
        .query(SELECT_UPGRADE_SQL, &[&item_id])
        .await
        .map_err(MarketError::transport)?;
    let Some(up) = up_rows.first() else {
        return Err(MarketError::bad(ERR_ITEM_NOT_SELLABLE));
    };
    let sell_flag: Option<i32> = up.get("sell_in_black_market");
    if sell_flag.unwrap_or(1) == 0 {
        return Err(MarketError::bad(ERR_ITEM_NOT_SELLABLE));
    }
    let base_cost: Option<f64> = up.get("base_cost");
    let base_cost = base_cost.unwrap_or(f64::NAN);
    let now_ms = current_now_ms();
    let mut book_fallback: Option<f64> = None;
    if !(base_cost.is_finite() && base_cost > 0.0) {
        let med_rows = client
            .query(SELECT_MEDIAN_ASK_SQL, &[&item_id, &now_ms])
            .await
            .map_err(MarketError::transport)?;
        let raw_med: Option<f64> = med_rows.first().and_then(|r| r.get("m"));
        if let Some(med) = raw_med.filter(|m| m.is_finite() && *m > 0.0) {
            book_fallback = Some(med);
        } else {
            let min_rows = client
                .query(SELECT_MIN_ASK_SQL, &[&item_id, &now_ms])
                .await
                .map_err(MarketError::transport)?;
            let raw_min: Option<f64> = min_rows.first().and_then(|r| r.get("m"));
            book_fallback = raw_min.filter(|m| m.is_finite() && *m > 0.0);
        }
    }
    let ref_usd = compute_p2p_band_reference_usd(base_cost, book_fallback);
    let band = price_band_percent(client).await?;
    if ref_usd > 0.0 {
        let min_f = 1.0 - band / PERCENT_DIVISOR;
        let max_f = 1.0 + band / PERCENT_DIVISOR;
        let lo = ref_usd * min_f;
        let hi = ref_usd * max_f;
        if price < lo - BAND_EPSILON || price > hi + BAND_EPSILON {
            let hint = if base_cost.is_finite() && base_cost > 0.0 {
                format!(
                    "Âncora: Genesis Supply (base_cost) USDC {}.",
                    format_price_decimals(ref_usd)
                )
            } else {
                format!(
                    "Âncora: livro P2P (sem base_cost válido na BD) USDC {} — confira upgrades.base_cost para este item.",
                    format_price_decimals(ref_usd)
                )
            };
            return Err(MarketError::bad(format!(
                "Price outside limit (±{band}% of USDC {}). {hint}",
                format_price_decimals(ref_usd)
            )));
        }
    }
    let need = pg_qty(qty).map_err(MarketError::transport)?;
    let listed = p2p_instances_apply(
        client,
        P2pInstancesInput {
            user_id,
            item_id,
            op: P2P_OP_LIST,
            qty: Some(i64::from(need)),
            to_user_id: None,
            instance_ids: None,
        },
    )
    .await
    .map_err(MarketError::from_p2p)?;
    if listed.instance_ids.is_empty() {
        return Err(MarketError::conflict(ERR_LISTING_INSTANCES_MISSING));
    }
    let listing_id = random_listing_id();
    let uid = pg_user_id(user_id).map_err(MarketError::transport)?;
    client
        .execute(
            INSERT_LISTING_SQL,
            &[
                &listing_id,
                &uid,
                &item_id,
                &price,
                &P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS,
                &IS_PLAYER_YES,
                &need,
                &LISTING_STATUS_ACTIVE,
            ],
        )
        .await
        .map_err(MarketError::transport)?;
    insert_listing_instances(client, &listing_id, &listed.instance_ids).await?;
    bump_game_state(client, user_id, now_ms).await?;
    Ok(SellOutcome { listing_id })
}

pub async fn price_band_percent<C: GenericClient>(client: &C) -> Result<f64, MarketError> {
    match client
        .query(SELECT_BAND_SQL, &[&ECONOMY_SETTINGS_SINGLETON_ID])
        .await
    {
        Ok(rows) => {
            if let Some(row) = rows.first() {
                let n: Option<f64> = row.get("black_market_price_band_percent");
                return Ok(clamp_price_band_percent(
                    n.filter(|v| v.is_finite())
                        .unwrap_or(genesis_core::market::PRICE_BAND_DEFAULT_PERCENT),
                ));
            }
        }
        Err(_) => {}
    }
    match client
        .query(
            SELECT_BAND_FALLBACK_SQL,
            &[&"black_market_price_band_percent"],
        )
        .await
    {
        Ok(rows) => {
            if let Some(row) = rows.first() {
                let raw: String = row.get("value");
                let n = raw.parse::<f64>().ok();
                return Ok(clamp_price_band_percent(
                    n.filter(|v| v.is_finite())
                        .unwrap_or(genesis_core::market::PRICE_BAND_DEFAULT_PERCENT),
                ));
            }
        }
        Err(_) => {}
    }
    Ok(genesis_core::market::PRICE_BAND_DEFAULT_PERCENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_uses_sentinel_not_i64_max() {
        assert!(INSERT_LISTING_SQL.contains("expires_at"));
        assert_eq!(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS, 9_007_199_254_740_991);
        assert!(!INSERT_LISTING_SQL.contains("gen_random_uuid"));
        assert!(!INSERT_LISTING_SQL.contains("consume"));
    }

    #[test]
    fn stock_error_message_byte_equal() {
        assert_eq!(
            ERR_INSUFFICIENT_STOCK_TO_LIST,
            "Insufficient stock to list."
        );
    }
}
