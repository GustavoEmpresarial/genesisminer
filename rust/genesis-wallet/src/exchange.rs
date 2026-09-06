//! Exchange desk liquidation — coin → USDC (zero RPC).

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::wallet::{fraction_allowed, FRACTION_MODE_DESK_SHORTCUTS, FRACTION_MODE_LEGACY};
use serde::Serialize;
use serde_json::json;
use tokio_postgres::error::SqlState;

use crate::config::{current_unix_ms, WALLET_LOCK_TIMEOUT_MS, WALLET_STATEMENT_TIMEOUT_MS};
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;
use crate::util::{
    assert_active_user, compute_advisory_lock_key64, require_finite_json_f64,
    require_idem_fingerprint,
};

/// Node `PERCENT_BASE`.
const PERCENT_BASE: f64 = 100.0;
/// Node `FRACTION_EPSILON`.
const FRACTION_EPSILON: f64 = 1e-12;
/// Node `POSTGRES_UNIQUE_VIOLATION_CODE`.
const PG_UNIQUE_VIOLATION: &str = "23505";

/// Node NFT stable USD symbols for rate fallback.
const NFT_ROOM_STABLE_USD_SYMBOLS: &[&str] = &["DAI", "USDT", "USDC", "GHO"];
const NFT_EXCLUSIVE_COIN_ID_KEYS: &[&str] = &["usdt", "usdc", "cbbtc", "dai", "gho", "gemt"];
const NFT_NON_EXCLUSIVE_IDS: &[&str] = &["usdc_interno"];

pub const EXCHANGE_LIQUIDATE_PATH: &str = "/v1/wallet/exchange/liquidate";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidateOk {
    pub ok: bool,
    pub sold_amount: f64,
    pub gross_usdc: f64,
    pub fee_usdc: f64,
    pub net_usdc: f64,
    pub new_usdc: f64,
    pub new_coin_balance: f64,
    pub idempotent_replay: bool,
}

fn resolve_mining_coin_usd_rate(
    id: &str,
    symbol: &str,
    usdc_rate: Option<f64>,
    price_usd: Option<f64>,
) -> f64 {
    let usdc = usdc_rate
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0);
    if usdc > 0.0 {
        return usdc;
    }
    let px = price_usd
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0);
    if px > 0.0 {
        return px;
    }
    if !is_nft_room_exclusive_coin(id, symbol) {
        return 0.0;
    }
    let sym = symbol.trim().to_ascii_uppercase();
    if NFT_ROOM_STABLE_USD_SYMBOLS.contains(&sym.as_str()) {
        return 1.0;
    }
    0.0
}

fn is_nft_room_exclusive_coin(id: &str, symbol: &str) -> bool {
    let low = id.trim().to_ascii_lowercase();
    if NFT_NON_EXCLUSIVE_IDS.contains(&low.as_str()) {
        return false;
    }
    if NFT_EXCLUSIVE_COIN_ID_KEYS
        .iter()
        .any(|k| low == *k || low.starts_with(&format!("{k}_")))
    {
        return true;
    }
    let sym = symbol.trim().to_ascii_uppercase();
    NFT_ROOM_STABLE_USD_SYMBOLS.contains(&sym.as_str())
        || matches!(sym.as_str(), "CBBTC" | "GEMT" | "GENT")
}

fn assert_fraction_allowed(fraction: f64, mode: &str) -> Result<(), WalletError> {
    if fraction_allowed(fraction, mode) {
        return Ok(());
    }
    if mode == FRACTION_MODE_DESK_SHORTCUTS {
        return Err(WalletError::bad(
            "Invalid percentage: use 10, 50, or 100 (desk shortcuts).",
        ));
    }
    Err(WalletError::bad(
        "Invalid percentage (use between 0 and 1, e.g. 0.5).",
    ))
}

fn finish_tx<'a, T: 'a>(
    tx: deadpool_postgres::Transaction<'a>,
    result: Result<T, WalletError>,
) -> impl std::future::Future<Output = Result<T, WalletError>> + 'a {
    async move {
        match result {
            Ok(v) => {
                tx.commit().await.map_err(WalletError::transport)?;
                Ok(v)
            }
            Err(e) => {
                let _ = tx.rollback().await;
                Err(e)
            }
        }
    }
}

pub async fn run_exchange_liquidation(
    pool: &Pool,
    user_id: i64,
    coin_id: &str,
    fraction: f64,
    fraction_mode: &str,
    min_usdc: f64,
    fee_percent: f64,
    idempotency_key: Option<&str>,
    idempotency_scope: &str,
    server_now_ms: Option<i64>,
    request_fingerprint: Option<&str>,
) -> Result<LiquidateOk, WalletError> {
    let mode = match fraction_mode {
        FRACTION_MODE_DESK_SHORTCUTS | FRACTION_MODE_LEGACY => fraction_mode,
        _ => {
            return Err(WalletError::bad(
                "Invalid percentage (use between 0 and 1, e.g. 0.5).",
            ))
        }
    };
    assert_fraction_allowed(fraction, mode)?;
    let coin_id = coin_id.trim();
    if coin_id.is_empty() {
        return Err(WalletError::bad("Invalid coin."));
    }
    let server_now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let result = run_inner(
        &tx,
        uid,
        user_id,
        coin_id,
        fraction,
        mode,
        min_usdc,
        fee_percent,
        idempotency_key,
        idempotency_scope,
        server_now,
        request_fingerprint,
    )
    .await;
    finish_tx(tx, result).await
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    coin_id: &str,
    fraction: f64,
    _mode: &str,
    min_usdc: f64,
    fee_percent: f64,
    idempotency_key: Option<&str>,
    idempotency_scope: &str,
    server_now: i64,
    request_fingerprint: Option<&str>,
) -> Result<LiquidateOk, WalletError> {
    client
        .batch_execute(&format!(
            "SET LOCAL statement_timeout = {WALLET_STATEMENT_TIMEOUT_MS}; SET LOCAL lock_timeout = {WALLET_LOCK_TIMEOUT_MS}"
        ))
        .await
        .map_err(WalletError::transport)?;
    assert_active_user(client, user_id).await?;

    if let Some(idem) = idempotency_key.filter(|s| !s.trim().is_empty()) {
        // Stricter than legacy Node (which allowed empty FP on mismatch skip):
        // controllers always bind fingerprint with the key — worker requires it.
        let req_fp = require_idem_fingerprint(request_fingerprint)?;
        let lock_key = compute_advisory_lock_key64(user_id, idempotency_scope, idem);
        client
            .query("SELECT pg_advisory_xact_lock($1::bigint)", &[&lock_key])
            .await
            .map_err(WalletError::transport)?;

        let prev = client
            .query(
                "SELECT response_json, request_fingerprint::text AS request_fingerprint FROM wallet_idempotency WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3",
                &[&uid, &idempotency_scope, &idem],
            )
            .await
            .map_err(WalletError::transport)?;
        if let Some(row) = prev.first() {
            let response_json: String = row.get("response_json");
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&response_json) {
                if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                    let stored_fp: Option<String> = row.get("request_fingerprint");
                    let stored_fp = stored_fp.unwrap_or_default().trim().to_string();
                    if !stored_fp.is_empty() && stored_fp != req_fp {
                        return Err(WalletError::conflict_mismatch(
                            "Same idempotency key with a different request.",
                        ));
                    }
                    return Ok(LiquidateOk {
                        ok: true,
                        sold_amount: require_finite_json_f64(&parsed, "soldAmount")?,
                        gross_usdc: require_finite_json_f64(&parsed, "grossUsdc")?,
                        fee_usdc: require_finite_json_f64(&parsed, "feeUsdc")?,
                        net_usdc: require_finite_json_f64(&parsed, "netUsdc")?,
                        new_usdc: require_finite_json_f64(&parsed, "newUsdc")?,
                        new_coin_balance: require_finite_json_f64(&parsed, "newCoinBalance")?,
                        idempotent_replay: true,
                    });
                }
            }
        }
    }

    let coin_rows = client
        .query(
            "SELECT id, name, symbol, usdc_rate::float8 AS usdc_rate, price_usd::float8 AS price_usd, COALESCE(show_in_exchange, 1) AS sx, is_active FROM mining_coins WHERE id = $1",
            &[&coin_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(coin) = coin_rows.first() else {
        return Err(WalletError::not_found("Coin not found or inactive."));
    };
    let is_active: i32 = coin.get("is_active");
    if is_active == 0 {
        return Err(WalletError::not_found("Coin not found or inactive."));
    }
    let sx: i32 = coin.get("sx");
    if sx == 0 {
        return Err(WalletError::unprocessable(
            "This coin is not available on the exchange desk.",
        ));
    }
    let symbol: String = coin.get("symbol");
    let id: String = coin.get("id");
    let usdc_rate: Option<f64> = coin.get("usdc_rate");
    let price_usd: Option<f64> = coin.get("price_usd");
    let rate = resolve_mining_coin_usd_rate(&id, &symbol, usdc_rate, price_usd);
    if !rate.is_finite() || rate <= 0.0 {
        return Err(WalletError::internal("Coin USDC rate unavailable."));
    }

    let gs = client
        .query(
            "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    if gs.is_empty() {
        return Err(WalletError::unprocessable(
            "Game state has not been created yet. Enter the game (load your save) and try again.",
        ));
    }

    let bal_rows = client
        .query(
            "SELECT amount::float8 AS amount FROM coin_balances WHERE user_id = $1 AND coin_id = $2 FOR UPDATE",
            &[&uid, &coin_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let balance: f64 = bal_rows
        .first()
        .map(|r| r.get::<_, Option<f64>>("amount").unwrap_or(0.0))
        .unwrap_or(0.0);
    if balance <= 0.0 {
        return Err(WalletError::unprocessable("Insufficient balance."));
    }

    let sell_amount = balance * fraction;
    if !sell_amount.is_finite() || sell_amount <= 0.0 || sell_amount > balance + FRACTION_EPSILON {
        return Err(WalletError::bad("Invalid exchange amount."));
    }

    let gross_usdc = sell_amount * rate;
    if !gross_usdc.is_finite() || gross_usdc < min_usdc {
        return Err(WalletError::unprocessable(format!(
            "Minimum exchange amount is {:.2} USDC",
            min_usdc
        )));
    }

    let fee_amount = gross_usdc * (fee_percent / PERCENT_BASE);
    let net_usdc = gross_usdc - fee_amount;
    if !net_usdc.is_finite() || net_usdc <= 0.0 {
        return Err(WalletError::unprocessable("Invalid net amount after fees."));
    }

    let upd_coin = client
        .execute(
            "UPDATE coin_balances SET amount = amount - $1 WHERE user_id = $2 AND coin_id = $3 AND amount >= $1",
            &[&sell_amount, &uid, &coin_id],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd_coin == 0 {
        return Err(WalletError::conflict(
            "Balance changed during the request. Try again.",
        ));
    }

    let upd_gs = client
        .execute(
            "UPDATE game_states SET usdc = COALESCE(usdc::numeric, 0) + $1::numeric WHERE user_id = $2",
            &[&net_usdc, &uid],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd_gs == 0 {
        return Err(WalletError::conflict(
            "Game state changed during the request. Try again.",
        ));
    }

    let sold_s = sell_amount.to_string();
    let gross_s = gross_usdc.to_string();
    let fee_s = fee_amount.to_string();
    let net_s = net_usdc.to_string();
    let ledger_res = if let Some(idem) = idempotency_key.filter(|s| !s.trim().is_empty()) {
        client
            .execute(
                "INSERT INTO wallet_ledger_entries (user_id, entry_type, coin_id, sold_crypto, gross_usdc, fee_usdc, net_usdc, idempotency_key, created_at)
                 VALUES ($1, 'exchange_liquidate', $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7, $8)",
                &[
                    &uid,
                    &coin_id,
                    &sold_s,
                    &gross_s,
                    &fee_s,
                    &net_s,
                    &idem,
                    &server_now,
                ],
            )
            .await
    } else {
        client
            .execute(
                "INSERT INTO wallet_ledger_entries (user_id, entry_type, coin_id, sold_crypto, gross_usdc, fee_usdc, net_usdc, idempotency_key, created_at)
                 VALUES ($1, 'exchange_liquidate', $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, NULL, $7)",
                &[&uid, &coin_id, &sold_s, &gross_s, &fee_s, &net_s, &server_now],
            )
            .await
    };
    match ledger_res {
        Ok(_) => {}
        Err(e) => {
            if e.code() == Some(&SqlState::UNIQUE_VIOLATION)
                || e.code()
                    .map(|c| c.code() == PG_UNIQUE_VIOLATION)
                    .unwrap_or(false)
            {
                return Err(WalletError::conflict(
                    "Duplicate or conflicting operation. Reload wallet state.",
                ));
            }
            return Err(WalletError::transport(e));
        }
    }

    let final_gs = client
        .query(
            "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let final_bal = client
        .query(
            "SELECT amount::float8 AS amount FROM coin_balances WHERE user_id = $1 AND coin_id = $2",
            &[&uid, &coin_id],
        )
        .await
        .map_err(WalletError::transport)?;

    let out = LiquidateOk {
        ok: true,
        sold_amount: sell_amount,
        gross_usdc,
        fee_usdc: fee_amount,
        net_usdc,
        new_usdc: final_gs
            .first()
            .map(|r| r.get::<_, Option<f64>>("usdc").unwrap_or(0.0))
            .unwrap_or(0.0),
        new_coin_balance: final_bal
            .first()
            .map(|r| r.get::<_, Option<f64>>("amount").unwrap_or(0.0))
            .unwrap_or(0.0),
        idempotent_replay: false,
    };

    if let Some(idem) = idempotency_key.filter(|s| !s.trim().is_empty()) {
        let fp = require_idem_fingerprint(request_fingerprint)?;
        let response_json = json!({
            "ok": true,
            "soldAmount": out.sold_amount,
            "grossUsdc": out.gross_usdc,
            "feeUsdc": out.fee_usdc,
            "netUsdc": out.net_usdc,
            "newUsdc": out.new_usdc,
            "newCoinBalance": out.new_coin_balance,
            "idempotentReplay": false
        })
        .to_string();
        client
            .execute(
                "INSERT INTO wallet_idempotency (user_id, scope, idempotency_key, response_json, request_fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                &[&uid, &idempotency_scope, &idem, &response_json, &fp, &server_now],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    Ok(out)
}
