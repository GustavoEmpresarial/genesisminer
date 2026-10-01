//! Internal HTTP client → genesis-hardware `/v1/hardware/credit`.
//! Twin of Node `callHardwareCredit` (auth header + camelCase body).

use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};

use crate::config::{
    WorkerConfig, HARDWARE_CREDIT_TIMEOUT_MS, MINING_WORKER_AUTH_HEADER,
};
use crate::player_reads::{PlayerReadError, HTTP_SERVICE_UNAVAILABLE};

const HARDWARE_CREDIT_PATH: &str = "/v1/hardware/credit";
const HTTP_OK: u16 = 200;
const HARDWARE_WORKER_UNSET: &str = "GENESIS_HARDWARE_URL unset";

const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);

fn hardware_base(cfg: &WorkerConfig) -> Result<&str, PlayerReadError> {
    cfg.genesis_hardware_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            PlayerReadError::controlled(
                HTTP_SERVICE_UNAVAILABLE,
                HARDWARE_WORKER_UNSET,
                "HARDWARE_WORKER_UNSET",
            )
        })
}

/// Fail-closed credit (stock UPSERT / timed lease). Err when URL unset or worker not ok.
pub async fn call_hardware_credit(
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
    item_id: &str,
    qty: i64,
    duration_amount: Option<i64>,
    duration_unit: Option<&str>,
) -> Result<(), PlayerReadError> {
    let base = hardware_base(cfg)?;
    let url = format!("{}{HARDWARE_CREDIT_PATH}", base.trim_end_matches('/'));
    let mut body = json!({
        "userId": user_id,
        "itemId": item_id,
        "qty": qty,
    });
    if let Some(obj) = body.as_object_mut() {
        if let Some(amount) = duration_amount {
            obj.insert("durationAmount".into(), json!(amount));
        }
        if let Some(unit) = duration_unit {
            obj.insert("durationUnit".into(), json!(unit));
        }
    }
    let mut req = http
        .post(url)
        .timeout(Duration::from_millis(HARDWARE_CREDIT_TIMEOUT_MS))
        .json(&body);
    if let Some(token) = cfg.mining_worker_auth_token.as_deref() {
        req = req.header(MINING_WORKER_AUTH_HEADER, token);
    }
    let resp = req.send().await.map_err(|e| {
        PlayerReadError::controlled(
            HTTP_SERVICE_UNAVAILABLE,
            format!("hardware worker unreachable: {e}"),
            "HARDWARE_WORKER_UNREACHABLE",
        )
    })?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.map_err(|e| {
        PlayerReadError::controlled(
            HTTP_SERVICE_UNAVAILABLE,
            format!("hardware worker bad body: {e}"),
            "HARDWARE_WORKER_BAD_BODY",
        )
    })?;
    if status != HTTP_OK || body.get("ok") != Some(&Value::Bool(true)) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("hardware credit failed");
        return Err(PlayerReadError::controlled(
            if status == 0 {
                HTTP_SERVICE_UNAVAILABLE
            } else {
                status
            },
            err,
            body.get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("HARDWARE_CREDIT"),
        ));
    }
    Ok(())
}
