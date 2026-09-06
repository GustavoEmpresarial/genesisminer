//! HTTP clients → genesis-auth + mining-worker (fail-closed).

use serde_json::Value;

use crate::config::{
    ApiConfig, MINING_WORKER_AUTH_HEADER, MINING_WORKER_PROGRESS_TIMEOUT_MS, READINESS_DEFAULT_MS,
};

const AUTH_WORKER_UNSET: &str = "GENESIS_AUTH_URL unset";
const MINING_WORKER_UNSET: &str = "GENESIS_MINING_WORKER_URL unset";
const HARDWARE_WORKER_UNSET: &str = "GENESIS_HARDWARE_URL unset";
const WALLET_WORKER_UNSET: &str = "GENESIS_WALLET_URL unset";

#[derive(Debug, Clone)]
pub struct WorkerJson {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug)]
pub enum WorkerCallError {
    Unset(&'static str),
    Transport(String),
    NonJson(u16),
}

impl WorkerCallError {
    pub fn is_unset(&self) -> bool {
        matches!(self, Self::Unset(_))
    }

    pub fn message(&self) -> String {
        match self {
            Self::Unset(m) => (*m).to_string(),
            Self::Transport(m) => m.clone(),
            Self::NonJson(status) => format!("worker non-JSON ({status})"),
        }
    }
}

pub async fn post_auth(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path: &str,
    body: &Value,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .auth_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(AUTH_WORKER_UNSET))?;
    post_worker(
        http,
        base,
        path,
        body,
        cfg.mining_worker_auth_token.as_deref(),
    )
    .await
}

pub async fn post_mining(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path: &str,
    body: &Value,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .mining_worker_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(MINING_WORKER_UNSET))?;
    post_worker(
        http,
        base,
        path,
        body,
        cfg.mining_worker_auth_token.as_deref(),
    )
    .await
}

pub async fn post_hardware(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path: &str,
    body: &Value,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .hardware_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(HARDWARE_WORKER_UNSET))?;
    post_worker(
        http,
        base,
        path,
        body,
        cfg.mining_worker_auth_token.as_deref(),
    )
    .await
}

pub async fn post_wallet(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path: &str,
    body: &Value,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .wallet_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(WALLET_WORKER_UNSET))?;
    post_worker(
        http,
        base,
        path,
        body,
        cfg.mining_worker_auth_token.as_deref(),
    )
    .await
}

pub async fn get_mining(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path_and_query: &str,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .mining_worker_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(MINING_WORKER_UNSET))?;
    get_worker(
        http,
        base,
        path_and_query,
        cfg.mining_worker_auth_token.as_deref(),
    )
    .await
}

pub async fn post_mining_multipart(
    cfg: &ApiConfig,
    http: &reqwest::Client,
    path: &str,
    form: reqwest::multipart::Form,
    timeout_ms: u64,
) -> Result<WorkerJson, WorkerCallError> {
    let base = cfg
        .mining_worker_url
        .as_deref()
        .ok_or(WorkerCallError::Unset(MINING_WORKER_UNSET))?;
    post_worker_multipart(
        http,
        base,
        path,
        form,
        cfg.mining_worker_auth_token.as_deref(),
        timeout_ms,
    )
    .await
}

async fn post_worker_multipart(
    http: &reqwest::Client,
    base: &str,
    path: &str,
    form: reqwest::multipart::Form,
    token: Option<&str>,
    timeout_ms: u64,
) -> Result<WorkerJson, WorkerCallError> {
    let url = format!("{base}{path}");
    let mut req = http
        .post(&url)
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .header("accept", "application/json")
        .multipart(form);
    if let Some(t) = token {
        req = req.header(MINING_WORKER_AUTH_HEADER, t);
    }
    let res = req
        .send()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    if text.is_empty() {
        return Ok(WorkerJson {
            status,
            body: Value::Object(serde_json::Map::new()),
        });
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|_| WorkerCallError::NonJson(status))?;
    Ok(WorkerJson {
        status,
        body: parsed,
    })
}

async fn post_worker(
    http: &reqwest::Client,
    base: &str,
    path: &str,
    body: &Value,
    token: Option<&str>,
) -> Result<WorkerJson, WorkerCallError> {
    let url = format!("{base}{path}");
    let mut req = http
        .post(&url)
        .timeout(std::time::Duration::from_millis(
            MINING_WORKER_PROGRESS_TIMEOUT_MS,
        ))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(body);
    if let Some(t) = token {
        req = req.header(MINING_WORKER_AUTH_HEADER, t);
    }
    let res = req
        .send()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    if text.is_empty() {
        return Ok(WorkerJson {
            status,
            body: Value::Object(serde_json::Map::new()),
        });
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|_| WorkerCallError::NonJson(status))?;
    Ok(WorkerJson {
        status,
        body: parsed,
    })
}

async fn get_worker(
    http: &reqwest::Client,
    base: &str,
    path_and_query: &str,
    token: Option<&str>,
) -> Result<WorkerJson, WorkerCallError> {
    let url = format!("{base}{path_and_query}");
    let mut req = http
        .get(&url)
        .timeout(std::time::Duration::from_millis(
            MINING_WORKER_PROGRESS_TIMEOUT_MS,
        ))
        .header("accept", "application/json");
    if let Some(t) = token {
        req = req.header(MINING_WORKER_AUTH_HEADER, t);
    }
    let res = req
        .send()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| WorkerCallError::Transport(e.to_string()))?;
    if text.is_empty() {
        return Ok(WorkerJson {
            status,
            body: Value::Object(serde_json::Map::new()),
        });
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|_| WorkerCallError::NonJson(status))?;
    Ok(WorkerJson {
        status,
        body: parsed,
    })
}

pub async fn ping_url(http: &reqwest::Client, url: &str) -> bool {
    http.get(url)
        .timeout(std::time::Duration::from_millis(READINESS_DEFAULT_MS))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub fn auth_unavailable_body() -> Value {
    serde_json::json!({
        "error": "Authentication service temporarily unavailable.",
        "code": "AUTH_WORKER_UNAVAILABLE"
    })
}

pub fn worker_unavailable_body(err: &WorkerCallError) -> Value {
    let code = match err {
        WorkerCallError::Unset(MINING_WORKER_UNSET) => "MINING_WORKER_UNAVAILABLE",
        WorkerCallError::Unset(HARDWARE_WORKER_UNSET) => "HARDWARE_WORKER_UNAVAILABLE",
        WorkerCallError::Unset(WALLET_WORKER_UNSET) => "WALLET_WORKER_UNAVAILABLE",
        WorkerCallError::Unset(AUTH_WORKER_UNSET) => "AUTH_WORKER_UNAVAILABLE",
        _ => "WORKER_UNAVAILABLE",
    };
    serde_json::json!({
        "error": err.message(),
        "code": code
    })
}

pub fn worker_infra_status(err: &WorkerCallError) -> u16 {
    if err.is_unset() {
        503
    } else {
        502
    }
}
