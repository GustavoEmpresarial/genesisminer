//! Admin global reinvestment list — `wallet_ledger_entries` (`exchange_liquidate`).

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::errors::WalletError;
use crate::player_reads::{
    PLAYER_HISTORY_MAX_LIMIT, REINVESTMENT_HISTORY_SINCE_MS,
    WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
};

pub const ADMIN_REINVESTMENT_LIST_PATH: &str = "/v1/wallet/admin/reinvestment/list";

/// Optional epoch-ms window. Empty / invalid → open bound.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReinvestmentListRequest {
    #[serde(default)]
    pub from_ms: Option<String>,
    #[serde(default)]
    pub to_ms: Option<String>,
}

fn parse_bound_ms(raw: Option<&str>, fallback: i64) -> i64 {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return fallback;
    };
    match s.parse::<i64>() {
        Ok(v) if v > 0 => v,
        _ => fallback,
    }
}

/// Full-ledger totals + per-user ranking + recent liquidation rows (newest first).
///
/// Totals / `byUser` are uncapped (SQL aggregates). `items` is capped at
/// [`PLAYER_HISTORY_MAX_LIMIT`] for the detail table payload size.
///
/// Date window: `created_at >= from_ms AND created_at <= to_ms` (inclusive).
pub async fn run_admin_reinvestment_list(
    pool: &Pool,
    req: &AdminReinvestmentListRequest,
) -> Result<Value, WalletError> {
    let client = pool.get().await.map_err(WalletError::transport)?;

    let from_ms = parse_bound_ms(
        req.from_ms.as_deref(),
        REINVESTMENT_HISTORY_SINCE_MS,
    );
    // Open upper bound when unset — all ledger timestamps fit below this.
    const TO_MS_OPEN: i64 = i64::MAX;
    let to_ms = parse_bound_ms(req.to_ms.as_deref(), TO_MS_OPEN);
    let to_ms = if to_ms < from_ms { from_ms } else { to_ms };

    let totals_row = client
        .query_one(
            "SELECT COUNT(*)::bigint AS ops,
                    COUNT(DISTINCT user_id)::bigint AS users,
                    COALESCE(SUM(gross_usdc), 0)::double precision AS gross_usdc,
                    COALESCE(SUM(fee_usdc), 0)::double precision AS fee_usdc,
                    COALESCE(SUM(net_usdc), 0)::double precision AS net_usdc,
                    COALESCE(MIN(created_at), 0)::bigint AS min_at,
                    COALESCE(MAX(created_at), 0)::bigint AS max_at
               FROM wallet_ledger_entries
              WHERE entry_type = $1
                AND created_at >= $2
                AND created_at <= $3",
            &[
                &WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
                &from_ms,
                &to_ms,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    let by_user_rows = client
        .query(
            "SELECT e.user_id,
                    COALESCE(u.username, '') AS username,
                    COALESCE(u.email, '') AS email,
                    COUNT(*)::bigint AS ops,
                    COALESCE(SUM(e.gross_usdc), 0)::double precision AS gross_usdc,
                    COALESCE(SUM(e.fee_usdc), 0)::double precision AS fee_usdc,
                    COALESCE(SUM(e.net_usdc), 0)::double precision AS net_usdc,
                    COALESCE(MAX(e.created_at), 0)::bigint AS last_at
               FROM wallet_ledger_entries e
               JOIN users u ON e.user_id = u.id
              WHERE e.entry_type = $1
                AND e.created_at >= $2
                AND e.created_at <= $3
              GROUP BY e.user_id, u.username, u.email
              ORDER BY net_usdc DESC, last_at DESC",
            &[
                &WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
                &from_ms,
                &to_ms,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    let item_rows = client
        .query(
            "SELECT e.id::text AS id, e.user_id,
                    COALESCE(u.username, '') AS username,
                    COALESCE(u.email, '') AS email,
                    e.coin_id, COALESCE(c.symbol, '') AS coin_symbol,
                    e.sold_crypto::double precision AS sold_crypto,
                    e.gross_usdc::double precision AS gross_usdc,
                    COALESCE(e.fee_usdc, 0)::double precision AS fee_usdc,
                    e.net_usdc::double precision AS net_usdc,
                    e.created_at
               FROM wallet_ledger_entries e
               JOIN users u ON e.user_id = u.id
               LEFT JOIN mining_coins c ON e.coin_id = c.id
              WHERE e.entry_type = $1
                AND e.created_at >= $2
                AND e.created_at <= $3
              ORDER BY e.created_at DESC
              LIMIT $4",
            &[
                &WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
                &from_ms,
                &to_ms,
                &PLAYER_HISTORY_MAX_LIMIT,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    let ops = totals_row.get::<_, i64>("ops");
    let items: Vec<Value> = item_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<_, String>("id"),
                "userId": r.get::<_, i32>("user_id"),
                "username": r.get::<_, String>("username"),
                "email": r.get::<_, String>("email"),
                "coinId": r.get::<_, String>("coin_id"),
                "coinSymbol": r.get::<_, String>("coin_symbol"),
                "soldCrypto": r.get::<_, Option<f64>>("sold_crypto").unwrap_or(0.0),
                "grossUsdc": r.get::<_, Option<f64>>("gross_usdc").unwrap_or(0.0),
                "feeUsdc": r.get::<_, Option<f64>>("fee_usdc").unwrap_or(0.0),
                "netUsdc": r.get::<_, Option<f64>>("net_usdc").unwrap_or(0.0),
                "createdAt": r.get::<_, Option<i64>>("created_at").unwrap_or(0),
            })
        })
        .collect();

    let by_user: Vec<Value> = by_user_rows
        .iter()
        .map(|r| {
            json!({
                "userId": r.get::<_, i32>("user_id"),
                "username": r.get::<_, String>("username"),
                "email": r.get::<_, String>("email"),
                "ops": r.get::<_, i64>("ops"),
                "grossUsdc": r.get::<_, Option<f64>>("gross_usdc").unwrap_or(0.0),
                "feeUsdc": r.get::<_, Option<f64>>("fee_usdc").unwrap_or(0.0),
                "netUsdc": r.get::<_, Option<f64>>("net_usdc").unwrap_or(0.0),
                "lastAt": r.get::<_, i64>("last_at"),
            })
        })
        .collect();

    Ok(json!({
        "ok": true,
        "totals": {
            "ops": ops,
            "users": totals_row.get::<_, i64>("users"),
            "grossUsdc": totals_row.get::<_, f64>("gross_usdc"),
            "feeUsdc": totals_row.get::<_, f64>("fee_usdc"),
            "netUsdc": totals_row.get::<_, f64>("net_usdc"),
            "minAt": totals_row.get::<_, i64>("min_at"),
            "maxAt": totals_row.get::<_, i64>("max_at"),
        },
        "byUser": by_user,
        "items": items,
        "itemsTruncated": ops > PLAYER_HISTORY_MAX_LIMIT,
        "itemsLimit": PLAYER_HISTORY_MAX_LIMIT,
        "fromMs": from_ms,
        "toMs": if to_ms == TO_MS_OPEN { Value::Null } else { json!(to_ms) },
    }))
}
