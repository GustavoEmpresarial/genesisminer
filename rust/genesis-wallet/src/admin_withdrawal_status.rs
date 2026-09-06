//! Admin withdrawal status — `pending` → `completed` | `rejected` (+ refund).
//!
//! Mirrors Node `runAdminWithdrawalStatusUpdate`. Admin auth stays in Node;
//! this worker only runs the money TX (FOR UPDATE + optional coin_balances refund).

use deadpool_postgres::{GenericClient, Pool};
use serde::Serialize;

use crate::config::current_unix_ms;
use crate::errors::WalletError;

/// Node `REQUEST_ID_MAX`.
const REQUEST_ID_MAX: usize = 80;
/// Node `TX_HASH_MAX`.
const TX_HASH_MAX: usize = 128;
const STATUS_COMPLETED: &str = "completed";
const STATUS_REJECTED: &str = "rejected";
const STATUS_PENDING: &str = "pending";

const MSG_COMPLETED: &str = "Solicitação marcada como concluída.";
const MSG_REJECTED: &str = "Solicitação rejeitada e estornada.";
const ERR_INVALID: &str = "Dados inválidos";
const ERR_NOT_FOUND: &str = "Solicitação não encontrada";
const ERR_ALREADY: &str = "Esta solicitação já foi processada";

pub const ADMIN_WITHDRAWAL_STATUS_PATH: &str = "/v1/wallet/admin/withdrawals/status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWithdrawalStatusOk {
    pub ok: bool,
    pub message: String,
}

fn parse_request_id(raw: &str) -> Result<String, WalletError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > REQUEST_ID_MAX {
        return Err(WalletError::bad(ERR_INVALID));
    }
    Ok(id.to_string())
}

fn parse_status(raw: &str) -> Result<&'static str, WalletError> {
    match raw.trim() {
        STATUS_COMPLETED => Ok(STATUS_COMPLETED),
        STATUS_REJECTED => Ok(STATUS_REJECTED),
        _ => Err(WalletError::bad(ERR_INVALID)),
    }
}

fn parse_tx_hash(raw: Option<&str>) -> Result<Option<String>, WalletError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.len() > TX_HASH_MAX {
        return Err(WalletError::bad(ERR_INVALID));
    }
    Ok(Some(t.to_string()))
}

pub async fn run_admin_withdrawal_status(
    pool: &Pool,
    request_id: &str,
    status: &str,
    tx_hash: Option<&str>,
    server_now_ms: Option<i64>,
) -> Result<AdminWithdrawalStatusOk, WalletError> {
    let request_id = parse_request_id(request_id)?;
    let status = parse_status(status)?;
    let tx_hash = parse_tx_hash(tx_hash)?;
    let now_ms = server_now_ms.unwrap_or_else(current_unix_ms);

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let out = match run_inner(&tx, &request_id, status, tx_hash.as_deref(), now_ms).await {
        Ok(o) => {
            tx.commit().await.map_err(WalletError::transport)?;
            o
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };
    Ok(out)
}

async fn run_inner<C: GenericClient>(
    client: &C,
    request_id: &str,
    status: &str,
    tx_hash: Option<&str>,
    now_ms: i64,
) -> Result<AdminWithdrawalStatusOk, WalletError> {
    let req_rows = client
        .query(
            "SELECT user_id, coin_id, amount_crypto::float8 AS amount_crypto, status
               FROM withdrawal_requests WHERE id = $1 FOR UPDATE",
            &[&request_id],
        )
        .await
        .map_err(WalletError::transport)?;
    let Some(row) = req_rows.first() else {
        return Err(WalletError::not_found(ERR_NOT_FOUND));
    };

    let user_id: i32 = row.get("user_id");
    let coin_id: String = row.get("coin_id");
    let amount_crypto: f64 = row.get("amount_crypto");
    let current_status: String = row.get("status");

    if current_status != STATUS_PENDING {
        return Err(WalletError::bad(ERR_ALREADY));
    }

    if status == STATUS_REJECTED {
        client
            .execute(
                "INSERT INTO coin_balances (user_id, coin_id, amount)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, coin_id)
                 DO UPDATE SET amount = coin_balances.amount + EXCLUDED.amount",
                &[&user_id, &coin_id, &amount_crypto],
            )
            .await
            .map_err(WalletError::transport)?;
    }

    client
        .execute(
            "UPDATE withdrawal_requests SET status = $1, processed_at = $2, tx_hash = $3 WHERE id = $4",
            &[&status, &now_ms, &tx_hash, &request_id],
        )
        .await
        .map_err(WalletError::transport)?;

    Ok(AdminWithdrawalStatusOk {
        ok: true,
        message: if status == STATUS_COMPLETED {
            MSG_COMPLETED.to_string()
        } else {
            MSG_REJECTED.to_string()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_bad_status() {
        assert!(parse_status("pending").is_err());
        assert!(parse_status("cancelled").is_err());
        assert_eq!(parse_status("completed").unwrap(), STATUS_COMPLETED);
        assert_eq!(parse_status("rejected").unwrap(), STATUS_REJECTED);
    }

    #[test]
    fn parse_request_id_bounds() {
        assert!(parse_request_id("").is_err());
        assert!(parse_request_id(&"x".repeat(REQUEST_ID_MAX + 1)).is_err());
        assert_eq!(parse_request_id("wd-1").unwrap(), "wd-1");
    }

    #[test]
    fn parse_tx_hash_optional() {
        assert_eq!(parse_tx_hash(None).unwrap(), None);
        assert_eq!(parse_tx_hash(Some("")).unwrap(), None);
        assert_eq!(
            parse_tx_hash(Some("0xabc")).unwrap(),
            Some("0xabc".to_string())
        );
        assert!(parse_tx_hash(Some(&"x".repeat(TX_HASH_MAX + 1))).is_err());
    }
}
