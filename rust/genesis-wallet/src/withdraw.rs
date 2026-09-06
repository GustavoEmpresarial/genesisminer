//! Withdraw request — debit mined balance + pending row (zero on-chain send).

use deadpool_postgres::{GenericClient, Pool};
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use uuid::Uuid;

use crate::config::{current_unix_ms, WALLET_LOCK_TIMEOUT_MS, WALLET_STATEMENT_TIMEOUT_MS};
use crate::errors::{WalletError, CODE_VALIDATION};
use crate::pg_types::pg_user_id;
use crate::util::{
    assert_active_user, checksum_evm_address, compute_advisory_lock_key64,
    require_idem_fingerprint, require_nonempty_json_str,
};

/// Node `WITHDRAW_IDEM_SCOPE`.
pub const WITHDRAW_IDEM_SCOPE: &str = "withdraw_request";
/// Node `PERCENT` clamp for fee.
const FEE_PERCENT_MIN: f64 = 0.0;
const FEE_PERCENT_MAX: f64 = 100.0;
const PERCENT_BASE: f64 = 100.0;
/// Node balance / min compare epsilon (`1e-9`).
const BALANCE_EPSILON: f64 = 1e-9;
/// Node `COIN_ID_RE` length bound.
const COIN_ID_MAX_LEN: usize = 80;
const NATIVE_TOKEN_NAMES: &[&str] = &["POL", "POLYGON", "BNB", "ETH", "WETH"];

pub const WITHDRAW_REQUEST_PATH: &str = "/v1/wallet/withdraw/request";

const WITHDRAW_OK_MESSAGE: &str =
    "Solicitação de saque enviada com sucesso. O saque será confirmado em até 24 horas.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawOk {
    pub ok: bool,
    pub request_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub idempotent_replay: bool,
}

fn is_valid_coin_id(id: &str) -> bool {
    if id.is_empty() || id.len() > COIN_ID_MAX_LEN {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn norm_compare(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn is_withdraw_token_usable(cfg: &Value) -> bool {
    if cfg
        .get("disabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return false;
    }
    let sym = cfg
        .get("symbol")
        .or_else(|| cfg.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    let is_native = NATIVE_TOKEN_NAMES.contains(&sym.as_str());
    let contract = cfg.get("contract").and_then(|v| v.as_str()).unwrap_or("");
    let has_valid_contract = checksum_evm_address(contract).is_ok();
    is_native || has_valid_contract
}

fn find_withdraw_token_cfg<'a>(
    tokens: &'a [Value],
    coin_id: &str,
    symbol: &str,
    name: &str,
) -> Option<&'a Value> {
    let coin_id = norm_compare(coin_id);
    let coin_sym = norm_compare(symbol);
    let coin_nm = norm_compare(name);
    if coin_id.is_empty() && coin_sym.is_empty() && coin_nm.is_empty() {
        return None;
    }
    for t in tokens {
        let cfg_id = t
            .get("coinId")
            .and_then(|v| v.as_str())
            .map(norm_compare)
            .unwrap_or_default();
        let cfg_sym = t
            .get("symbol")
            .and_then(|v| v.as_str())
            .map(norm_compare)
            .unwrap_or_default();
        let cfg_nm = t
            .get("name")
            .and_then(|v| v.as_str())
            .map(norm_compare)
            .unwrap_or_default();
        if !coin_id.is_empty() && cfg_id == coin_id {
            return Some(t);
        }
        if !coin_id.is_empty() && cfg_nm == coin_id {
            return Some(t);
        }
        if !coin_sym.is_empty() && (cfg_sym == coin_sym || cfg_nm == coin_sym) {
            return Some(t);
        }
        if !coin_nm.is_empty() && (cfg_nm == coin_nm || cfg_sym == coin_nm) {
            return Some(t);
        }
    }
    None
}

fn parse_withdraw_tokens(raw: Option<&str>) -> Vec<Value> {
    let Some(raw) = raw.filter(|s| !s.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(a)) => a,
        _ => Vec::new(),
    }
}

fn json_num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
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

pub async fn run_withdraw_request(
    pool: &Pool,
    user_id: i64,
    coin_id: &str,
    amount: f64,
    wallet_address: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
    server_now_ms: Option<i64>,
    withdraw_tokens_raw: Option<&str>,
) -> Result<WithdrawOk, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::unauthorized("Não autenticado."));
    }
    let coin_id = coin_id.trim();
    if !is_valid_coin_id(coin_id) {
        return Err(WalletError::bad("Moeda inválida."));
    }
    if !amount.is_finite() || amount <= 0.0 {
        return Err(WalletError::bad("Valor de saque inválido."));
    }
    let req_norm = checksum_evm_address(wallet_address).map_err(|_| {
        WalletError::bad_code(
            "Informe uma carteira Polygon (EVM) válida (0x + 40 hex).",
            CODE_VALIDATION,
        )
    })?;
    let idem = idempotency_key.trim();
    if idem.is_empty() {
        return Err(WalletError::bad_code(
            "idempotencyKey inválido ou ausente (8–128 caracteres seguros).",
            "IDEMPOTENCY_KEY_REQUIRED",
        ));
    }
    let server_now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let tokens = parse_withdraw_tokens(withdraw_tokens_raw);

    // genesis-api forwards the raw client body without a fingerprint; derive a
    // deterministic one from the request params so an idempotency-key replay with
    // different coin/amount/address still conflicts.
    let derived_fp;
    let request_fingerprint: &str = if request_fingerprint.trim().is_empty() {
        let mut hasher = Sha1::new();
        hasher.update(format!("withdraw|{coin_id}|{amount:.12}|{req_norm}").as_bytes());
        derived_fp = hex::encode(hasher.finalize());
        derived_fp.as_str()
    } else {
        request_fingerprint
    };

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let result = run_inner(
        &tx,
        uid,
        user_id,
        coin_id,
        amount,
        &req_norm,
        idem,
        request_fingerprint,
        server_now,
        &tokens,
    )
    .await;
    finish_tx(tx, result).await
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    coin_id: &str,
    amount: f64,
    req_norm: &str,
    idem: &str,
    request_fingerprint: &str,
    server_now: i64,
    tokens: &[Value],
) -> Result<WithdrawOk, WalletError> {
    client
        .batch_execute(&format!(
            "SET LOCAL statement_timeout = {WALLET_STATEMENT_TIMEOUT_MS}; SET LOCAL lock_timeout = {WALLET_LOCK_TIMEOUT_MS}"
        ))
        .await
        .map_err(WalletError::transport)?;
    assert_active_user(client, user_id).await?;

    let req_fp = require_idem_fingerprint(Some(request_fingerprint))?;
    let lock_key = compute_advisory_lock_key64(user_id, WITHDRAW_IDEM_SCOPE, idem);
    client
        .query("SELECT pg_advisory_xact_lock($1::bigint)", &[&lock_key])
        .await
        .map_err(WalletError::transport)?;

    let uw = client
        .query(
            "SELECT polygon_wallet FROM users WHERE id = $1 FOR UPDATE",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let stored_raw = uw
        .first()
        .and_then(|r| r.get::<_, Option<String>>("polygon_wallet"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if stored_raw.is_empty() || matches!(stored_raw.to_ascii_lowercase().as_str(), "0x" | "null") {
        return Err(WalletError::bad(
            "Conecte uma carteira antes de usar depósitos ou saques em cripto.",
        ));
    }
    let stored_norm = checksum_evm_address(&stored_raw).map_err(|_| {
        WalletError::bad("Carteira de saque inválida no perfil. Reconecte a carteira no perfil.")
    })?;
    if stored_norm.to_ascii_lowercase() != req_norm.to_ascii_lowercase() {
        return Err(WalletError::bad(
            "O endereço de saque deve coincidir com a carteira conectada no perfil.",
        ));
    }

    let prev = client
        .query(
            "SELECT response_json, request_fingerprint::text AS request_fingerprint
             FROM wallet_idempotency
             WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE",
            &[&uid, &WITHDRAW_IDEM_SCOPE, &idem],
        )
        .await
        .map_err(WalletError::transport)?;
    if let Some(row) = prev.first() {
        let response_json: String = row.get("response_json");
        if let Ok(parsed) = serde_json::from_str::<Value>(&response_json) {
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                let stored_fp: Option<String> = row.get("request_fingerprint");
                let stored_fp = stored_fp.unwrap_or_default().trim().to_string();
                if !stored_fp.is_empty() && stored_fp != req_fp {
                    return Err(WalletError::conflict_mismatch(
                        "Mesma chave de idempotência com pedido diferente.",
                    ));
                }
                return Ok(WithdrawOk {
                    ok: true,
                    request_id: require_nonempty_json_str(&parsed, "requestId")?,
                    message: require_nonempty_json_str(&parsed, "message")?,
                    idempotent_replay: true,
                });
            }
        }
    }

    let coin_rows = client
        .query(
            "SELECT id, usdc_rate::float8 AS usdc_rate, symbol, name, is_active FROM mining_coins WHERE id = $1",
            &[&coin_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(coin) = coin_rows.first() else {
        return Err(WalletError::bad("Moeda não encontrada ou inativa."));
    };
    let is_active: i32 = coin.get("is_active");
    if is_active == 0 {
        return Err(WalletError::bad("Moeda não encontrada ou inativa."));
    }
    let symbol: String = coin.get("symbol");
    let name: String = coin.get("name");
    let id: String = coin.get("id");
    let usdc_rate: f64 = coin.get::<_, Option<f64>>("usdc_rate").unwrap_or(0.0);
    let sym = if !symbol.is_empty() {
        symbol.clone()
    } else if !name.is_empty() {
        name.clone()
    } else {
        id.clone()
    };

    let Some(token_cfg) = find_withdraw_token_cfg(tokens, &id, &symbol, &name) else {
        return Err(WalletError::bad(format!(
            "{sym} não está configurado para saque no painel administrativo."
        )));
    };
    if !is_withdraw_token_usable(token_cfg) {
        return Err(WalletError::bad(format!(
            "Saque indisponível para {sym}. Confirma a configuração no painel administrativo."
        )));
    }
    if token_cfg
        .get("disabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(WalletError::bad(format!(
            "Saques para {sym} estão desativados no momento."
        )));
    }

    let fee_percent = json_num(token_cfg.get("feePercent")).clamp(FEE_PERCENT_MIN, FEE_PERCENT_MAX);
    let fee_amount = amount * (fee_percent / PERCENT_BASE);
    let net_amount = (amount - fee_amount).max(0.0);
    let amount_usdc = amount * usdc_rate;
    let min_amount_raw = json_num(token_cfg.get("minAmount"));
    let min_by_coin = if min_amount_raw.is_finite() && min_amount_raw > 0.0 {
        min_amount_raw
    } else {
        0.0
    };
    let min_usdc_raw = json_num(token_cfg.get("minWithdrawalUsdc"));
    let min_by_usdc = if min_usdc_raw.is_finite() && min_usdc_raw > 0.0 && usdc_rate > 0.0 {
        min_usdc_raw / usdc_rate
    } else {
        0.0
    };
    let minimum_required = min_by_coin.max(min_by_usdc);
    if minimum_required > 0.0 && amount + BALANCE_EPSILON < minimum_required {
        return Err(WalletError::bad(format!(
            "O valor mínimo para saque de {sym} é {minimum_required} {sym} (valor bruto a debitar do saldo minerado)."
        )));
    }

    let gs = client
        .query(
            "SELECT user_id FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    if gs.is_empty() {
        return Err(WalletError::bad(
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
    if balance + BALANCE_EPSILON < amount {
        return Err(WalletError::bad(format!(
            "Saldo insuficiente. Tens {balance} {sym} disponível; este saque requer {sym} em valor bruto."
        )));
    }

    let upd = client
        .execute(
            "UPDATE coin_balances SET amount = amount - $1 WHERE user_id = $2 AND coin_id = $3 AND amount >= $1",
            &[&amount, &uid, &coin_id],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd == 0 {
        return Err(WalletError::bad(format!(
            "Saldo insuficiente. Tens {balance} {sym} disponível."
        )));
    }

    let request_id = Uuid::new_v4().to_string();
    client
        .execute(
            "INSERT INTO withdrawal_requests (id, user_id, coin_id, amount_crypto, amount_usdc, fee_amount, net_amount, wallet_address, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)",
            &[
                &request_id,
                &uid,
                &coin_id,
                &amount,
                &amount_usdc,
                &fee_amount,
                &net_amount,
                &req_norm,
                &server_now,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    let out = WithdrawOk {
        ok: true,
        request_id: request_id.clone(),
        message: WITHDRAW_OK_MESSAGE.to_string(),
        idempotent_replay: false,
    };
    let fp = req_fp;
    let response_json = json!({
        "ok": true,
        "requestId": request_id,
        "message": WITHDRAW_OK_MESSAGE
    })
    .to_string();
    client
        .execute(
            "INSERT INTO wallet_idempotency (user_id, scope, idempotency_key, response_json, request_fingerprint, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &uid,
                &WITHDRAW_IDEM_SCOPE,
                &idem,
                &response_json,
                &fp,
                &server_now,
            ],
        )
        .await
        .map_err(WalletError::transport)?;

    Ok(out)
}
