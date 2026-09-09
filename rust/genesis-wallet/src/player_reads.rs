//! Wallet player reads — Node `wallet-state` + history + web3-settings.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::calculator::nft::resolve_mining_coin_usd_rate;
use genesis_core::calculator::types::MiningCoinInput;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::pg_types::pg_user_id;

/// Node `EXCHANGE_MIN_USDC_DEFAULT`.
const EXCHANGE_MIN_USDC_DEFAULT: f64 = 0.1;
/// Node `EXCHANGE_FEE_PERCENT_MIN`.
const EXCHANGE_FEE_PERCENT_MIN: f64 = 0.0;
/// Node `EXCHANGE_FEE_PERCENT_MAX`.
const EXCHANGE_FEE_PERCENT_MAX: f64 = 100.0;
/// Node `WALLET_LEDGER_LIMIT` / `HISTORY_DEFAULT_LIMIT`.
const WALLET_LEDGER_LIMIT: i64 = 30;
/// Node `WALLET_WITHDRAWALS_LIMIT`.
const WALLET_WITHDRAWALS_LIMIT: i64 = 20;
/// Node `HISTORY_MAX_LIMIT`.
const HISTORY_MAX_LIMIT: i64 = 50;
/// Node `PLAYER_HISTORY_DEFAULT_LIMIT`.
const PLAYER_HISTORY_DEFAULT_LIMIT: i64 = 300;
/// Node `PLAYER_HISTORY_MAX_LIMIT`.
const PLAYER_HISTORY_MAX_LIMIT: i64 = 500;
/// Node `MINED_COIN_AMOUNT_DECIMALS`.
const MINED_COIN_AMOUNT_DECIMALS: i32 = 8;
const DEFAULT_DEPOSIT_NETWORK: &str = "polygon";

const _: () = assert!((EXCHANGE_MIN_USDC_DEFAULT * 10.0) as i64 == 1);
const _: () = assert!(EXCHANGE_FEE_PERCENT_MAX as i64 == 100);
const _: () = assert!(WALLET_LEDGER_LIMIT == 30);
const _: () = assert!(WALLET_WITHDRAWALS_LIMIT == 20);
const _: () = assert!(HISTORY_MAX_LIMIT == 50);
const _: () = assert!(PLAYER_HISTORY_DEFAULT_LIMIT == 300);
const _: () = assert!(PLAYER_HISTORY_MAX_LIMIT == 500);
const _: () = assert!(MINED_COIN_AMOUNT_DECIMALS == 8);

pub const WALLET_STATE_PATH: &str = "/v1/wallet/state";
pub const WALLET_HISTORY_PATH: &str = "/v1/wallet/history";
pub const WITHDRAWALS_HISTORY_PATH: &str = "/v1/withdrawals/history";
pub const DEPOSITS_HISTORY_PATH: &str = "/v1/deposits/history";
pub const WEB3_SETTINGS_PATH: &str = "/v1/web3-settings";

#[derive(Debug)]
pub struct PlayerReadError {
    pub http_status: u16,
    pub error: String,
}

impl PlayerReadError {
    fn internal(e: impl ToString) -> Self {
        Self {
            http_status: 500,
            error: e.to_string(),
        }
    }
}

impl From<deadpool_postgres::PoolError> for PlayerReadError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::internal(e)
    }
}
impl From<tokio_postgres::Error> for PlayerReadError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::internal(e)
    }
}
impl From<anyhow::Error> for PlayerReadError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(e)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn run_wallet_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let kv = load_settings(
        &conn,
        &[
            "exchange_min_usdc",
            "exchange_fee_percent",
            "web3_withdraw_tokens",
        ],
    )
    .await?;
    let min_usdc = parse_min_usdc(kv.get("exchange_min_usdc"));
    let fee_percent = parse_fee_clamped(kv.get("exchange_fee_percent"));
    let withdraw_tokens = parse_json_array(kv.get("web3_withdraw_tokens"));
    let uid = pg_user_id(user_id)?;

    let u = conn
        .query_opt("SELECT polygon_wallet FROM users WHERE id = $1", &[&uid])
        .await?;
    let gs = conn
        .query_opt(
            "SELECT usdc::text AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let coins = conn
        .query(
            "SELECT c.id, c.name, c.symbol, c.usdc_rate::text AS usdc_rate, c.price_usd::text AS price_usd,
                    COALESCE(c.show_in_exchange, 1) AS sx, b.amount::text AS amount
               FROM mining_coins c
               LEFT JOIN coin_balances b ON b.coin_id = c.id AND b.user_id = $1
              WHERE c.is_active = 1
              ORDER BY c.name ASC",
            &[&uid],
        )
        .await?;
    let led = conn
        .query(
            "SELECT id::text, coin_id, sold_crypto::text, gross_usdc::text, fee_usdc::text, net_usdc::text,
                    created_at::text, entry_type
               FROM wallet_ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &WALLET_LEDGER_LIMIT],
        )
        .await?;
    let wd = conn
        .query(
            "SELECT id::text, coin_id, amount_crypto::text, fee_amount::text, net_amount::text, status,
                    wallet_address, tx_hash, created_at::text
               FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &WALLET_WITHDRAWALS_LIMIT],
        )
        .await?;

    let mined: Vec<Value> = coins
        .iter()
        .map(|r| {
            let bal = round_mined(parse_f64_cell(r, "amount"));
            let rate = resolve_mining_coin_usd_rate(&MiningCoinInput {
                id: string_cell(r, "id"),
                symbol: string_cell(r, "symbol"),
                name: string_cell(r, "name"),
                network_hashrate: 0.0,
                block_reward: 0.0,
                block_time: 0.0,
                price_usd: parse_f64_cell(r, "price_usd"),
                usdc_rate: parse_f64_cell(r, "usdc_rate"),
                nft_room_only: false,
                distribution_mode: Default::default(),
                distribution_usd_month: 0.0,
            });
            let gross = bal * rate;
            let fee = gross * (fee_percent / EXCHANGE_FEE_PERCENT_MAX);
            json!({
                "coinId": string_cell(r, "id"),
                "name": string_cell(r, "name"),
                "symbol": string_cell(r, "symbol"),
                "usdcRate": rate,
                "showInExchange": i32_cell(r, "sx") != 0,
                "minedBalance": bal,
                "grossUsdcEstimate": gross,
                "feeUsdcEstimate": fee,
                "netUsdcEstimate": gross - fee,
            })
        })
        .collect();

    Ok(json!({
        "ok": true,
        "usdcBalance": gs.as_ref().map(|r| parse_f64_cell(r, "usdc")).unwrap_or(0.0),
        "polygonWallet": u.as_ref().and_then(|r| opt_string(r, "polygon_wallet")),
        "exchange": { "minUsdc": min_usdc, "feePercent": fee_percent, "networkUsdcHint": "Polygon" },
        "minedBalances": mined,
        "withdrawTokens": withdraw_tokens,
        "ledger": rows_to_objects(&led),
        "withdrawals": rows_to_objects(&wd),
        "notice": "Valores de taxa, mínimos e saldos são calculados no servidor. Não envies montantes confiáveis como verdade absoluta.",
    }))
}

pub async fn run_wallet_history(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let lim = clamp_limit(limit, WALLET_LEDGER_LIMIT, HISTORY_MAX_LIMIT);
    let led = conn
        .query(
            "SELECT id::text, coin_id, sold_crypto::text, gross_usdc::text, fee_usdc::text, net_usdc::text,
                    created_at::text, entry_type
               FROM wallet_ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let wd = conn
        .query(
            "SELECT id::text, coin_id, amount_crypto::text, fee_amount::text, net_amount::text, status,
                    wallet_address, tx_hash, created_at::text
               FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    Ok(json!({ "ok": true, "ledger": rows_to_objects(&led), "withdrawals": rows_to_objects(&wd) }))
}

pub async fn run_withdrawals_history(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let lim = clamp_limit(
        limit,
        PLAYER_HISTORY_DEFAULT_LIMIT,
        PLAYER_HISTORY_MAX_LIMIT,
    );
    let rows = conn
        .query(
            "SELECT w.id, w.user_id, w.coin_id, c.symbol AS coin_symbol,
                    w.amount_crypto::double precision AS amount_crypto,
                    w.amount_usdc::double precision AS amount_usdc,
                    w.fee_amount::double precision AS fee_amount,
                    w.net_amount::double precision AS net_amount,
                    w.wallet_address, w.status, w.tx_hash, w.created_at, w.processed_at
               FROM withdrawal_requests w
               JOIN mining_coins c ON w.coin_id = c.id
              WHERE w.user_id = $1
              ORDER BY w.created_at DESC
              LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let amount_crypto = f64_cell(r, "amount_crypto");
            let fee = f64_cell(r, "fee_amount");
            let net_raw = f64_cell(r, "net_amount");
            json!({
                "id": string_cell(r, "id"),
                "userId": i32_cell(r, "user_id"),
                "username": "",
                "email": "",
                "coinId": string_cell(r, "coin_id"),
                "coinSymbol": string_cell(r, "coin_symbol"),
                "amountCrypto": amount_crypto,
                "amountUsdc": f64_cell(r, "amount_usdc"),
                "feeAmount": fee,
                "netAmount": if net_raw > 0.0 { net_raw } else { amount_crypto - fee },
                "walletAddress": string_cell(r, "wallet_address"),
                "status": string_cell(r, "status"),
                "txHash": opt_string(r, "tx_hash"),
                "createdAt": i64_cell(r, "created_at"),
                "processedAt": opt_i64(r, "processed_at"),
            })
        })
        .collect();
    Ok(json!(items))
}

pub async fn run_deposits_history(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let lim = clamp_limit(
        limit,
        PLAYER_HISTORY_DEFAULT_LIMIT,
        PLAYER_HISTORY_MAX_LIMIT,
    );
    let rows = conn
        .query(
            "SELECT id, user_id, tx_hash, network,
                    amount_usdc::double precision AS amount_usdc,
                    wallet_address, token_contract, created_at
               FROM user_deposit_history
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let amount = r.try_get::<_, Option<f64>>("amount_usdc").ok().flatten();
            let amount_usdc = match amount {
                Some(n) if n.is_finite() && n > 0.0 => json!(n),
                Some(n) if n == 0.0 => json!(0.0),
                Some(_) | None => Value::Null,
            };
            json!({
                "id": string_cell(r, "id"),
                "userId": i32_cell(r, "user_id"),
                "txHash": string_cell(r, "tx_hash"),
                "network": opt_string(r, "network").unwrap_or_else(|| DEFAULT_DEPOSIT_NETWORK.to_string()),
                "amountUsdc": amount_usdc,
                "walletAddress": string_cell(r, "wallet_address"),
                "tokenContract": opt_string(r, "token_contract"),
                "createdAt": i64_cell(r, "created_at"),
            })
        })
        .collect();
    Ok(json!(items))
}

pub async fn run_web3_settings(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let keys = [
        "web3_deposit_wallet",
        "web3_payout_wallet",
        "web3_deposit_token_contract",
        "web3_deposit_token_contract_bnb",
        "web3_deposit_token_contract_base",
        "web3_min_deposit_usdc",
        "web3_withdraw_token_name",
        "web3_withdraw_token_contract",
        "web3_withdraw_tokens",
        "web3_deposit_polygon_disabled",
        "web3_deposit_bnb_disabled",
        "web3_deposit_base_disabled",
    ];
    let kv = load_settings(&conn, &keys).await?;
    let min_raw = kv.get("web3_min_deposit_usdc").cloned().unwrap_or_default();
    let min_deposit = if min_raw.trim().is_empty() {
        Value::Null
    } else {
        json!(min_raw.parse::<f64>().ok())
    };
    Ok(json!({
        "depositWallet": kv.get("web3_deposit_wallet").cloned().unwrap_or_default(),
        "payoutWallet": kv.get("web3_payout_wallet").cloned().unwrap_or_default(),
        "depositTokenContract": kv.get("web3_deposit_token_contract").cloned().unwrap_or_default(),
        "depositTokenContractBnb": kv.get("web3_deposit_token_contract_bnb").cloned().unwrap_or_default(),
        "depositTokenContractBase": kv.get("web3_deposit_token_contract_base").cloned().unwrap_or_default(),
        "minDepositUsdc": min_deposit,
        "withdrawTokenName": kv.get("web3_withdraw_token_name").cloned().unwrap_or_default(),
        "withdrawTokenContract": kv.get("web3_withdraw_token_contract").cloned().unwrap_or_default(),
        "withdrawTokens": parse_json_array(kv.get("web3_withdraw_tokens")),
        "depositPolygonDisabled": flag_on(kv.get("web3_deposit_polygon_disabled")),
        "depositBnbDisabled": flag_on(kv.get("web3_deposit_bnb_disabled")),
        "depositBaseDisabled": flag_on(kv.get("web3_deposit_base_disabled")),
    }))
}

async fn load_settings<C: GenericClient>(
    client: &C,
    keys: &[&str],
) -> Result<std::collections::HashMap<String, String>, PlayerReadError> {
    let key_vec: Vec<String> = keys.iter().map(|s| (*s).to_string()).collect();
    let rows = client
        .query(
            "SELECT key, value FROM settings WHERE key = ANY($1::text[])",
            &[&key_vec],
        )
        .await?;
    let mut m = std::collections::HashMap::new();
    for r in &rows {
        m.insert(string_cell(r, "key"), string_cell(r, "value"));
    }
    Ok(m)
}

fn parse_min_usdc(raw: Option<&String>) -> f64 {
    let n = raw
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .max(0.0);
    if n > 0.0 {
        n
    } else {
        EXCHANGE_MIN_USDC_DEFAULT
    }
}

fn parse_fee_clamped(raw: Option<&String>) -> f64 {
    let n = raw.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    if !n.is_finite() {
        return EXCHANGE_FEE_PERCENT_MIN;
    }
    n.max(EXCHANGE_FEE_PERCENT_MIN)
        .min(EXCHANGE_FEE_PERCENT_MAX)
}

fn parse_json_array(raw: Option<&String>) -> Value {
    let Some(s) = raw.filter(|s| !s.trim().is_empty()) else {
        return json!([]);
    };
    match serde_json::from_str::<Value>(s) {
        Ok(Value::Array(a)) => Value::Array(a),
        _ => json!([]),
    }
}

fn flag_on(raw: Option<&String>) -> bool {
    let s = raw
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    s == "1" || s == "true" || s == "yes" || s == "on"
}

fn clamp_limit(raw: Option<i64>, default: i64, max: i64) -> i64 {
    match raw {
        Some(n) if n >= 1 => n.min(max),
        _ => default,
    }
}

fn round_mined(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let scale = 10f64.powi(MINED_COIN_AMOUNT_DECIMALS);
    (v * scale).round() / scale
}

fn rows_to_objects(rows: &[tokio_postgres::Row]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let mut obj = serde_json::Map::new();
            for col in r.columns() {
                let name = col.name();
                obj.insert(name.to_string(), cell_json(r, name));
            }
            Value::Object(obj)
        })
        .collect()
}

fn cell_json(row: &tokio_postgres::Row, col: &str) -> Value {
    if let Ok(v) = row.try_get::<_, String>(col) {
        return json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<String>>(col) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        return json!(v);
    }
    Value::Null
}

fn string_cell(row: &tokio_postgres::Row, col: &str) -> String {
    opt_string(row, col).unwrap_or_default()
}

fn opt_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    if let Ok(v) = row.try_get::<_, Option<String>>(col) {
        return v.filter(|s| !s.trim().is_empty());
    }
    if let Ok(v) = row.try_get::<_, String>(col) {
        let t = v.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

fn parse_f64_cell(row: &tokio_postgres::Row, col: &str) -> f64 {
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return v;
        }
    }
    if let Ok(s) = row.try_get::<_, String>(col) {
        if let Ok(v) = s.parse::<f64>() {
            if v.is_finite() {
                return v;
            }
        }
    }
    if let Ok(Some(s)) = row.try_get::<_, Option<String>>(col) {
        if let Ok(v) = s.parse::<f64>() {
            if v.is_finite() {
                return v;
            }
        }
    }
    0.0
}

fn f64_cell(row: &tokio_postgres::Row, col: &str) -> f64 {
    parse_f64_cell(row, col)
}

fn i32_cell(row: &tokio_postgres::Row, col: &str) -> i32 {
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return i32::try_from(v).unwrap_or(0);
    }
    0
}

fn i64_cell(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return i64::from(v);
    }
    0
}

fn opt_i64(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return Some(v);
    }
    None
}
