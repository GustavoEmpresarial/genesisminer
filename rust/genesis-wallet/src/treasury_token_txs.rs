//! Admin proxy for the treasury USDC `tokentx` feed on Polygon —
//! `GET /api/admin/etherscan/treasury-token-txs`.
//!
//! Ports `server/modules/admin/etherscan/services/treasury-token-txs.ts`.
//! Uses the same `ETHERSCAN_API_KEY` env the deposit-receipt verifier already
//! reads. The key is redacted out of the response and never logged.

use std::time::Duration;

use deadpool_postgres::{GenericClient, Pool};
use serde_json::Value;

use crate::errors::WalletError;

pub const TREASURY_TOKEN_TXS_PATH: &str = "/v1/wallet/admin/treasury-token-txs";

const HTTP_SERVICE_UNAVAILABLE: u16 = 503;
const HTTP_BAD_GATEWAY: u16 = 502;
const FETCH_TIMEOUT_MS: u64 = 20_000;
const PAGE_MAX: i64 = 100;
const OFFSET_MAX: i64 = 1000;
const PAGE_DEFAULT: i64 = 1;
const OFFSET_DEFAULT: i64 = 20;
const CHAIN_ID: i64 = 137;
const USDC_POLYGON: &str = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const FALLBACK_TREASURY: &str = "0x3d9bda32f0cba0e84c332fd0151d434a4840f38a";
const LEGACY_TREASURY: &str = "0x2c386bf962339b497d5ec6a0edb255d30004f3b6";
const LEGACY_LAUNCH_TREASURY: &str = "0x33d2406707e5e4b314d15784e73bb08f0c46db42";
const ETHERSCAN_V2: &str = "https://api.etherscan.io/v2/api";
const WEB3_DEPOSIT_WALLET_KEY: &str = "web3_deposit_wallet";

#[derive(Debug, Default)]
pub struct TreasuryTokenTxsQuery {
    pub page: Option<String>,
    pub offset: Option<String>,
    pub address: Option<String>,
}

fn clamp_i64(raw: Option<&str>, default: i64, max: i64) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
        .clamp(1, max)
}

fn is_addr(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `web3_deposit_wallet` (lower-cased, validated) or `""`.
async fn load_configured_treasury<C: GenericClient>(client: &C) -> String {
    let row = client
        .query_opt(
            "SELECT value FROM settings WHERE key = $1",
            &[&WEB3_DEPOSIT_WALLET_KEY],
        )
        .await
        .ok()
        .flatten();
    let raw: String = row
        .and_then(|r| r.try_get::<_, Option<String>>("value").ok().flatten())
        .unwrap_or_default();
    let t = raw.trim().to_ascii_lowercase();
    if is_addr(&t) {
        t
    } else {
        String::new()
    }
}

pub(crate) fn resolve_treasury_address(requested: Option<&str>, configured: &str) -> String {
    let primary = if configured.is_empty() {
        FALLBACK_TREASURY.to_string()
    } else {
        configured.to_string()
    };
    let req = requested.unwrap_or("").trim().to_ascii_lowercase();
    if is_addr(&req)
        && (req == LEGACY_TREASURY || req == LEGACY_LAUNCH_TREASURY || req == primary)
    {
        return req;
    }
    primary
}

fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn build_tokentx_url(api_key: &str, treasury: &str, page: i64, offset: i64) -> String {
    format!(
        "{ETHERSCAN_V2}?chainid={CHAIN_ID}&module=account&action=tokentx\
         &contractaddress={USDC_POLYGON}&address={treasury}&page={page}&offset={offset}\
         &startblock=0&endblock=99999999&sort=desc&apikey={}",
        pct_encode(api_key)
    )
}

/// Recursively replace the api key (and any `apikey=…` querystring) with
/// `[redacted]` in every string of the Etherscan response.
pub(crate) fn sanitize_json(data: Value, secret: &str) -> Value {
    match data {
        Value::String(s) => Value::String(redact(&s, secret)),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| sanitize_json(x, secret)).collect()),
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| (k, sanitize_json(v, secret)))
                .collect(),
        ),
        other => other,
    }
}

fn redact(text: &str, secret: &str) -> String {
    let base = if !secret.is_empty() {
        text.replace(secret, "[redacted]")
    } else {
        text.to_string()
    };
    // Replace every `apikey=<value>` with `apikey=[redacted]` in one left-to-right
    // pass (no re-scan of the inserted marker → no loop).
    let lower = base.to_ascii_lowercase();
    let mut out = String::with_capacity(base.len());
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("apikey=") {
        let kw_start = cursor + rel;
        let val_start = kw_start + "apikey=".len();
        let val_end = base[val_start..]
            .find(|c: char| c == '&' || c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
            .map(|o| val_start + o)
            .unwrap_or(base.len());
        out.push_str(&base[cursor..val_start]);
        out.push_str("[redacted]");
        cursor = val_end;
    }
    out.push_str(&base[cursor..]);
    out
}

pub async fn run_treasury_token_txs(
    pool: &Pool,
    http: &reqwest::Client,
    q: &TreasuryTokenTxsQuery,
) -> Result<Value, WalletError> {
    let client = pool.get().await.map_err(WalletError::transport)?;
    let api_key = std::env::var("ETHERSCAN_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            WalletError::domain(
                HTTP_SERVICE_UNAVAILABLE,
                "ETHERSCAN_API_KEY não configurada no servidor.",
            )
        })?;

    let page = clamp_i64(q.page.as_deref(), PAGE_DEFAULT, PAGE_MAX);
    let offset = clamp_i64(q.offset.as_deref(), OFFSET_DEFAULT, OFFSET_MAX);
    let configured = load_configured_treasury(&client).await;
    let treasury = resolve_treasury_address(q.address.as_deref(), &configured);
    let url = build_tokentx_url(&api_key, &treasury, page, offset);

    let resp = http
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(err = %e.without_url(), "etherscan proxy");
            WalletError::domain(HTTP_BAD_GATEWAY, "Falha ao contactar Etherscan.")
        })?;
    let data: Value = resp.json().await.map_err(|e| {
        tracing::warn!(err = %e.without_url(), "etherscan proxy json");
        WalletError::domain(HTTP_BAD_GATEWAY, "Falha ao contactar Etherscan.")
    })?;

    Ok(sanitize_json(data, &api_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamps() {
        assert_eq!(clamp_i64(None, 1, 100), 1);
        assert_eq!(clamp_i64(Some("0"), 1, 100), 1);
        assert_eq!(clamp_i64(Some("9999"), 1, 100), 100);
        assert_eq!(clamp_i64(Some("7"), 20, 1000), 7);
        assert_eq!(clamp_i64(Some("x"), 20, 1000), 20);
    }

    #[test]
    fn address_allowlist() {
        // unknown -> primary (fallback when unconfigured)
        assert_eq!(resolve_treasury_address(Some("0xdead"), ""), FALLBACK_TREASURY);
        // legacy allowed
        assert_eq!(
            resolve_treasury_address(Some(&LEGACY_TREASURY.to_uppercase()), ""),
            LEGACY_TREASURY
        );
        // configured primary allowed
        let cfg = "0x1111111111111111111111111111111111111111";
        assert_eq!(resolve_treasury_address(Some(cfg), cfg), cfg);
        // arbitrary other -> primary
        assert_eq!(
            resolve_treasury_address(Some("0x2222222222222222222222222222222222222222"), cfg),
            cfg
        );
    }

    #[test]
    fn key_is_redacted() {
        let v = json!({ "result": [{ "u": "see https://x/api?apikey=SECRET123&z=1" }], "k": "SECRET123" });
        let out = sanitize_json(v, "SECRET123");
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("SECRET123"), "{s}");
        assert!(s.contains("apikey=[redacted]"), "{s}");
    }
}
