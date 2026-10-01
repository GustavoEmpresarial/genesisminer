//! Admin wallet history — Node `wallet-history.ts`.
//! Reuses profile wallet SQL; remaps `wallet` → `currentWallet` + `status`.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;
use crate::profile_writes::run_wallet_get;

use super::{CODE_NOT_FOUND, CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_NOT_FOUND};

pub const ADMIN_WALLET_HISTORY_PATH: &str = "/v1/admin/users/wallet-history";

const ERR_INVALID_USER: &str = "Invalid user id.";
const ERR_USER_NOT_FOUND: &str = "User not found.";
const DEFAULT_NETWORK: &str = "polygon";

/// Node `parseAdminWalletHistoryUserId` — positive decimal integer string.
pub fn parse_admin_wallet_history_user_id(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.starts_with('0') {
        return None;
    }
    let n: i64 = s.parse().ok()?;
    if n <= 0 {
        return None;
    }
    Some(n)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminWalletHistoryRequest {
    pub user_id: i64,
}

pub async fn run_admin_wallet_history(
    pool: &Pool,
    req: &AdminWalletHistoryRequest,
) -> Result<Value, PlayerReadError> {
    if req.user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            ERR_INVALID_USER,
            CODE_VALIDATION,
        ));
    }

    let exists = {
        let uid = crate::player_reads::pg_user_id(req.user_id)?;
        let conn = pool.get().await?;
        conn.query_opt("SELECT 1 FROM users WHERE id = $1", &[&uid])
            .await?
    };
    if exists.is_none() {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    }

    let raw = run_wallet_get(pool, req.user_id, None).await?;
    let wallet = raw.get("wallet").cloned().unwrap_or(Value::Null);
    let history = raw.get("history").cloned().unwrap_or(json!([]));

    let current_wallet = match wallet.as_object() {
        Some(w) => {
            let address = w
                .get("address")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if address.is_empty() {
                Value::Null
            } else {
                let network = w
                    .get("network")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_NETWORK);
                let connected_at = w.get("connectedAt").cloned().unwrap_or(Value::Null);
                json!({
                    "address": address,
                    "network": network,
                    "connectedAt": connected_at,
                    "status": "connected"
                })
            }
        }
        None => Value::Null,
    };

    Ok(json!({
        "currentWallet": current_wallet,
        "history": history
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_is_stable() {
        assert_eq!(ADMIN_WALLET_HISTORY_PATH, "/v1/admin/users/wallet-history");
    }

    #[test]
    fn parse_user_id_matches_node() {
        assert_eq!(parse_admin_wallet_history_user_id("10"), Some(10));
        assert_eq!(parse_admin_wallet_history_user_id(" 99 "), Some(99));
        assert_eq!(parse_admin_wallet_history_user_id("0"), None);
        assert_eq!(parse_admin_wallet_history_user_id("01"), None);
        assert_eq!(parse_admin_wallet_history_user_id("-1"), None);
        assert_eq!(parse_admin_wallet_history_user_id("abc"), None);
        assert_eq!(parse_admin_wallet_history_user_id(""), None);
        assert_eq!(parse_admin_wallet_history_user_id("1.5"), None);
    }
}
