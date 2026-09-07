//! Live USD price sync — owns the legacy
//! `maybeSyncLiveUsdToMiningCoinsPostgres` (`backend/lib/miningLivePrices.js`,
//! source TS long gone from the repo). Every `MINING_PRICE_DB_SYNC_INTERVAL_MS`
//! (default 10 min) it pulls market prices from CoinGecko `simple/price` for
//! every `is_active = 1` row in `mining_coins` and writes `price_usd` +
//! `usdc_rate` (plus `price_source = 'market'`, `price_updated_at`).
//!
//! Cosmetic only: does not touch yield-per-hash or `mining_yield_history`.
//! Redis lock `genesis:lock:job:price-sync` coordinates replicas. Gate:
//! `MINING_AUTO_SYNC_USD_PRICES=1` (+ `SCHEDULER_ENABLED != 0`).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use deadpool_postgres::Pool;
use serde_json::Value;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, COINGECKO_SIMPLE_URL, REDIS_LOCK_JOB_PRICE_SYNC, REDIS_LOCK_TTL_PRICE_SYNC_SEC,
};
use crate::player_reads::PlayerReadError;
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

/// Worker route for the admin "Atualizar preços" button (on-demand sync).
pub const SYNC_LIVE_PRICES_PATH: &str = "/v1/admin/economy/sync-live-prices";

/// Uppercased symbol → CoinGecko id. 1:1 with legacy `SYMBOL_TO_COINGECKO`.
const SYMBOL_TO_COINGECKO: &[(&str, &str)] = &[
    ("BTC", "bitcoin"),
    ("BNB", "binancecoin"),
    ("ETH", "ethereum"),
    ("DAI", "dai"),
    ("LTC", "litecoin"),
    ("BCH", "bitcoin-cash"),
    ("DOGE", "dogecoin"),
    ("KAS", "kaspa"),
    ("XMR", "monero"),
    ("ZEC", "zcash"),
    ("RVN", "ravencoin"),
    ("ETC", "ethereum-classic"),
    ("XCH", "chia"),
    ("DASH", "dash"),
    ("TON", "the-open-network"),
    ("SOL", "solana"),
    ("XRP", "ripple"),
    ("TRX", "tron"),
    ("ADA", "cardano"),
    ("DOT", "polkadot"),
    ("AVAX", "avalanche-2"),
    ("MATIC", "matic-network"),
    ("POL", "polygon-ecosystem-token"),
    ("LINK", "chainlink"),
    ("ATOM", "cosmos"),
    ("NEAR", "near"),
    ("APT", "aptos"),
    ("SUI", "sui"),
    ("SEI", "sei-network"),
    ("TIA", "celestia"),
    ("INJ", "injective-protocol"),
    ("FIL", "filecoin"),
    ("AR", "arweave"),
    ("HBAR", "hedera-hashgraph"),
    ("VET", "vechain"),
    ("ALGO", "algorand"),
    ("XLM", "stellar"),
    ("EOS", "eos"),
    ("ICP", "internet-computer"),
    ("STX", "blockstack"),
    ("ORDI", "ordinals"),
    ("PEPE", "pepe"),
    ("SHIB", "shiba-inu"),
    ("BONK", "bonk"),
    ("WIF", "dogwifcoin"),
    ("FLOKI", "floki"),
    ("USDT", "tether"),
    ("GHO", "gho"),
    ("WBTC", "wrapped-bitcoin"),
    ("CBBTC", "coinbase-wrapped-btc"),
];

fn gecko_for_symbol(sym: &str) -> Option<&'static str> {
    let up = sym.trim().to_ascii_uppercase();
    SYMBOL_TO_COINGECKO
        .iter()
        .find(|(s, _)| *s == up)
        .map(|(_, g)| *g)
}

/// Legacy `parseEnvJsonMap` — `{ id: "coingecko-id" }`, values trimmed + lowercased.
fn parse_env_ids(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(raw) = raw else { return out };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return out;
    };
    for (k, v) in map {
        if let Some(s) = v.as_str() {
            let s = s.trim().to_ascii_lowercase();
            let k = k.trim().to_string();
            if !s.is_empty() && !k.is_empty() {
                out.insert(k, s);
            }
        }
    }
    out
}

pub async fn run_price_sync_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.price_sync_loop_active() {
        info!(
            event = "price_sync_disabled",
            reason = "SCHEDULER_ENABLED=0 or MINING_AUTO_SYNC_USD_PRICES!=1",
            "live-price sync idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        interval_ms = cfg.price_sync_interval_ms,
        timeout_ms = cfg.job_timeout_price_sync_ms,
        "live-price sync loop starting"
    );

    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(cfg.job_timeout_price_sync_ms.min(15_000)))
        .build()
        .unwrap_or_default();

    run_one_tick(&pool, &locks, &cfg, &http).await;

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.price_sync_interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await;

    loop {
        interval.tick().await;
        run_one_tick(&pool, &locks, &cfg, &http).await;
    }
}

async fn run_one_tick(
    pool: &Pool,
    locks: &RedisLockClient,
    cfg: &WorkerConfig,
    http: &reqwest::Client,
) {
    let handle = match locks
        .try_acquire(REDIS_LOCK_JOB_PRICE_SYNC, REDIS_LOCK_TTL_PRICE_SYNC_SEC)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(event = "price_sync_lock_busy", "price sync lock held elsewhere");
            return;
        }
        Err(e) => {
            warn!(err = %e, "price sync lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match run_price_sync(pool, cfg, http).await {
            Ok(updated) => info!(event = "price_sync", updated, "live prices synced"),
            Err(e) => warn!(err = %e, "price sync tick failed"),
        }
    };
    if tokio::time::timeout(
        Duration::from_millis(cfg.job_timeout_price_sync_ms),
        tick,
    )
    .await
    .is_err()
    {
        warn!(
            timeout_ms = cfg.job_timeout_price_sync_ms,
            "price sync tick timed out"
        );
    }
    owned.release().await;
}

/// On-demand run for the admin "Atualizar preços" button. Ignores the
/// `MINING_AUTO_SYNC_USD_PRICES` gate — an explicit click is intent enough —
/// but still no-ops cleanly when no coin maps to a CoinGecko id.
pub async fn run_price_sync_once(
    pool: &Pool,
    cfg: &WorkerConfig,
) -> Result<Value, PlayerReadError> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    match run_price_sync(pool, cfg, &http).await {
        Ok(updated) => Ok(serde_json::json!({ "ok": true, "updated": updated })),
        Err(e) => Err(PlayerReadError::bad(e)),
    }
}

async fn run_price_sync(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &reqwest::Client,
) -> Result<u64, String> {
    let client = pool.get().await.map_err(|e| format!("pool get: {e}"))?;
    let rows = client
        .query(
            "SELECT id, symbol FROM mining_coins WHERE is_active = 1 ORDER BY id",
            &[],
        )
        .await
        .map_err(|e| format!("select mining_coins: {e}"))?;
    if rows.is_empty() {
        return Ok(0);
    }

    let env_ids = parse_env_ids(cfg.price_sync_coingecko_ids_json.as_deref());

    // mining_coins.id -> coingecko id
    let mut id_to_gecko: HashMap<String, String> = HashMap::new();
    for r in &rows {
        let id: String = r.get::<_, Option<String>>("id").unwrap_or_default();
        let id = id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let gecko = env_ids.get(&id).cloned().or_else(|| {
            let sym: String = r.get::<_, Option<String>>("symbol").unwrap_or_default();
            gecko_for_symbol(&sym).map(str::to_string)
        });
        if let Some(g) = gecko {
            id_to_gecko.insert(id, g);
        }
    }
    if id_to_gecko.is_empty() {
        return Ok(0);
    }

    let unique: Vec<&str> = id_to_gecko
        .values()
        .map(String::as_str)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let url = format!(
        "{COINGECKO_SIMPLE_URL}?ids={}&vs_currencies=usd",
        urlencode(&unique.join(","))
    );

    let resp = http
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("coingecko request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("coingecko HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("coingecko json: {e}"))?;

    let now_ms = crate::player_reads::now_ms();
    let mut updated = 0u64;
    for (id, gecko) in &id_to_gecko {
        let Some(v) = body.get(gecko).and_then(|o| o.get("usd")).and_then(Value::as_f64) else {
            continue;
        };
        if !v.is_finite() || v < 0.0 {
            continue;
        }
        let rounded = (v * 1e8).round() / 1e8;
        let n = client
            .execute(
                "UPDATE mining_coins
                    SET price_usd = $1, usdc_rate = $1,
                        price_source = 'market', price_updated_at = $2
                  WHERE id = $3",
                &[&rounded, &now_ms, id],
            )
            .await
            .map_err(|e| format!("update {id}: {e}"))?;
        updated += n;
    }
    Ok(updated)
}

/// Minimal percent-encoding for the `ids` query value (CoinGecko ids are
/// `[a-z0-9-]`, so only the `,` separator ever needs escaping — but be safe).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_key_is_namespaced() {
        assert_eq!(REDIS_LOCK_JOB_PRICE_SYNC, "genesis:lock:job:price-sync");
    }

    #[test]
    fn symbol_map_matches_legacy_samples() {
        assert_eq!(gecko_for_symbol("btc"), Some("bitcoin"));
        assert_eq!(gecko_for_symbol("POL"), Some("polygon-ecosystem-token"));
        assert_eq!(gecko_for_symbol("SHIB"), Some("shiba-inu"));
        assert_eq!(gecko_for_symbol("NOPE"), None);
    }

    #[test]
    fn env_ids_override_parses_and_lowercases() {
        let m = parse_env_ids(Some(r#"{ "row-1": "Bitcoin", "row-2": " ETH ", "bad": 3 }"#));
        assert_eq!(m.get("row-1").map(String::as_str), Some("bitcoin"));
        assert_eq!(m.get("row-2").map(String::as_str), Some("eth"));
        assert!(!m.contains_key("bad"));
    }

    #[test]
    fn urlencode_escapes_comma() {
        assert_eq!(urlencode("bitcoin,ethereum"), "bitcoin%2Cethereum");
    }
}
