//! Lucky-box promocode redeem — Node `POST /api/lucky-boxes/promocodes/redeem`.

use deadpool_postgres::Pool;
use serde_json::Value;

use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN};
use crate::pg_types::pg_user_id;
use crate::wheel::errors::WheelError;
use crate::wheel::promo_code::normalize_promo_code;
use crate::wheel::promo_redeem::{
    run_promo_code_redeem_in_transaction, set_promo_tx_timeouts,
    LOCK_TIMEOUT_MS as WHEEL_LOCK_TIMEOUT_MS, TX_TIMEOUT_MS,
};

use super::errors::{LuckyBoxError, ERR_INVALID_SESSION, HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_OK};

/// Node `TX_TIMEOUT_MS` (lucky-boxes.controller).
pub const TX_TIMEOUT_MS_LB: u64 = TX_TIMEOUT_MS;
/// Node `LOCK_TIMEOUT_MS` via shared promo redeem.
pub const LOCK_TIMEOUT_MS: u64 = WHEEL_LOCK_TIMEOUT_MS;
/// Node idem scope `promo_redeem`.
pub const PROMO_REDEEM_SCOPE: &str = "promo_redeem";
/// Node `IDEMPOTENCY_KEY_MAX_LENGTH`.
pub const IDEMPOTENCY_KEY_MAX_LENGTH: usize = IDEMPOTENCY_KEY_MAX_LEN;
/// Node error code on idem unique conflict inside TX.
pub const CODE_IDEMPOTENCY_CONFLICT: &str = "IDEMPOTENCY_CONFLICT";
pub const ERR_IDEMPOTENCY_CONFLICT: &str = "Pedido duplicado em curso.";
pub const ERR_INVALID_CODE: &str = "Invalid code.";

const _: () = assert!(TX_TIMEOUT_MS_LB == 60_000);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(BUY_LOCK_TIMEOUT_MS == LOCK_TIMEOUT_MS);

pub const LUCKY_BOX_PROMO_REDEEM_PATH: &str = "/v1/lucky-boxes/promocodes/redeem";

const SELECT_IDEM_SQL: &str = "SELECT http_status, body_json
     FROM lucky_box_idempotency
     WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3";
const INSERT_IDEM_SQL: &str = "INSERT INTO lucky_box_idempotency
     (user_id, scope, idempotency_key, http_status, body_json, created_at, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)";
const PG_UNIQUE_VIOLATION: &str = "23505";

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code()
        .map(|c| c.code() == PG_UNIQUE_VIOLATION)
        .unwrap_or(false)
}

/// Node `normalizeLuckyBoxIdempotencyKey` — optional; empty → None.
pub fn normalize_optional_idem_key(raw: Option<&str>) -> Option<String> {
    let Some(s) = raw else {
        return None;
    };
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let key = if t.len() > IDEMPOTENCY_KEY_MAX_LENGTH {
        t[..IDEMPOTENCY_KEY_MAX_LENGTH].to_string()
    } else {
        t.to_string()
    };
    Some(key)
}

fn wheel_to_lucky(e: WheelError) -> LuckyBoxError {
    match e {
        WheelError::Domain {
            status,
            error,
            code,
        } => LuckyBoxError::Domain {
            status,
            error,
            code,
            missing: None,
        },
        WheelError::Transport(err) => LuckyBoxError::Transport(err),
    }
}

fn market_to_lucky(e: MarketError) -> LuckyBoxError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => LuckyBoxError::Domain {
            status,
            error,
            code,
            missing: None,
        },
        MarketError::Transport(err) => LuckyBoxError::Transport(err),
    }
}

#[derive(Debug, Clone)]
pub struct PromoRedeemHttpOutcome {
    pub status: u16,
    pub body: Value,
}

pub async fn promo_redeem(
    pool: &Pool,
    user_id: i64,
    code: &str,
    idempotency_key: Option<&str>,
    server_now_ms: Option<i64>,
) -> Result<PromoRedeemHttpOutcome, LuckyBoxError> {
    if user_id <= 0 {
        return Err(LuckyBoxError::unauthorized(ERR_INVALID_SESSION));
    }
    let Some(normalized) = normalize_promo_code(code) else {
        return Err(LuckyBoxError::bad(ERR_INVALID_CODE));
    };
    let idem = normalize_optional_idem_key(idempotency_key);
    let uid_pg = pg_user_id(user_id).map_err(LuckyBoxError::transport)?;
    let now_ms = server_now_ms
        .filter(|n| *n > 0)
        .unwrap_or_else(current_unix_ms);

    if let Some(ref key) = idem {
        let conn = pool.get().await?;
        let rows = conn
            .query(SELECT_IDEM_SQL, &[&uid_pg, &PROMO_REDEEM_SCOPE, key])
            .await
            .map_err(LuckyBoxError::transport)?;
        if let Some(row) = rows.first() {
            let http_status: i32 = row.get("http_status");
            if http_status >= i32::from(HTTP_OK) && http_status < i32::from(HTTP_BAD_REQUEST) {
                let body_json: String = row.get("body_json");
                let body: Value = serde_json::from_str(&body_json)
                    .unwrap_or_else(|_| serde_json::json!({ "ok": true, "replay": true }));
                return Ok(PromoRedeemHttpOutcome {
                    status: http_status as u16,
                    body,
                });
            }
        }
    }

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(LuckyBoxError::transport)?;
    set_promo_tx_timeouts(&tx).await.map_err(wheel_to_lucky)?;
    assert_active_user(&tx, user_id)
        .await
        .map_err(market_to_lucky)?;

    let outcome =
        match run_promo_code_redeem_in_transaction(&tx, user_id, &normalized, now_ms).await {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(wheel_to_lucky(e));
            }
        };
    let body = outcome.to_lucky_json();

    if let Some(ref key) = idem {
        let body_str = serde_json::to_string(&body).map_err(LuckyBoxError::transport)?;
        let http_ok = i32::from(HTTP_OK);
        match tx
            .execute(
                INSERT_IDEM_SQL,
                &[
                    &uid_pg,
                    &PROMO_REDEEM_SCOPE,
                    key,
                    &http_ok,
                    &body_str,
                    &now_ms,
                ],
            )
            .await
        {
            Ok(_) => {}
            Err(e) if is_unique_violation(&e) => {
                let _ = tx.rollback().await;
                return Err(LuckyBoxError::domain_code(
                    HTTP_CONFLICT,
                    ERR_IDEMPOTENCY_CONFLICT,
                    CODE_IDEMPOTENCY_CONFLICT,
                ));
            }
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(LuckyBoxError::transport(e));
            }
        }
    }

    tx.commit().await.map_err(LuckyBoxError::transport)?;
    Ok(PromoRedeemHttpOutcome {
        status: HTTP_OK,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consts_match_node() {
        assert_eq!(TX_TIMEOUT_MS_LB, 60_000);
        assert_eq!(LOCK_TIMEOUT_MS, 45_000);
        assert_eq!(PROMO_REDEEM_SCOPE, "promo_redeem");
    }

    #[test]
    fn optional_idem() {
        assert!(normalize_optional_idem_key(None).is_none());
        assert!(normalize_optional_idem_key(Some("")).is_none());
        assert_eq!(
            normalize_optional_idem_key(Some("  abc  ")).as_deref(),
            Some("abc")
        );
    }
}
