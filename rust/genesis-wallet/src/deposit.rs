//! Deposit credit from already-parsed receipt (no RPC in worker).
//!
//! Global uniqueness is `user_deposit_history.tx_hash` — checked before any USDC
//! credit. `daily_actions` remains a secondary idem mark (legacy parity).

use deadpool_postgres::{GenericClient, Pool};
use serde::Serialize;
use tokio_postgres::error::SqlState;

use crate::config::current_unix_ms;
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;
use crate::util::{assert_active_user, normalize_evm_address_lower};

/// Node deposit credit advisory scope.
const DEPOSIT_CREDIT_LOCK_SCOPE: &str = "ms_deposit_credit";
/// Node network / contract string caps.
const NETWORK_MAX_LEN: usize = 32;
const TOKEN_CONTRACT_MAX_LEN: usize = 120;
/// Tx hash: `0x` + 64 hex.
const TX_HASH_HEX_LEN: usize = 64;
const TX_HASH_TOTAL_LEN: usize = 2 + TX_HASH_HEX_LEN;
/// Node / Postgres unique violation.
const PG_UNIQUE_VIOLATION: &str = "23505";

pub const DEPOSIT_CREDIT_PATH: &str = "/v1/wallet/deposit/credit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositCreditOk {
    pub ok: bool,
    pub amount: f64,
    pub new_usdc: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already: Option<bool>,
}

enum CreditOutcome {
    Fresh { amount: f64 },
    Already,
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

async fn read_usdc(pool: &Pool, uid: i32) -> Result<f64, WalletError> {
    let client = pool.get().await.map_err(WalletError::transport)?;
    let bal = client
        .query(
            "SELECT usdc::float8 AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    Ok(bal
        .first()
        .map(|r| r.get::<_, Option<f64>>("usdc").unwrap_or(0.0))
        .unwrap_or(0.0))
}

pub async fn run_deposit_credit(
    pool: &Pool,
    user_id: i64,
    tx_hash: &str,
    network: &str,
    amount_usdc: f64,
    wallet_address: &str,
    token_contract: Option<&str>,
    server_now_ms: Option<i64>,
) -> Result<DepositCreditOk, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::unauthorized(
            "Sessão necessária para verificar depósito.",
        ));
    }
    let tx_norm = normalize_tx_hash(tx_hash)?;
    if !amount_usdc.is_finite() || amount_usdc <= 0.0 {
        return Err(WalletError::bad("Valor zero na transação"));
    }
    let from_addr = normalize_evm_address_lower(wallet_address)
        .ok_or_else(|| WalletError::bad("Carteira de depósito inválida."))?;
    let network = {
        let n = network.trim();
        if n.is_empty() {
            "polygon".to_string()
        } else {
            n.chars().take(NETWORK_MAX_LEN).collect()
        }
    };
    let token = token_contract
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(TOKEN_CONTRACT_MAX_LEN).collect::<String>());
    let now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let action_key = format!("tx_{tx_norm}");

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let outcome = match run_inner(
        &tx,
        uid,
        user_id,
        &tx_norm,
        &network,
        amount_usdc,
        &from_addr,
        token.as_deref(),
        now,
        &action_key,
    )
    .await
    {
        Ok(o) => {
            tx.commit().await.map_err(WalletError::transport)?;
            o
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };

    let new_usdc = read_usdc(pool, uid).await?;
    match outcome {
        CreditOutcome::Already => Ok(DepositCreditOk {
            ok: true,
            amount: 0.0,
            new_usdc,
            already: Some(true),
        }),
        CreditOutcome::Fresh { amount } => Ok(DepositCreditOk {
            ok: true,
            amount,
            new_usdc,
            already: None,
        }),
    }
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    tx_norm: &str,
    network: &str,
    amount_usdc: f64,
    from_addr: &str,
    token_contract: Option<&str>,
    now: i64,
    action_key: &str,
) -> Result<CreditOutcome, WalletError> {
    client
        .query(
            "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
            &[&DEPOSIT_CREDIT_LOCK_SCOPE, &tx_norm],
        )
        .await
        .map_err(WalletError::transport)?;

    assert_active_user(client, user_id).await?;

    // Global uniqueness: history.tx_hash — fail-closed before any USDC credit.
    let hist = client
        .query(
            "SELECT user_id FROM user_deposit_history WHERE tx_hash = $1",
            &[&tx_norm],
        )
        .await
        .map_err(WalletError::transport)?;
    if let Some(row) = hist.first() {
        let owner: i32 = row.get("user_id");
        if i64::from(owner) != user_id {
            return Err(WalletError::bad(
                "Esta transação já foi utilizada por outra conta.",
            ));
        }
        return Ok(CreditOutcome::Already);
    }

    let dup = client
        .query(
            "SELECT user_id, last_performed_at FROM daily_actions WHERE action_key = $1",
            &[&action_key],
        )
        .await
        .map_err(WalletError::transport)?;
    if let Some(row) = dup.first() {
        let owner: i32 = row.get("user_id");
        if i64::from(owner) != user_id {
            return Err(WalletError::bad(
                "Esta transação já foi utilizada por outra conta.",
            ));
        }
        return Ok(CreditOutcome::Already);
    }

    // Claim tx_hash in history before balance bump (race-safe with unique constraint).
    match client
        .execute(
            "INSERT INTO user_deposit_history (
               user_id, tx_hash, network, amount_usdc, wallet_address, token_contract, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &uid,
                &tx_norm,
                &network,
                &amount_usdc,
                &from_addr,
                &token_contract,
                &now,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if e.code() == Some(&SqlState::UNIQUE_VIOLATION)
                || e.code()
                    .map(|c| c.code() == PG_UNIQUE_VIOLATION)
                    .unwrap_or(false)
            {
                return Err(WalletError::conflict(
                    "Esta transação já foi creditada. Reload e tenta de novo.",
                ));
            }
            return Err(WalletError::transport(e));
        }
    }

    let upd = client
        .execute(
            "UPDATE game_states SET usdc = COALESCE(usdc, 0) + $1,
              total_usdc_deposited = COALESCE(total_usdc_deposited, 0) + $1,
              server_updated_at = $2, last_updated_at = $2 WHERE user_id = $3",
            &[&amount_usdc, &now, &uid],
        )
        .await
        .map_err(WalletError::transport)?;
    if upd == 0 {
        return Err(WalletError::bad(
            "Game state has not been created yet. Enter the game (load your save) and try again.",
        ));
    }

    client
        .execute(
            "INSERT INTO daily_actions (user_id, action_key, last_performed_at) VALUES ($1, $2, $3)",
            &[&uid, &action_key, &now],
        )
        .await
        .map_err(WalletError::transport)?;

    Ok(CreditOutcome::Fresh {
        amount: amount_usdc,
    })
}
