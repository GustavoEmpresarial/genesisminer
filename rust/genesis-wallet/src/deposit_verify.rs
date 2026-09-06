//! Player deposit verify orchestration — Node `deposit-verify.ts`.
//!
//! Settings + cooldown + pending `app_cache` + receipt resolve + credit.
//! RPC stays in `deposit_receipt.rs`. Fail-closed.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use deadpool_postgres::Pool;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::deposit::run_deposit_credit;
use crate::deposit_receipt::{run_resolve_deposit_receipt, DepositSettingsPayload};
use crate::errors::{WalletError, HTTP_FORBIDDEN, HTTP_INTERNAL};
use crate::pg_types::pg_user_id;
use crate::util::normalize_evm_address_lower;

/// Node `VERIFY_COOLDOWN_MS`.
pub const VERIFY_COOLDOWN_MS: i64 = 25_000;
const _: () = assert!(VERIFY_COOLDOWN_MS == 25_000);

pub const DEPOSIT_VERIFY_PATH: &str = "/v1/wallet/deposit/verify";

const HTTP_OK: u16 = 200;
const TX_HASH_HEX_LEN: usize = 64;
const TX_HASH_TOTAL_LEN: usize = 2 + TX_HASH_HEX_LEN;
const DEFAULT_NETWORK: &str = "polygon";
const DEPOSIT_PENDING_KEY_PREFIX: &str = "deposit_pending:";
const COOLDOWN_KEY_PREFIX: &str = "dv:";

const DEPOSIT_SETTINGS_KEYS: &[&str] = &[
    "web3_deposit_wallet",
    "web3_deposit_token_contract",
    "web3_deposit_token_contract_bnb",
    "web3_deposit_token_contract_base",
    "web3_min_deposit_usdc",
    "web3_deposit_polygon_disabled",
    "web3_deposit_bnb_disabled",
    "web3_deposit_base_disabled",
];

const DEPOSIT_PENDING_MESSAGE: &str =
    "Transação ainda na mempool ou RPC indisponível. Os USDC serão creditados automaticamente quando a rede confirmar — pode fechar esta página.";
const DEPOSIT_COOLDOWN_MESSAGE: &str =
    "Verificação em cooldown. Os USDC serão creditados automaticamente quando a rede confirmar — pode fechar esta página.";

static VERIFY_COOLDOWN: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

fn cooldown_map() -> &'static Mutex<HashMap<String, i64>> {
    VERIFY_COOLDOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositVerifyRequest {
    pub user_id: i64,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub tx_hash: Option<String>,
    #[serde(default)]
    pub network: Option<String>,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct DepositVerifyHttp {
    pub status: u16,
    pub body: Value,
}

struct DepositSettingsRecord {
    payload: DepositSettingsPayload,
    web3_min_deposit_usdc: Option<String>,
    web3_deposit_polygon_disabled: Option<String>,
    web3_deposit_bnb_disabled: Option<String>,
    web3_deposit_base_disabled: Option<String>,
}

fn settings_flag_on(v: Option<&str>) -> bool {
    let s = v.unwrap_or("").trim().to_ascii_lowercase();
    s == "1" || s == "true" || s == "yes" || s == "on"
}

fn is_deposit_network_disabled(settings: &DepositSettingsRecord, network: &str) -> bool {
    let n = if network.is_empty() {
        DEFAULT_NETWORK
    } else {
        network
    }
    .to_ascii_lowercase();
    if n == "polygon" || n == "matic" {
        return settings_flag_on(settings.web3_deposit_polygon_disabled.as_deref());
    }
    if n == "bnb" || n == "bsc" {
        return settings_flag_on(settings.web3_deposit_bnb_disabled.as_deref());
    }
    if n == "base" {
        return settings_flag_on(settings.web3_deposit_base_disabled.as_deref());
    }
    true
}

fn normalize_tx_hash(raw: &str) -> Result<String, WalletError> {
    let t = raw.trim().to_ascii_lowercase();
    if t.len() != TX_HASH_TOTAL_LEN || !t.starts_with("0x") {
        return Err(WalletError::bad(
            "Hash de transação inválido (64 hex após 0x).",
        ));
    }
    if !t.as_bytes()[2..].iter().all(|b| b.is_ascii_hexdigit()) {
        return Err(WalletError::bad(
            "Hash de transação inválido (64 hex após 0x).",
        ));
    }
    Ok(t)
}

fn pending_cache_key(tx_hash: &str) -> String {
    format!("{DEPOSIT_PENDING_KEY_PREFIX}{tx_hash}")
}

fn is_resolve_timeout_or_unreachable(err: &WalletError) -> bool {
    let hay = match err {
        WalletError::Transport(e) => e.to_string(),
        WalletError::Domain { error, .. } => error.clone(),
    }
    .to_ascii_lowercase();
    hay.contains("abort") || hay.contains("timeout") || hay.contains("unreachable")
}

async fn load_deposit_settings(pool: &Pool) -> Result<DepositSettingsRecord, WalletError> {
    let conn = pool.get().await.map_err(WalletError::transport)?;
    let keys: Vec<String> = DEPOSIT_SETTINGS_KEYS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let rows = conn
        .query(
            "SELECT key, value FROM settings WHERE key = ANY($1::text[])",
            &[&keys],
        )
        .await
        .map_err(WalletError::transport)?;
    let mut kv = HashMap::new();
    for r in &rows {
        let k: String = r.get("key");
        let v: String = r.get("value");
        kv.insert(k, v);
    }
    Ok(DepositSettingsRecord {
        payload: DepositSettingsPayload {
            web3_deposit_wallet: kv.get("web3_deposit_wallet").cloned(),
            web3_deposit_token_contract: kv.get("web3_deposit_token_contract").cloned(),
            web3_deposit_token_contract_bnb: kv.get("web3_deposit_token_contract_bnb").cloned(),
            web3_deposit_token_contract_base: kv.get("web3_deposit_token_contract_base").cloned(),
        },
        web3_min_deposit_usdc: kv.get("web3_min_deposit_usdc").cloned(),
        web3_deposit_polygon_disabled: kv.get("web3_deposit_polygon_disabled").cloned(),
        web3_deposit_bnb_disabled: kv.get("web3_deposit_bnb_disabled").cloned(),
        web3_deposit_base_disabled: kv.get("web3_deposit_base_disabled").cloned(),
    })
}

async fn load_user_known_wallet_addresses(
    pool: &Pool,
    user_id: i64,
) -> Result<HashSet<String>, WalletError> {
    let mut out = HashSet::new();
    if user_id <= 0 {
        return Ok(out);
    }
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let conn = pool.get().await.map_err(WalletError::transport)?;
    let cur = conn
        .query(
            "SELECT lower(trim(COALESCE(polygon_wallet::text, ''))) AS w FROM users WHERE id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    if let Some(row) = cur.first() {
        let w: Option<String> = row.get("w");
        if let Some(k) = w.as_deref().and_then(normalize_evm_address_lower) {
            out.insert(k);
        }
    }
    let hist = conn
        .query(
            "SELECT wallet_address, previous_wallet_address, new_wallet_address
             FROM user_wallet_history
             WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    for row in &hist {
        for col in [
            "wallet_address",
            "previous_wallet_address",
            "new_wallet_address",
        ] {
            let raw: Option<String> = row.get(col);
            if let Some(k) = raw.as_deref().and_then(normalize_evm_address_lower) {
                out.insert(k);
            }
        }
    }
    Ok(out)
}

async fn queue_deposit_pending(
    pool: &Pool,
    tx_hash: &str,
    payload: Value,
) -> Result<(), WalletError> {
    let key = pending_cache_key(tx_hash);
    let conn = pool.get().await.map_err(WalletError::transport)?;
    conn.execute(
        "INSERT INTO app_cache (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()",
        &[&key, &payload],
    )
    .await
    .map_err(WalletError::transport)?;
    Ok(())
}

async fn delete_deposit_pending(pool: &Pool, tx_hash: &str) -> Result<(), WalletError> {
    let key = pending_cache_key(tx_hash);
    let conn = pool.get().await.map_err(WalletError::transport)?;
    conn.execute("DELETE FROM app_cache WHERE key = $1", &[&key])
        .await
        .map_err(WalletError::transport)?;
    Ok(())
}

fn pending_http() -> DepositVerifyHttp {
    DepositVerifyHttp {
        status: HTTP_OK,
        body: json!({
            "ok": false,
            "pending": true,
            "message": DEPOSIT_PENDING_MESSAGE
        }),
    }
}

async fn try_credit_from_receipt(
    pool: &Pool,
    uid: i64,
    tx_hash: &str,
    net: &str,
    settings: &DepositSettingsRecord,
    amount_usdc: f64,
    wallet_address: &str,
    token_contract: Option<&str>,
    now: i64,
) -> Result<DepositVerifyHttp, WalletError> {
    if is_deposit_network_disabled(settings, net) {
        return Err(WalletError::bad(
            "Depósitos nesta rede estão desativados pelo administrador.",
        ));
    }
    let known = load_user_known_wallet_addresses(pool, uid).await?;
    let from_addr = wallet_address.to_ascii_lowercase();
    if known.is_empty() {
        return Err(WalletError::bad(
            "Regista a carteira Polygon no perfil; só podes validar depósitos enviados dessa carteira.",
        ));
    }
    if from_addr.is_empty() || !known.contains(&from_addr) {
        return Err(WalletError::bad(
            "Este envio não foi feito por uma carteira já ligada à tua conta (remetente do token não coincide).",
        ));
    }
    if !amount_usdc.is_finite() || amount_usdc <= 0.0 {
        return Err(WalletError::bad("Valor zero na transação"));
    }
    let min_usdc = settings
        .web3_min_deposit_usdc
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0);
    if min_usdc > 0.0 && amount_usdc < min_usdc {
        return Err(WalletError::bad(format!(
            "Valor depositado ({amount_usdc}) é menor que o mínimo permitido ({min_usdc})"
        )));
    }
    let out = run_deposit_credit(
        pool,
        uid,
        tx_hash,
        net,
        amount_usdc,
        &from_addr,
        token_contract,
        Some(now),
    )
    .await?;
    let _ = delete_deposit_pending(pool, tx_hash).await;
    Ok(DepositVerifyHttp {
        status: HTTP_OK,
        body: json!({
            "ok": true,
            "amount": out.amount,
            "newUsdc": out.new_usdc,
            "already": out.already.unwrap_or(false)
        }),
    })
}

pub async fn run_deposit_verify(
    pool: &Pool,
    http: &reqwest::Client,
    req: DepositVerifyRequest,
) -> Result<DepositVerifyHttp, WalletError> {
    let uid = req.user_id;
    if uid <= 0 {
        return Err(WalletError::unauthorized(
            "Sessão necessária para verificar depósito.",
        ));
    }
    let tx_norm = normalize_tx_hash(req.tx_hash.as_deref().unwrap_or(""))?;
    let pg_uid = pg_user_id(uid).map_err(WalletError::transport)?;

    let conn = pool.get().await.map_err(WalletError::transport)?;
    let who = conn
        .query(
            "SELECT lower(trim(COALESCE(email::text, ''))) AS em, polygon_wallet FROM users WHERE id = $1",
            &[&pg_uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(row) = who.first() else {
        return Err(WalletError::unauthorized("Utilizador inválido."));
    };
    let db_email: String = row.get("em");
    let body_email = req
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !body_email.is_empty() && !db_email.is_empty() && body_email != db_email {
        return Err(WalletError::domain(
            HTTP_FORBIDDEN,
            "O email não corresponde à sessão autenticada.",
        ));
    }
    let pw: Option<String> = row.get("polygon_wallet");
    let pw_str = pw.as_deref().unwrap_or("").trim();
    let pw_l = pw_str.to_ascii_lowercase();
    if pw_str.is_empty() || pw_l == "0x" || pw_l == "null" {
        return Err(WalletError::bad(
            "Conecte uma carteira antes de usar depósitos ou saques em cripto.",
        ));
    }

    let now = req.server_now_ms.unwrap_or_else(current_unix_ms);
    let cooldown_key = format!("{COOLDOWN_KEY_PREFIX}{uid}:{tx_norm}");
    {
        let mut map = cooldown_map().lock();
        let until = map.get(&cooldown_key).copied().unwrap_or(0);
        if until > now {
            return Ok(DepositVerifyHttp {
                status: HTTP_OK,
                body: json!({
                    "ok": false,
                    "pending": true,
                    "message": DEPOSIT_COOLDOWN_MESSAGE
                }),
            });
        }
        map.insert(cooldown_key, now + VERIFY_COOLDOWN_MS);
    }

    let action_key = format!("tx_{tx_norm}");
    let check_tx = conn
        .query(
            "SELECT user_id FROM daily_actions WHERE action_key = $1",
            &[&action_key],
        )
        .await
        .map_err(WalletError::transport)?;
    if let Some(owned) = check_tx.first() {
        let owner: i32 = owned.get("user_id");
        if i64::from(owner) != uid {
            return Err(WalletError::bad(
                "Esta transação já foi utilizada por outra conta.",
            ));
        }
        let bal = conn
            .query(
                "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
                &[&pg_uid],
            )
            .await
            .map_err(WalletError::transport)?;
        let new_usdc = bal
            .first()
            .map(|r| r.get::<_, Option<f64>>("usdc").unwrap_or(0.0))
            .unwrap_or(0.0);
        drop(conn);
        let _ = delete_deposit_pending(pool, &tx_norm).await;
        return Ok(DepositVerifyHttp {
            status: HTTP_OK,
            body: json!({
                "ok": true,
                "amount": 0.0,
                "newUsdc": new_usdc,
                "already": true
            }),
        });
    }
    drop(conn);

    let settings = load_deposit_settings(pool).await?;
    let network = req
        .network
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_NETWORK);
    if is_deposit_network_disabled(&settings, network) {
        return Err(WalletError::domain(
            HTTP_FORBIDDEN,
            "Depósitos nesta rede estão desativados.",
        ));
    }

    let receipt =
        match run_resolve_deposit_receipt(http, &tx_norm, network, &settings.payload).await {
            Ok(r) => r,
            Err(e) => {
                if is_resolve_timeout_or_unreachable(&e) {
                    queue_deposit_pending(
                        pool,
                        &tx_norm,
                        json!({ "userId": uid, "network": network, "createdAt": now }),
                    )
                    .await?;
                    return Ok(pending_http());
                }
                if let WalletError::Domain { error, status, .. } = &e {
                    if error.starts_with("Rede") {
                        return Err(WalletError::bad(error.clone()));
                    }
                    if *status == HTTP_INTERNAL {
                        return Err(e);
                    }
                }
                return Err(e);
            }
        };

    if receipt.pending.unwrap_or(false) {
        queue_deposit_pending(
            pool,
            &tx_norm,
            json!({ "userId": uid, "network": network, "createdAt": now }),
        )
        .await?;
        return Ok(pending_http());
    }

    let amount = receipt.amount_usdc.unwrap_or(0.0);
    let wallet = receipt.wallet_address.unwrap_or_default();
    let token = receipt.token_contract;
    try_credit_from_receipt(
        pool,
        uid,
        &tx_norm,
        network,
        &settings,
        amount,
        &wallet,
        token.as_deref(),
        now,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_cooldown_matches_node() {
        assert_eq!(VERIFY_COOLDOWN_MS, 25_000);
        assert_eq!(DEPOSIT_VERIFY_PATH, "/v1/wallet/deposit/verify");
        assert_eq!(pending_cache_key("0xabc"), "deposit_pending:0xabc");
    }

    #[test]
    fn settings_flag_and_disabled_networks() {
        let s = DepositSettingsRecord {
            payload: DepositSettingsPayload {
                web3_deposit_wallet: None,
                web3_deposit_token_contract: None,
                web3_deposit_token_contract_bnb: None,
                web3_deposit_token_contract_base: None,
            },
            web3_min_deposit_usdc: None,
            web3_deposit_polygon_disabled: Some("1".into()),
            web3_deposit_bnb_disabled: Some("false".into()),
            web3_deposit_base_disabled: Some("on".into()),
        };
        assert!(is_deposit_network_disabled(&s, "polygon"));
        assert!(!is_deposit_network_disabled(&s, "bnb"));
        assert!(is_deposit_network_disabled(&s, "base"));
        assert!(is_deposit_network_disabled(&s, "unknown"));
        assert!(settings_flag_on(Some("yes")));
        assert!(!settings_flag_on(Some("0")));
    }

    #[test]
    fn tx_hash_rejects_short() {
        assert!(normalize_tx_hash("0x123").is_err());
        assert!(normalize_tx_hash(&format!("0x{}", "a".repeat(TX_HASH_HEX_LEN))).is_ok());
    }
}
