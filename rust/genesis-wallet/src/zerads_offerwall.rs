//! ZERads token / stats / callback gates — Node `offerwall` token + controller.
//!
//! Credit stays in `zerads_credit.rs`. Env names copy Node (`ZERADS_*` only).

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::current_unix_ms;
use crate::errors::{WalletError, HTTP_BAD_REQUEST, HTTP_FORBIDDEN};
use crate::pg_types::pg_user_id;
use crate::util::assert_active_user;
use crate::zerads_credit::run_zerads_credit;

/// Node `TOKEN_BYTES`.
const TOKEN_BYTES: usize = 32;
/// Node `RECENT_ENTRIES_LIMIT`.
const RECENT_ENTRIES_LIMIT: i64 = 30;
/// Node `DEFAULT_MAX_AMOUNT_ZER`.
const DEFAULT_MAX_AMOUNT_ZER: f64 = 1000.0;
/// Node `RAW_USER_MAX`.
const RAW_USER_MAX: usize = 120;
/// Node `ERROR_MESSAGE_LOG_MAX_LENGTH`.
const ERROR_MESSAGE_LOG_MAX_LENGTH: usize = 400;
/// Node `DEFAULT_ZERADS_REF_ID`.
const DEFAULT_ZERADS_REF_ID: &str = "11294";
/// Node `BLOCKED_FLAG`.
const BLOCKED_FLAG: i32 = 1;
/// Node `TOKEN_REGEX` `{32,64}`.
const TOKEN_HEX_MIN: usize = 32;
const TOKEN_HEX_MAX: usize = 64;
/// Node `HTTP_OK`.
const HTTP_OK: u16 = 200;
const IPV6_MAPPED_PREFIX: &str = "::ffff:";

const _: () = assert!(TOKEN_BYTES == 32);
const _: () = assert!(RECENT_ENTRIES_LIMIT == 30);
const _: () = assert!(DEFAULT_MAX_AMOUNT_ZER as i64 == 1000);
const _: () = assert!(RAW_USER_MAX == 120);
const _: () = assert!(ERROR_MESSAGE_LOG_MAX_LENGTH == 400);

pub const ZERADS_TOKEN_PATH: &str = "/v1/wallet/offerwall/token";
pub const ZERADS_STATS_PATH: &str = "/v1/wallet/offerwall/stats";
pub const ZERADS_CALLBACK_PATH: &str = "/v1/wallet/offerwall/callback";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZeradsUserRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZeradsCallbackRequest {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub clicks: Option<String>,
    #[serde(default)]
    pub pwd: Option<String>,
    #[serde(default)]
    pub cf_ip: Option<String>,
    #[serde(default)]
    pub req_ip: Option<String>,
    pub server_now_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ZeradsHttp {
    pub status: u16,
    pub body: Value,
}

fn created_at_i64(row: &tokio_postgres::Row) -> i64 {
    row.try_get::<_, i64>("created_at")
        .or_else(|_| {
            row.try_get::<_, Option<i64>>("created_at")
                .map(|v| v.unwrap_or(0))
        })
        .unwrap_or(0)
}

fn timing_safe_string_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in ab.iter().zip(bb.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

fn normalize_client_ip(raw: Option<&str>) -> Option<String> {
    let mut s = raw.unwrap_or("").trim();
    if s.is_empty() {
        return None;
    }
    if let Some((first, _)) = s.split_once(',') {
        s = first.trim();
    }
    let n = s.strip_prefix(IPV6_MAPPED_PREFIX).unwrap_or(s);
    if n.is_empty() {
        None
    } else {
        Some(n.to_string())
    }
}

fn read_env_float(key: &str, fallback: f64) -> f64 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<f64>() {
            Ok(v) if v.is_finite() && v > 0.0 => v,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

fn read_zerads_max_amount_zer() -> f64 {
    read_env_float("ZERADS_MAX_AMOUNT_ZER", DEFAULT_MAX_AMOUNT_ZER)
}

fn is_zerads_empty_ip_whitelist_allowed() -> bool {
    std::env::var("ZERADS_ALLOW_EMPTY_IP_WHITELIST")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

fn read_zerads_allowed_ips() -> std::collections::HashSet<String> {
    let raw = std::env::var("ZERADS_ALLOWED_IPS").unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return std::collections::HashSet::new();
    }
    trimmed
        .split(',')
        .filter_map(|s| normalize_client_ip(Some(s)))
        .collect()
}

fn require_cf_header() -> bool {
    std::env::var("ZERADS_REQUIRE_CF")
        .map(|v| v.trim() != "0")
        .unwrap_or(true)
}

fn token_regex_ok(raw: &str) -> bool {
    let n = raw.len();
    if n < TOKEN_HEX_MIN || n > TOKEN_HEX_MAX {
        return false;
    }
    raw.bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_token_hex() -> String {
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let mut bytes = [0u8; TOKEN_BYTES];
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..].copy_from_slice(b.as_bytes());
    hex::encode(bytes)
}

fn ptc_url(token: &str) -> String {
    let ref_id = std::env::var("ZERADS_REF_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ZERADS_REF_ID.to_string());
    format!(
        "https://zerads.com/ptc.php?ref={}&user={}",
        urlencoding_encode(&ref_id),
        urlencoding_encode(token)
    )
}

/// Node `encodeURIComponent` for the known-safe ref/token charset (alnum + hex).
fn urlencoding_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

async fn insert_callback_log(
    pool: &Pool,
    user_id: Option<i32>,
    raw_user: Option<&str>,
    amount_zer: Option<f64>,
    clicks: Option<i32>,
    cf_ip: Option<&str>,
    req_ip: Option<&str>,
    status: &str,
    message: Option<&str>,
) {
    let now = current_unix_ms();
    let msg = message.map(|m| {
        let t: String = m.chars().take(ERROR_MESSAGE_LOG_MAX_LENGTH).collect();
        t
    });
    if let Ok(conn) = pool.get().await {
        let _ = conn
            .execute(
                "INSERT INTO zerads_callback_log (
                    user_id, raw_user, amount_zer, clicks, cf_ip, req_ip, status, message, created_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                &[
                    &user_id,
                    &raw_user,
                    &amount_zer,
                    &clicks,
                    &cf_ip,
                    &req_ip,
                    &status,
                    &msg,
                    &now,
                ],
            )
            .await;
    }
}

fn forbidden() -> ZeradsHttp {
    ZeradsHttp {
        status: HTTP_FORBIDDEN,
        body: json!({ "ok": false, "error": "forbidden" }),
    }
}

pub async fn run_zerads_token(pool: &Pool, user_id: i64) -> Result<Value, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::unauthorized("unauthenticated"));
    }
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let conn = pool.get().await.map_err(WalletError::transport)?;
    assert_active_user(&conn, user_id).await?;
    if let Some(row) = conn
        .query_opt(
            "SELECT token FROM zerads_user_tokens WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?
    {
        let token: String = row.get("token");
        return Ok(json!({ "token": token, "ptc_url": ptc_url(&token) }));
    }
    let token = random_token_hex();
    let now = current_unix_ms();
    match conn
        .execute(
            "INSERT INTO zerads_user_tokens (user_id, token, created_at) VALUES ($1, $2, $3)",
            &[&uid, &token, &now],
        )
        .await
    {
        Ok(_) => Ok(json!({ "token": token, "ptc_url": ptc_url(&token) })),
        Err(e) => {
            if e.code().map(|c| c.code()) == Some("23505") {
                let row = conn
                    .query_opt(
                        "SELECT token FROM zerads_user_tokens WHERE user_id = $1",
                        &[&uid],
                    )
                    .await
                    .map_err(WalletError::transport)?;
                if let Some(r) = row {
                    let existing: String = r.get("token");
                    return Ok(json!({ "token": existing, "ptc_url": ptc_url(&existing) }));
                }
            }
            Err(WalletError::transport(anyhow::anyhow!(
                "Falha a gerar token ZERads."
            )))
        }
    }
}

pub async fn run_zerads_stats(pool: &Pool, user_id: i64) -> Result<Value, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::unauthorized("unauthenticated"));
    }
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let conn = pool.get().await.map_err(WalletError::transport)?;
    assert_active_user(&conn, user_id).await?;
    let agg = conn
        .query_one(
            "SELECT
                COUNT(*)::bigint AS callbacks,
                COALESCE(SUM(amount_zer), 0)::float8 AS amount_zer,
                COALESCE(SUM(user_amount_usdc), 0)::float8 AS user_amount_usdc,
                COALESCE(SUM(platform_amount_usdc), 0)::float8 AS platform_amount_usdc,
                COALESCE(SUM(clicks), 0)::bigint AS clicks
             FROM zerads_earnings_ledger
             WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(WalletError::transport)?;
    let recent = conn
        .query(
            "SELECT amount_zer::float8 AS amount_zer,
                    user_amount_usdc::float8 AS user_amount_usdc,
                    clicks,
                    zer_to_usdc_rate::float8 AS zer_to_usdc_rate,
                    created_at
             FROM zerads_earnings_ledger
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2",
            &[&uid, &RECENT_ENTRIES_LIMIT],
        )
        .await
        .map_err(WalletError::transport)?;
    let recent_json: Vec<Value> = recent
        .iter()
        .map(|r| {
            json!({
                "amount_zer": r.get::<_, f64>("amount_zer"),
                "user_amount_usdc": r.get::<_, f64>("user_amount_usdc"),
                "clicks": r.get::<_, i32>("clicks"),
                "zer_to_usdc_rate": r.get::<_, f64>("zer_to_usdc_rate"),
                "created_at": created_at_i64(r)
            })
        })
        .collect();
    Ok(json!({
        "totals": {
            "callbacks": agg.get::<_, i64>("callbacks"),
            "amount_zer": agg.get::<_, f64>("amount_zer"),
            "user_amount_usdc": agg.get::<_, f64>("user_amount_usdc"),
            "platform_amount_usdc": agg.get::<_, f64>("platform_amount_usdc"),
            "clicks": agg.get::<_, i64>("clicks")
        },
        "recent": recent_json
    }))
}

pub async fn run_zerads_callback(pool: &Pool, req: ZeradsCallbackRequest) -> ZeradsHttp {
    let cf_ip = normalize_client_ip(req.cf_ip.as_deref());
    let req_ip = normalize_client_ip(req.req_ip.as_deref());
    let raw_user = req
        .user
        .as_deref()
        .map(|s| s.chars().take(RAW_USER_MAX).collect::<String>());
    let raw_amount = req.amount.as_deref().unwrap_or("");
    let raw_clicks = req.clicks.as_deref().unwrap_or("");
    let raw_pwd = req.pwd.as_deref().unwrap_or("");
    let amount_zer = raw_amount.parse::<f64>().ok();
    let clicks = raw_clicks.parse::<i32>().ok();

    let expected = std::env::var("ZERADS_CALLBACK_PASSWORD").unwrap_or_default();
    if expected.is_empty() || !timing_safe_string_eq(raw_pwd, &expected) {
        insert_callback_log(
            pool,
            None,
            raw_user.as_deref(),
            amount_zer.filter(|n| n.is_finite()),
            clicks.filter(|n| *n >= 0),
            cf_ip.as_deref(),
            req_ip.as_deref(),
            "bad_pwd",
            None,
        )
        .await;
        return forbidden();
    }

    let allowed = read_zerads_allowed_ips();
    if allowed.is_empty() {
        if !is_zerads_empty_ip_whitelist_allowed() {
            insert_callback_log(
                pool,
                None,
                raw_user.as_deref(),
                amount_zer.filter(|n| n.is_finite()),
                clicks.filter(|n| *n >= 0),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "bad_ip",
                Some("ZERADS_ALLOWED_IPS empty (fail-closed)"),
            )
            .await;
            return forbidden();
        }
    } else {
        let candidates = [cf_ip.as_deref(), req_ip.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let matched = candidates.iter().any(|ip| allowed.contains(*ip));
        let cf_missing = require_cf_header() && cf_ip.is_none();
        if !matched || cf_missing {
            insert_callback_log(
                pool,
                None,
                raw_user.as_deref(),
                amount_zer.filter(|n| n.is_finite()),
                clicks.filter(|n| *n >= 0),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "bad_ip",
                Some(if cf_missing {
                    "cf-connecting-ip missing"
                } else {
                    "ip not in whitelist"
                }),
            )
            .await;
            return forbidden();
        }
    }

    let Some(raw_user) = raw_user.filter(|s| token_regex_ok(s)) else {
        insert_callback_log(
            pool,
            None,
            req.user
                .as_deref()
                .map(|s| {
                    let t: String = s.chars().take(RAW_USER_MAX).collect();
                    t
                })
                .as_deref(),
            amount_zer.filter(|n| n.is_finite()),
            clicks.filter(|n| *n >= 0),
            cf_ip.as_deref(),
            req_ip.as_deref(),
            "bad_payload",
            Some("invalid token format"),
        )
        .await;
        return ZeradsHttp {
            status: HTTP_BAD_REQUEST,
            body: json!({ "ok": false, "error": "bad_user" }),
        };
    };

    let Some(amount) = amount_zer.filter(|n| n.is_finite() && *n >= 0.0) else {
        insert_callback_log(
            pool,
            None,
            Some(&raw_user),
            None,
            clicks.filter(|n| *n >= 0),
            cf_ip.as_deref(),
            req_ip.as_deref(),
            "bad_payload",
            Some("invalid amount"),
        )
        .await;
        return ZeradsHttp {
            status: HTTP_BAD_REQUEST,
            body: json!({ "ok": false, "error": "bad_amount" }),
        };
    };
    let max_amount = read_zerads_max_amount_zer();
    if amount > max_amount {
        insert_callback_log(
            pool,
            None,
            Some(&raw_user),
            Some(amount),
            clicks.filter(|n| *n >= 0),
            cf_ip.as_deref(),
            req_ip.as_deref(),
            "bad_payload",
            Some(&format!("amount exceeds max ({max_amount})")),
        )
        .await;
        return ZeradsHttp {
            status: HTTP_BAD_REQUEST,
            body: json!({ "ok": false, "error": "bad_amount" }),
        };
    }
    let safe_clicks = clicks.filter(|n| *n >= 0).unwrap_or(0);

    let conn = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            return ZeradsHttp {
                status: crate::errors::HTTP_INTERNAL,
                body: json!({ "ok": false, "error": e.to_string() }),
            };
        }
    };
    let token_row = match conn
        .query_opt(
            "SELECT user_id FROM zerads_user_tokens WHERE token = $1",
            &[&raw_user],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return ZeradsHttp {
                status: crate::errors::HTTP_INTERNAL,
                body: json!({ "ok": false, "error": e.to_string() }),
            };
        }
    };
    let Some(token_row) = token_row else {
        drop(conn);
        insert_callback_log(
            pool,
            None,
            Some(&raw_user),
            Some(amount),
            Some(safe_clicks),
            cf_ip.as_deref(),
            req_ip.as_deref(),
            "unknown_user",
            None,
        )
        .await;
        return ZeradsHttp {
            status: HTTP_OK,
            body: json!({ "ok": false, "error": "unknown_user" }),
        };
    };
    let user_id: i32 = token_row.get("user_id");
    let user_row = match conn
        .query_opt("SELECT is_blocked FROM users WHERE id = $1", &[&user_id])
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return ZeradsHttp {
                status: crate::errors::HTTP_INTERNAL,
                body: json!({ "ok": false, "error": e.to_string() }),
            };
        }
    };
    drop(conn);
    match user_row {
        None => {
            insert_callback_log(
                pool,
                Some(user_id),
                Some(&raw_user),
                Some(amount),
                Some(safe_clicks),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "unknown_user",
                None,
            )
            .await;
            return ZeradsHttp {
                status: HTTP_OK,
                body: json!({ "ok": false, "error": "unknown_user" }),
            };
        }
        Some(r) => {
            let blocked: Option<i32> = r.get("is_blocked");
            if blocked.unwrap_or(0) == BLOCKED_FLAG {
                insert_callback_log(
                    pool,
                    Some(user_id),
                    Some(&raw_user),
                    Some(amount),
                    Some(safe_clicks),
                    cf_ip.as_deref(),
                    req_ip.as_deref(),
                    "blocked",
                    None,
                )
                .await;
                return ZeradsHttp {
                    status: HTTP_OK,
                    body: json!({ "ok": false, "error": "blocked" }),
                };
            }
        }
    }

    match run_zerads_credit(
        pool,
        i64::from(user_id),
        amount,
        safe_clicks,
        req.server_now_ms,
    )
    .await
    {
        Ok(out) if out.duplicate => {
            insert_callback_log(
                pool,
                Some(user_id),
                Some(&raw_user),
                Some(amount),
                Some(safe_clicks),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "dup",
                Some(&out.idempotency_key),
            )
            .await;
            ZeradsHttp {
                status: HTTP_OK,
                body: json!({ "ok": true, "dup": true }),
            }
        }
        Ok(out) => {
            insert_callback_log(
                pool,
                Some(user_id),
                Some(&raw_user),
                Some(amount),
                Some(safe_clicks),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "ok",
                None,
            )
            .await;
            ZeradsHttp {
                status: HTTP_OK,
                body: json!({
                    "ok": true,
                    "credited_usdc": out.user_usdc,
                    "clicks": safe_clicks
                }),
            }
        }
        Err(e) => {
            let msg = match &e {
                WalletError::Domain { error, .. } => error.clone(),
                WalletError::Transport(err) => err.to_string(),
            };
            insert_callback_log(
                pool,
                Some(user_id),
                Some(&raw_user),
                Some(amount),
                Some(safe_clicks),
                cf_ip.as_deref(),
                req_ip.as_deref(),
                "error",
                Some(&msg),
            )
            .await;
            ZeradsHttp {
                status: crate::errors::HTTP_INTERNAL,
                body: json!({ "ok": false, "error": "Internal ZERads error." }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_regex_and_defaults() {
        assert!(token_regex_ok(&"ab".repeat(16)));
        assert!(token_regex_ok(&"AB".repeat(16)));
        assert!(!token_regex_ok("short"));
        assert!(!token_regex_ok("zzzz"));
        assert_eq!(DEFAULT_ZERADS_REF_ID, "11294");
        assert_eq!(ZERADS_TOKEN_PATH, "/v1/wallet/offerwall/token");
        assert_eq!(ZERADS_STATS_PATH, "/v1/wallet/offerwall/stats");
        assert_eq!(ZERADS_CALLBACK_PATH, "/v1/wallet/offerwall/callback");
    }

    #[test]
    fn timing_safe_and_ip() {
        assert!(timing_safe_string_eq("abc", "abc"));
        assert!(!timing_safe_string_eq("abc", "abd"));
        assert!(!timing_safe_string_eq("abc", "ab"));
        assert_eq!(
            normalize_client_ip(Some("::ffff:1.2.3.4, 9.9.9.9")).as_deref(),
            Some("1.2.3.4")
        );
        assert_eq!(urlencoding_encode("11294"), "11294");
        assert_eq!(urlencoding_encode("a b"), "a%20b");
    }

    #[test]
    fn random_token_is_64_hex() {
        let t = random_token_hex();
        assert_eq!(t.len(), TOKEN_BYTES * 2);
        assert!(token_regex_ok(&t));
    }
}
