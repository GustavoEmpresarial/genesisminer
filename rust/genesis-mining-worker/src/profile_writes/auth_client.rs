//! Internal HTTP client → genesis-auth password hash/verify + refresh revoke.

use reqwest::Client;
use serde_json::{json, Value};

use crate::config::{WorkerConfig, MINING_WORKER_AUTH_HEADER};
use crate::player_reads::{PlayerReadError, HTTP_SERVICE_UNAVAILABLE};
use genesis_core::auth::constants::BCRYPT_ROUNDS_PROFILE;

const PASSWORD_HASH_PATH: &str = "/v1/auth/password/hash";
const PASSWORD_VERIFY_PATH: &str = "/v1/auth/password/verify";
const REFRESH_REVOKE_PATH: &str = "/v1/auth/refresh/revoke";
const SESSION_DELETE_BY_USER_PATH: &str = "/v1/auth/session/delete-by-user";
const HTTP_OK: u16 = 200;

const _: () = assert!(BCRYPT_ROUNDS_PROFILE == 10);
const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);

fn auth_base(cfg: &WorkerConfig) -> Result<&str, PlayerReadError> {
    cfg.genesis_auth_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            PlayerReadError::controlled(
                HTTP_SERVICE_UNAVAILABLE,
                "GENESIS_AUTH_URL unset",
                "AUTH_WORKER_UNSET",
            )
        })
}

async fn post_auth(
    http: &Client,
    cfg: &WorkerConfig,
    path: &str,
    body: &Value,
) -> Result<Value, PlayerReadError> {
    let base = auth_base(cfg)?;
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let mut req = http.post(url).json(body);
    if let Some(token) = cfg.mining_worker_auth_token.as_deref() {
        req = req.header(MINING_WORKER_AUTH_HEADER, token);
    }
    let resp = req.send().await.map_err(|e| {
        PlayerReadError::controlled(
            HTTP_SERVICE_UNAVAILABLE,
            format!("auth worker unreachable: {e}"),
            "AUTH_WORKER_UNREACHABLE",
        )
    })?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.map_err(|e| {
        PlayerReadError::controlled(
            HTTP_SERVICE_UNAVAILABLE,
            format!("auth worker bad body: {e}"),
            "AUTH_WORKER_BAD_BODY",
        )
    })?;
    if status != HTTP_OK || body.get("ok") != Some(&Value::Bool(true)) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("auth worker error");
        return Err(PlayerReadError::controlled(
            if status == 0 {
                HTTP_SERVICE_UNAVAILABLE
            } else {
                status
            },
            err,
            body.get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("AUTH_WORKER"),
        ));
    }
    Ok(body)
}

pub async fn auth_verify_password(
    http: &Client,
    cfg: &WorkerConfig,
    password: &str,
    hash: &str,
) -> Result<bool, PlayerReadError> {
    let body = post_auth(
        http,
        cfg,
        PASSWORD_VERIFY_PATH,
        &json!({ "password": password, "hash": hash }),
    )
    .await?;
    Ok(body.get("match").and_then(|v| v.as_bool()).unwrap_or(false))
}

pub async fn auth_hash_password(
    http: &Client,
    cfg: &WorkerConfig,
    password: &str,
) -> Result<String, PlayerReadError> {
    let body = post_auth(
        http,
        cfg,
        PASSWORD_HASH_PATH,
        &json!({ "password": password, "rounds": BCRYPT_ROUNDS_PROFILE }),
    )
    .await?;
    body.get("hash")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            PlayerReadError::controlled(
                HTTP_SERVICE_UNAVAILABLE,
                "auth worker missing hash",
                "AUTH_WORKER",
            )
        })
}

pub async fn auth_revoke_refresh(
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
) -> Result<(), PlayerReadError> {
    let _ = post_auth(
        http,
        cfg,
        REFRESH_REVOKE_PATH,
        &json!({ "userId": user_id }),
    )
    .await?;
    Ok(())
}

/// Node `callAuthSessionDeleteByUser` — fail-closed, like the account delete it
/// belongs to (a surviving session would outlive the account row).
pub async fn auth_session_delete_by_user(
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
) -> Result<(), PlayerReadError> {
    let _ = post_auth(
        http,
        cfg,
        SESSION_DELETE_BY_USER_PATH,
        &json!({ "userId": user_id }),
    )
    .await?;
    Ok(())
}
