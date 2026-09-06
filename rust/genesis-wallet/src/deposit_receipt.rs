//! Deposit receipt RPC resolve (fetch + ERC-20 Transfer parse).
//!
//! Espelho de `server/modules/wallet/services/deposit-receipt.ts` + `rpc-backoff.ts`.
//! Sem crédito de saldo — só receipt on-chain → parsed transfer.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use genesis_core::time::{MS_PER_MINUTE, MS_PER_SECOND};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::WalletError;

pub const DEPOSIT_RESOLVE_RECEIPT_PATH: &str = "/v1/wallet/deposit/resolve-receipt";

/// Mirror Node `fetchWithTimeout` default (deposit explorer / unified).
const FETCH_TIMEOUT_DEFAULT_MS: u64 = 22 * MS_PER_SECOND;
/// Mirror Node RPC receipt timeout.
const RPC_RECEIPT_TIMEOUT_MS: u64 = 12 * MS_PER_SECOND;
/// Mirror Node `eth_call` decimals timeout.
const DECIMALS_CALL_TIMEOUT_MS: u64 = 15 * MS_PER_SECOND;

/// Mirror Node `markRpcBackoff` floors/ceilings/default.
const BACKOFF_MIN_MS: u64 = 30 * MS_PER_SECOND;
const BACKOFF_MAX_MS: u64 = 60 * MS_PER_MINUTE;
const BACKOFF_RATE_LIMIT_MS: u64 = 20 * MS_PER_MINUTE;
const BACKOFF_HTTP_ERR_MS: u64 = 2 * MS_PER_MINUTE;
const BACKOFF_JSON_ERR_MS: u64 = 5 * MS_PER_MINUTE;
const BACKOFF_RPC_ERR_MS: u64 = MS_PER_MINUTE;
const BACKOFF_NETWORK_ERR_MS: u64 = 90 * MS_PER_SECOND;

/// Tx hash: `0x` + 64 hex.
const TX_HASH_HEX_LEN: usize = 64;
const TX_HASH_TOTAL_LEN: usize = 2 + TX_HASH_HEX_LEN;

/// ERC-20 Transfer(address,address,uint256) topic0.
const ERC20_TRANSFER_TOPIC0: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// Polygon USDC (native + bridged) — mirror Node `POLYGON_USDC_CONTRACTS`.
const POLYGON_USDC_CONTRACTS: &[&str] = &[
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
];

/// Default decimals when `eth_call` fails — mirror Node.
const DEFAULT_DECIMALS_BNB: u32 = 18;
const DEFAULT_DECIMALS_OTHER: u32 = 6;
const DECIMALS_MAX_EXCLUSIVE: u32 = 36;

/// eth_call selector `decimals()`.
const DECIMALS_CALLDATA: &str = "0x313ce567";

const DEFAULT_POLYGON_RPC: &str = "https://polygon-rpc.com";
const DEFAULT_BNB_RPC: &str = "https://bsc-dataseed.binance.org/";
const DEFAULT_BASE_RPC: &str = "https://mainnet.base.org";

const ETHERSCAN_V2_API: &str = "https://api.etherscan.io/v2/api";
const CHAIN_ID_POLYGON: u64 = 137;
const CHAIN_ID_BNB: u64 = 56;
const CHAIN_ID_BASE: u64 = 8453;

const BLOCKSCOUT_POLYGON: &str = "https://polygon.blockscout.com/api/eth-rpc";
const BLOCKSCOUT_BNB: &str = "https://bsc.blockscout.com/api/eth-rpc";
const BLOCKSCOUT_BASE: &str = "https://base.blockscout.com/api/eth-rpc";

const HOST_KEY_MAX_LEN: usize = 80;

static RPC_BACKOFF: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn rpc_backoff_map() -> &'static Mutex<HashMap<String, Instant>> {
    RPC_BACKOFF.get_or_init(|| Mutex::new(HashMap::new()))
}

fn host_key(url: &str) -> String {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let host = host.split('@').next_back().unwrap_or(host);
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    host.chars()
        .take(HOST_KEY_MAX_LEN)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn is_rpc_in_backoff(url: &str) -> bool {
    let key = host_key(url);
    if key.is_empty() {
        return false;
    }
    let map = rpc_backoff_map().lock();
    map.get(&key).is_some_and(|until| *until > Instant::now())
}

fn mark_rpc_backoff(url: &str, ms: u64) {
    let key = host_key(url);
    if key.is_empty() {
        return;
    }
    let wait = ms.clamp(BACKOFF_MIN_MS, BACKOFF_MAX_MS);
    let until = Instant::now() + Duration::from_millis(wait);
    let mut map = rpc_backoff_map().lock();
    let prev = map.get(&key).copied();
    if prev.is_none_or(|p| until > p) {
        map.insert(key, until);
    }
}

fn looks_like_rpc_rate_limit(status: u16, body_text: &str, error_message: Option<&str>) -> bool {
    if status == 429 || status == 402 {
        return true;
    }
    let s = format!("{} {}", body_text, error_message.unwrap_or("")).to_ascii_lowercase();
    s.contains("usage limit")
        || s.contains("rate limit")
        || s.contains("too many requests")
        || s.contains("quota")
        || s.contains("upgrade here")
}

fn filter_fragile_public_rpcs(urls: Vec<String>) -> Vec<String> {
    urls.into_iter()
        .filter(|u| !u.to_ascii_lowercase().contains("1rpc.io"))
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct DepositSettingsPayload {
    #[serde(default)]
    pub web3_deposit_wallet: Option<String>,
    #[serde(default)]
    pub web3_deposit_token_contract: Option<String>,
    #[serde(default)]
    pub web3_deposit_token_contract_bnb: Option<String>,
    #[serde(default)]
    pub web3_deposit_token_contract_base: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDepositTransfer {
    pub network: String,
    pub amount_usdc: f64,
    pub wallet_address: String,
    pub token_contract: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveReceiptOk {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_contract: Option<String>,
}

struct ResolvedNetwork {
    net: String,
    target_wallet: String,
    usdc_contract: String,
    rpc_url: String,
}

fn env_rpc(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn resolve_deposit_network(
    settings: &DepositSettingsPayload,
    network: &str,
) -> Result<ResolvedNetwork, WalletError> {
    let net = network.trim().to_ascii_lowercase();
    let (usdc_contract, rpc_url) = if net == "polygon" {
        (
            settings
                .web3_deposit_token_contract
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase(),
            env_rpc("POLYGON_RPC", DEFAULT_POLYGON_RPC),
        )
    } else if net == "bnb" || net == "bsc" {
        (
            settings
                .web3_deposit_token_contract_bnb
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase(),
            env_rpc("BNB_RPC", DEFAULT_BNB_RPC),
        )
    } else if net == "base" {
        (
            settings
                .web3_deposit_token_contract_base
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase(),
            env_rpc("BASE_RPC", DEFAULT_BASE_RPC),
        )
    } else {
        return Err(WalletError::bad(format!("Rede não suportada: {net}")));
    };
    let target_wallet = settings
        .web3_deposit_wallet
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if target_wallet.is_empty() || usdc_contract.is_empty() {
        return Err(WalletError::internal(format!(
            "Configuração de depósito incompleta no servidor para {net}"
        )));
    }
    let net = if net == "bsc" { "bnb".to_string() } else { net };
    Ok(ResolvedNetwork {
        net,
        target_wallet,
        usdc_contract,
        rpc_url,
    })
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

fn deposit_explorer_chain_id(net: &str) -> Option<u64> {
    match net {
        "polygon" => Some(CHAIN_ID_POLYGON),
        "bnb" | "bsc" => Some(CHAIN_ID_BNB),
        "base" => Some(CHAIN_ID_BASE),
        _ => None,
    }
}

fn deposit_blockscout_eth_rpc_url(net: &str) -> Option<&'static str> {
    match net {
        "polygon" => Some(BLOCKSCOUT_POLYGON),
        "bnb" | "bsc" => Some(BLOCKSCOUT_BNB),
        "base" => Some(BLOCKSCOUT_BASE),
        _ => None,
    }
}

fn parse_proxy_eth_receipt_response(j: &Value) -> Option<Value> {
    let status = j.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let message = j.get("message");
    let mut result = j.get("result").cloned();
    if status == "0" && message.is_some() && result.as_ref().is_none_or(|r| r.is_null()) {
        return None;
    }
    if let Some(Value::String(s)) = result.take() {
        if s.is_empty() || s == "null" {
            return None;
        }
        result = serde_json::from_str(&s).ok();
    }
    let result = result?;
    if result.is_null() {
        return None;
    }
    Some(result)
}

async fn fetch_with_timeout(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    json_body: Option<&Value>,
    timeout_ms: u64,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut built = http
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms));
    if let Some(body) = json_body {
        built = built.header("Content-Type", "application/json").json(body);
    }
    built.send().await
}

async fn fetch_deposit_receipt_rpc(
    http: &reqwest::Client,
    rpc_url: &str,
    tx_hash: &str,
) -> Option<Value> {
    if is_rpc_in_backoff(rpc_url) {
        return None;
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "eth_getTransactionReceipt",
        "params": [tx_hash],
        "id": 1
    });
    match fetch_with_timeout(
        http,
        reqwest::Method::POST,
        rpc_url,
        Some(&body),
        RPC_RECEIPT_TIMEOUT_MS,
    )
    .await
    {
        Ok(rpc_res) => {
            let status = rpc_res.status().as_u16();
            let raw = rpc_res.text().await.unwrap_or_default();
            if looks_like_rpc_rate_limit(status, &raw, None) {
                mark_rpc_backoff(rpc_url, BACKOFF_RATE_LIMIT_MS);
                return None;
            }
            if !(200..300).contains(&status) {
                mark_rpc_backoff(rpc_url, BACKOFF_HTTP_ERR_MS);
                return None;
            }
            let j: Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => {
                    mark_rpc_backoff(rpc_url, BACKOFF_JSON_ERR_MS);
                    return None;
                }
            };
            if let Some(err) = j.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str());
                if looks_like_rpc_rate_limit(status, "", msg) {
                    mark_rpc_backoff(rpc_url, BACKOFF_RATE_LIMIT_MS);
                } else {
                    mark_rpc_backoff(rpc_url, BACKOFF_RPC_ERR_MS);
                }
                return None;
            }
            j.get("result").filter(|r| !r.is_null()).cloned()
        }
        Err(_) => {
            mark_rpc_backoff(rpc_url, BACKOFF_NETWORK_ERR_MS);
            None
        }
    }
}

fn build_deposit_rpc_candidates(net: &str, primary_url: &str) -> Vec<String> {
    let mut list = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |u: &str| {
        let x = u.trim().trim_end_matches('/').to_string();
        if x.is_empty() || !seen.insert(x.clone()) {
            return;
        }
        list.push(x);
    };
    add(primary_url);
    match net {
        "polygon" => {
            add("https://polygon-bor-rpc.publicnode.com");
            add("https://polygon.drpc.org");
            add("https://rpc.ankr.com/polygon");
        }
        "bnb" | "bsc" => {
            add("https://bsc-dataseed1.binance.org");
            add("https://bsc-dataseed2.binance.org");
            add("https://bsc.publicnode.com");
        }
        "base" => {
            add("https://base.publicnode.com");
            add("https://mainnet.base.org");
        }
        _ => {}
    }
    filter_fragile_public_rpcs(list)
        .into_iter()
        .filter(|u| !is_rpc_in_backoff(u))
        .collect()
}

async fn fetch_deposit_receipt_explorer(
    http: &reqwest::Client,
    net: &str,
    tx_hash: &str,
) -> Option<Value> {
    let api_key = std::env::var("ETHERSCAN_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let chain_id = deposit_explorer_chain_id(net)?;
    let url = format!(
        "{ETHERSCAN_V2_API}?chainid={chain_id}&module=proxy&action=eth_getTransactionReceipt&txhash={}&apikey={}",
        urlencoding_encode(tx_hash),
        urlencoding_encode(&api_key)
    );
    let built = fetch_with_timeout(
        http,
        reqwest::Method::GET,
        &url,
        None,
        FETCH_TIMEOUT_DEFAULT_MS,
    );
    let r = built.await.ok()?;
    let j: Value = r.json().await.ok()?;
    parse_proxy_eth_receipt_response(&j)
}

fn urlencoding_encode(s: &str) -> String {
    // Minimal encode for hex / apikey (safe alphabet mostly).
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn fetch_deposit_receipt_unified(
    http: &reqwest::Client,
    net: &str,
    rpc_url: &str,
    tx_hash: &str,
) -> Option<Value> {
    if let Some(bs) = deposit_blockscout_eth_rpc_url(net) {
        if let Some(r) = fetch_deposit_receipt_rpc(http, bs, tx_hash).await {
            return Some(r);
        }
    }
    if let Some(r) = fetch_deposit_receipt_explorer(http, net, tx_hash).await {
        return Some(r);
    }
    for url in build_deposit_rpc_candidates(net, rpc_url) {
        if let Some(r) = fetch_deposit_receipt_rpc(http, &url, tx_hash).await {
            return Some(r);
        }
    }
    None
}

fn topic_addr(t: Option<&str>) -> Option<String> {
    let s = t?.to_ascii_lowercase();
    if !s.starts_with("0x") || s.len() < 42 {
        return None;
    }
    Some(format!("0x{}", &s[s.len() - 40..]))
}

fn receipt_status_ok(result: &Value) -> bool {
    match result.get("status") {
        Some(Value::String(s)) => s == "0x1",
        Some(Value::Number(n)) => n.as_u64() == Some(1),
        _ => false,
    }
}

async fn parse_deposit_transfer_from_receipt(
    http: &reqwest::Client,
    receipt_result: &Value,
    settings: &DepositSettingsPayload,
    network: &str,
) -> Option<ParsedDepositTransfer> {
    let resolved = resolve_deposit_network(settings, network).ok()?;
    if !receipt_status_ok(receipt_result) {
        return None;
    }
    let target_topic2 =
        format!("{:0>64}", resolved.target_wallet.trim_start_matches("0x")).to_ascii_lowercase();
    let mut contract_candidates: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut push_c = |c: &str| {
        let x = c.trim().to_ascii_lowercase();
        if !x.is_empty() && seen.insert(x.clone()) {
            contract_candidates.push(x);
        }
    };
    push_c(&resolved.usdc_contract);
    if resolved.net == "polygon" {
        for c in POLYGON_USDC_CONTRACTS {
            push_c(c);
        }
    }

    let logs = receipt_result
        .get("logs")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    let mut matched_log: Option<Value> = None;
    let mut matched_token_contract = String::new();
    for c in &contract_candidates {
        for l in &logs {
            let addr = l
                .get("address")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let topics = l
                .get("topics")
                .and_then(|t| t.as_array())
                .cloned()
                .unwrap_or_default();
            let topic0 = topics.first().and_then(|t| t.as_str()).unwrap_or("");
            let topic2 = topics.get(2).and_then(|t| t.as_str()).unwrap_or("");
            if addr == *c
                && topic0.eq_ignore_ascii_case(ERC20_TRANSFER_TOPIC0)
                && topic2.to_ascii_lowercase().contains(&target_topic2)
            {
                matched_log = Some(l.clone());
                matched_token_contract = c.clone();
                break;
            }
        }
        if matched_log.is_some() {
            break;
        }
    }
    let matched_log = matched_log?;
    let topics = matched_log
        .get("topics")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let transfer_from = topic_addr(topics.get(1).and_then(|t| t.as_str()))?;

    let mut decimals = if resolved.net == "bnb" {
        DEFAULT_DECIMALS_BNB
    } else {
        DEFAULT_DECIMALS_OTHER
    };
    let dec_body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [{ "to": matched_token_contract, "data": DECIMALS_CALLDATA }, "latest"],
        "id": 2
    });
    if let Ok(dec_res) = fetch_with_timeout(
        http,
        reqwest::Method::POST,
        &resolved.rpc_url,
        Some(&dec_body),
        DECIMALS_CALL_TIMEOUT_MS,
    )
    .await
    {
        if let Ok(dec_data) = dec_res.json::<Value>().await {
            if let Some(hex) = dec_data.get("result").and_then(|r| r.as_str()) {
                if hex != "0x" {
                    if let Ok(parsed_dec) = u32::from_str_radix(hex.trim_start_matches("0x"), 16) {
                        if parsed_dec > 0 && parsed_dec < DECIMALS_MAX_EXCLUSIVE {
                            decimals = parsed_dec;
                        }
                    }
                }
            }
        }
    }

    let data = matched_log
        .get("data")
        .and_then(|d| d.as_str())
        .unwrap_or("0x0");
    let amount_raw = u128::from_str_radix(data.trim_start_matches("0x"), 16).ok()?;
    let divisor = 10f64.powi(decimals as i32);
    let amount_usdc = (amount_raw as f64) / divisor;
    if !amount_usdc.is_finite() || amount_usdc <= 0.0 {
        return None;
    }

    Some(ParsedDepositTransfer {
        network: resolved.net,
        amount_usdc,
        wallet_address: transfer_from,
        token_contract: matched_token_contract,
    })
}

/// Fetch receipt + parse Transfer. `pending` when receipt missing.
pub async fn run_resolve_deposit_receipt(
    http: &reqwest::Client,
    tx_hash: &str,
    network: &str,
    settings: &DepositSettingsPayload,
) -> Result<ResolveReceiptOk, WalletError> {
    let tx_norm = normalize_tx_hash(tx_hash)?;
    let resolved = resolve_deposit_network(settings, network)?;
    let receipt =
        fetch_deposit_receipt_unified(http, &resolved.net, &resolved.rpc_url, &tx_norm).await;
    let Some(receipt_result) = receipt else {
        return Ok(ResolveReceiptOk {
            ok: true,
            pending: Some(true),
            network: None,
            amount_usdc: None,
            wallet_address: None,
            token_contract: None,
        });
    };
    match parse_deposit_transfer_from_receipt(http, &receipt_result, settings, &resolved.net).await
    {
        Some(parsed) => Ok(ResolveReceiptOk {
            ok: true,
            pending: Some(false),
            network: Some(parsed.network),
            amount_usdc: Some(parsed.amount_usdc),
            wallet_address: Some(parsed.wallet_address),
            token_contract: Some(parsed.token_contract),
        }),
        None => Err(WalletError::bad(format!(
            "Transação inválida: contrato, destino ou rede incorretos ({})",
            resolved.net
        ))),
    }
}
