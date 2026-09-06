//! Internal HTTP → genesis-auth session load / update-flags.
//! Espelho de `callAuthSessionLoad` / `callAuthSessionUpdateFlags`.

use reqwest::Client;
use serde_json::{json, Value};

use crate::config::{WorkerConfig, MINING_WORKER_AUTH_HEADER};
use crate::player_reads::{PlayerReadError, HTTP_SERVICE_UNAVAILABLE};

const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
const SESSION_UPDATE_FLAGS_PATH: &str = "/v1/auth/session/update-flags";
const HTTP_OK: u16 = 200;
const HTTP_UNAUTHORIZED: u16 = 401;
/// Mirror `genesis-auth` / Node `SESSION_MANAGER_MODE_OFF`.
pub const SESSION_MANAGER_MODE_OFF: i32 = 0;
/// Mirror `genesis-auth` / Node `SESSION_MANAGER_MODE_ON`.
pub const SESSION_MANAGER_MODE_ON: i32 = 1;

const _: () = assert!(SESSION_MANAGER_MODE_OFF == 0);
const _: () = assert!(SESSION_MANAGER_MODE_ON == 1);
const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);

pub struct SessionLoaded {
    pub user_id: i64,
    pub original_user_id: Option<i64>,
    pub manager_mode: i32,
    #[allow(dead_code)]
    pub acting_as_owner_id: Option<i64>,
}

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
) -> Result<(u16, Value), PlayerReadError> {
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
    Ok((status, body))
}

fn json_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| {
            v.as_f64().and_then(|f| {
                if f.is_finite() && f.fract() == 0.0 {
                    Some(f as i64)
                } else {
                    None
                }
            })
        })
}

pub async fn auth_session_load(
    http: &Client,
    cfg: &WorkerConfig,
    session_id: &str,
) -> Result<SessionLoaded, PlayerReadError> {
    let (status, body) = post_auth(
        http,
        cfg,
        SESSION_LOAD_PATH,
        &json!({ "sessionId": session_id, "includeExpired": true }),
    )
    .await?;
    if status == HTTP_UNAUTHORIZED || body.get("ok") != Some(&Value::Bool(true)) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("session not found");
        return Err(PlayerReadError::controlled(
            if status == HTTP_UNAUTHORIZED {
                HTTP_UNAUTHORIZED
            } else if status == 0 {
                HTTP_SERVICE_UNAVAILABLE
            } else {
                status
            },
            err,
            body.get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("NO_SESSION"),
        ));
    }
    let user_id = body
        .get("userId")
        .and_then(json_i64)
        .filter(|i| *i > 0)
        .ok_or_else(|| {
            PlayerReadError::controlled(
                HTTP_SERVICE_UNAVAILABLE,
                "auth session missing userId",
                "AUTH_WORKER",
            )
        })?;
    let original_user_id = body
        .get("originalUserId")
        .and_then(json_i64)
        .filter(|i| *i > 0);
    let manager_mode = body
        .get("managerMode")
        .and_then(json_i64)
        .map(|i| i as i32)
        .unwrap_or(SESSION_MANAGER_MODE_OFF);
    let acting_as_owner_id = body
        .get("actingAsOwnerId")
        .and_then(json_i64)
        .filter(|i| *i > 0);
    Ok(SessionLoaded {
        user_id,
        original_user_id,
        manager_mode,
        acting_as_owner_id,
    })
}

pub async fn auth_session_update_flags(
    http: &Client,
    cfg: &WorkerConfig,
    body: Value,
) -> Result<(), PlayerReadError> {
    let (status, resp) = post_auth(http, cfg, SESSION_UPDATE_FLAGS_PATH, &body).await?;
    if status != HTTP_OK || resp.get("ok") != Some(&Value::Bool(true)) {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("auth session update-flags failed");
        return Err(PlayerReadError::controlled(
            if status == 0 {
                HTTP_SERVICE_UNAVAILABLE
            } else {
                status
            },
            err,
            resp.get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("AUTH_WORKER"),
        ));
    }
    Ok(())
}

pub async fn auth_session_restore_from_original(
    http: &Client,
    cfg: &WorkerConfig,
    match_acting_as_owner_id: i64,
    match_original_user_id: Option<i64>,
) -> Result<(), PlayerReadError> {
    let mut body = json!({
        "restoreUserIdFromOriginal": true,
        "matchActingAsOwnerId": match_acting_as_owner_id,
    });
    if let Some(mid) = match_original_user_id {
        body["matchOriginalUserId"] = json!(mid);
    }
    auth_session_update_flags(http, cfg, body).await
}
