//! Wallet SIWE challenge/verify/get/remove — Node `wallet.ts` + `wallet-history.ts`.

use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_MINUTE;
use genesis_core::validate_optional_polygon_wallet;
use genesis_core::WalletValidation;
use serde_json::{json, Map, Value};
use tokio_postgres::types::Json;
use uuid::Uuid;

use super::audit::append_profile_audit_log;
use super::clamp_request_id;
use super::eth::{normalize_eth_address, verify_personal_message};
use crate::player_reads::{
    i64_cell, now_ms, opt_string, pg_user_id, string_cell, PlayerReadError, HTTP_UNPROCESSABLE,
};
use crate::support::LOCK_TIMEOUT_MS;

/// Node `POLYGON_CHAIN_ID`.
const POLYGON_CHAIN_ID: i32 = 137;
/// Node `CHALLENGE_TTL_MINUTES`.
const CHALLENGE_TTL_MINUTES: u64 = 10;
const CHALLENGE_TTL_MS: i64 = (CHALLENGE_TTL_MINUTES * MS_PER_MINUTE) as i64;
/// Node `CHALLENGE_NONCE_BYTES`.
const CHALLENGE_NONCE_BYTES: usize = 16;
/// Node `SIGNATURE_MAX_LENGTH`.
const SIGNATURE_MAX_LENGTH: usize = 300;
/// Node `WALLET_PREVIEW_TRUNCATE_CHARS`.
const WALLET_PREVIEW_TRUNCATE_CHARS: usize = 80;
/// Node `WALLET_RAW_TRUNCATE_CHARS`.
const WALLET_RAW_TRUNCATE_CHARS: usize = 200;
/// Node history field caps.
const IP_ADDRESS_MAX_CHARS: usize = 80;
const USER_AGENT_MAX_CHARS: usize = 500;
const SIGNATURE_ADDRESS_MAX_CHARS: usize = 80;
const NETWORK_MAX_CHARS: usize = 32;
const ACTOR_TYPE_MAX_CHARS: usize = 24;
const SOURCE_MAX_CHARS: usize = 80;
/// Node `WALLET_HISTORY_LIMIT_MIN`.
const WALLET_HISTORY_LIMIT_MIN: i64 = 1;
/// Node `WALLET_HISTORY_LIMIT_MAX`.
const WALLET_HISTORY_LIMIT_MAX: i64 = 200;
/// Node `WALLET_HISTORY_LIMIT_DEFAULT`.
const WALLET_HISTORY_LIMIT_DEFAULT: i64 = 100;

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_CONFLICT: u16 = 409;

const _: () = assert!(POLYGON_CHAIN_ID == 137);
const _: () = assert!(CHALLENGE_TTL_MINUTES == 10);
const _: () = assert!(CHALLENGE_TTL_MS == 600_000);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(SIGNATURE_MAX_LENGTH == 300);
const _: () = assert!(HTTP_UNPROCESSABLE == 422);

fn truncate_str(raw: Option<&str>, max: usize) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    Some(s.chars().take(max).collect())
}

fn try_normalize_wallet(raw: Option<&str>) -> Option<String> {
    let t = raw.map(str::trim).unwrap_or("");
    if t.is_empty() || t.eq_ignore_ascii_case("0x") || t.eq_ignore_ascii_case("null") {
        return None;
    }
    match normalize_eth_address(t) {
        Ok(a) => Some(a),
        Err(_) => Some(t.chars().take(WALLET_RAW_TRUNCATE_CHARS).collect()),
    }
}

pub async fn run_wallet_challenge(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let now = now_ms();
    let expires_at = now + CHALLENGE_TTL_MS;
    let mut nonce = [0u8; CHALLENGE_NONCE_BYTES];
    getrandom::getrandom(&mut nonce).map_err(|e| PlayerReadError::internal(e.to_string()))?;
    let nonce_hex = hex::encode(nonce);
    let message = format!(
        "Genesis Miner — ligação de carteira de saque (Polygon).\n\
ID interno do utilizador: {uid}\n\
Nonce: {nonce_hex}\n\
Expira (Unix ms): {expires_at}\n\
Chain ID: {POLYGON_CHAIN_ID}\n\
\n\
Assine esta mensagem para confirmar o endereço de saque. Nunca partilhe seed phrase nem chave privada."
    );
    let conn = pool.get().await?;
    let row = conn
        .query_one(
            "INSERT INTO profile_wallet_connect_challenges (user_id, message, expires_at, used_at)
             VALUES ($1, $2, $3, NULL)
             RETURNING id::text AS id",
            &[&uid, &message, &expires_at],
        )
        .await?;
    let challenge_id = string_cell(&row, "id");
    let mut meta = Map::new();
    meta.insert("challengeId".into(), Value::String(challenge_id.clone()));
    append_profile_audit_log(
        pool,
        Some(uid),
        "profile_wallet_challenge_created",
        None,
        None,
        Some(&meta),
    )
    .await;
    Ok(json!({
        "challengeId": challenge_id,
        "message": message,
        "expiresAt": expires_at,
        "chainId": POLYGON_CHAIN_ID
    }))
}

pub async fn run_wallet_verify(
    pool: &Pool,
    user_id: i64,
    challenge_id: Option<&str>,
    address: Option<&str>,
    signature: Option<&str>,
    chain_id: Option<&Value>,
    request_id: Option<&str>,
    route: Option<&str>,
    client_ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rid = clamp_request_id(request_id);
    let route_s = route.unwrap_or("/api/profile/wallet/connect/verify");

    let chain_num = match chain_id {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    let Some(chain_num) = chain_num else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Chain Invalid ID.",
            "VALIDATION",
        ));
    };
    if chain_num != i64::from(POLYGON_CHAIN_ID) {
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Use the Polygon network (chain ID 137).",
            "WRONG_CHAIN",
        ));
    }

    let ch_id = challenge_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    if ch_id.is_empty() {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "challengeId is required.",
            "VALIDATION",
        ));
    }

    let addr_norm = match validate_optional_polygon_wallet(address) {
        WalletValidation::Address(a) => normalize_eth_address(&a)?,
        WalletValidation::Err { error } => {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                error,
                "VALIDATION",
            ));
        }
        WalletValidation::Null => {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                "Invalid address.",
                "VALIDATION",
            ));
        }
    };

    let sig_raw = signature.map(str::trim).unwrap_or("");
    if sig_raw.is_empty() || sig_raw.len() > SIGNATURE_MAX_LENGTH {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Invalid signature.",
            "VALIDATION",
        ));
    }

    let conn = pool.get().await?;
    let ch_uuid = Uuid::parse_str(ch_id).map_err(|_| {
        PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            "Challenge not found.",
            "CHALLENGE_NOT_FOUND",
        )
    })?;
    let row = conn
        .query_opt(
            "SELECT id::text AS id, message, expires_at, used_at
               FROM profile_wallet_connect_challenges
              WHERE id = $1 AND user_id = $2",
            &[&ch_uuid, &uid],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::controlled(
            HTTP_NOT_FOUND,
            "Challenge not found.",
            "CHALLENGE_NOT_FOUND",
        ));
    };
    let used_at: Option<i64> = row.get("used_at");
    if used_at.is_some() {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "This challenge has already been used.",
            "NONCE_USED",
        ));
    }
    let expires_at = i64_cell(&row, "expires_at");
    if expires_at < now_ms() {
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Challenge expired. Generate a new one.",
            "CHALLENGE_EXPIRED",
        ));
    }
    let message = string_cell(&row, "message");

    let recovered = match verify_personal_message(&message, sig_raw) {
        Ok(a) => a,
        Err(e)
            if e.code.as_deref() == Some("SIGNATURE_INVALID")
                || e.http_status == HTTP_UNPROCESSABLE =>
        {
            append_profile_audit_log(
                pool,
                Some(uid),
                "profile_wallet_verify_signature_invalid",
                Some(route_s),
                rid.as_deref(),
                Some(&Map::new()),
            )
            .await;
            return Err(PlayerReadError::controlled(
                HTTP_UNPROCESSABLE,
                "Invalid signature.",
                "SIGNATURE_INVALID",
            ));
        }
        Err(e) => return Err(e),
    };
    if recovered != addr_norm {
        append_profile_audit_log(
            pool,
            Some(uid),
            "profile_wallet_verify_address_mismatch",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Signature does not match the stated address.",
            "ADDRESS_MISMATCH",
        ));
    }

    let existing = conn
        .query_opt("SELECT polygon_wallet FROM users WHERE id = $1", &[&uid])
        .await?;
    let existing_wallet = existing
        .as_ref()
        .and_then(|r| opt_string(r, "polygon_wallet"));
    if let Some(ref ew) = existing_wallet {
        if let Ok(norm) = normalize_eth_address(ew) {
            if norm == addr_norm {
                let now = now_ms();
                conn.execute(
                    "UPDATE profile_wallet_connect_challenges SET used_at = $1 WHERE id = $2",
                    &[&now, &ch_uuid],
                )
                .await?;
                return Ok(json!({ "address": addr_norm }));
            }
        }
    }

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await?;
    let locked = tx
        .query(
            "SELECT id FROM profile_wallet_connect_challenges
              WHERE id = $1 AND user_id = $2 AND used_at IS NULL
              FOR UPDATE",
            &[&ch_uuid, &uid],
        )
        .await?;
    if locked.is_empty() {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "Challenge already consumed.",
            "NONCE_USED",
        ));
    }
    let now = now_ms();
    tx.execute(
        "UPDATE profile_wallet_connect_challenges SET used_at = $1 WHERE id = $2",
        &[&now, &ch_uuid],
    )
    .await?;
    tx.execute(
        "UPDATE users SET polygon_wallet = $1 WHERE id = $2",
        &[&addr_norm, &uid],
    )
    .await?;

    let prev_raw = existing_wallet
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let prev_for_history = if prev_raw.is_empty() {
        None
    } else {
        Some(match normalize_eth_address(prev_raw) {
            Ok(a) => a,
            Err(_) => prev_raw
                .chars()
                .take(WALLET_PREVIEW_TRUNCATE_CHARS)
                .collect(),
        })
    };
    let action = if prev_for_history.is_some() {
        "changed"
    } else {
        "connected"
    };
    let meta_json = json!({ "challengeId": ch_id });
    append_wallet_history(
        &tx,
        uid,
        action,
        &addr_norm,
        prev_for_history.as_deref(),
        Some(&addr_norm),
        client_ip,
        user_agent,
        Some(&addr_norm),
        Some(meta_json),
        "profile_connect_verify",
    )
    .await?;
    tx.commit().await?;

    let mut meta = Map::new();
    meta.insert("address".into(), Value::String(addr_norm.clone()));
    append_profile_audit_log(
        pool,
        Some(uid),
        "profile_wallet_connected",
        Some(route_s),
        rid.as_deref(),
        Some(&meta),
    )
    .await;

    Ok(json!({ "address": addr_norm }))
}

async fn append_wallet_history<C: deadpool_postgres::GenericClient>(
    db: &C,
    user_id: i32,
    action: &str,
    wallet_address: &str,
    previous: Option<&str>,
    new_wallet: Option<&str>,
    ip: Option<&str>,
    ua: Option<&str>,
    signature_address: Option<&str>,
    metadata: Option<Value>,
    source: &str,
) -> Result<(), PlayerReadError> {
    let now = now_ms();
    let network = "polygon"
        .chars()
        .take(NETWORK_MAX_CHARS)
        .collect::<String>();
    let actor = "user"
        .chars()
        .take(ACTOR_TYPE_MAX_CHARS)
        .collect::<String>();
    let source_s = source.chars().take(SOURCE_MAX_CHARS).collect::<String>();
    let meta = metadata.map(Json);
    db.execute(
        "INSERT INTO user_wallet_history (
            user_id, action, network, wallet_address, previous_wallet_address, new_wallet_address,
            ip_address, user_agent, signature_address, signature_message, created_at, metadata,
            actor_type, actor_user_id, source, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,NULL,$13,NULL)",
        &[
            &user_id,
            &action,
            &network,
            &wallet_address,
            &previous,
            &new_wallet,
            &truncate_str(ip, IP_ADDRESS_MAX_CHARS),
            &truncate_str(ua, USER_AGENT_MAX_CHARS),
            &truncate_str(signature_address, SIGNATURE_ADDRESS_MAX_CHARS),
            &now,
            &meta,
            &actor,
            &source_s,
        ],
    )
    .await?;
    Ok(())
}

pub async fn run_wallet_remove(
    pool: &Pool,
    user_id: i64,
    request_id: Option<&str>,
    route: Option<&str>,
    client_ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let rid = clamp_request_id(request_id);
    let route_s = route.unwrap_or("POST /api/profile/wallet/remove");
    let conn = pool.get().await?;
    let row = conn
        .query_opt("SELECT polygon_wallet FROM users WHERE id = $1", &[&uid])
        .await?;
    let raw_wallet = row
        .as_ref()
        .and_then(|r| opt_string(r, "polygon_wallet"))
        .unwrap_or_default();
    let trimmed = raw_wallet.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("0x")
        || trimmed.eq_ignore_ascii_case("null")
    {
        return Ok(json!({
            "removed": false,
            "message": "No wallet connected.",
            "wallet": Value::Null
        }));
    }
    let removed_addr = normalize_eth_address(trimmed).unwrap_or_else(|_| trimmed.to_string());

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    append_wallet_history(
        &tx,
        uid,
        "removed",
        &removed_addr,
        Some(&removed_addr),
        None,
        client_ip,
        user_agent,
        None,
        Some(json!({ "source": "profile_wallet_remove" })),
        "profile_remove",
    )
    .await?;
    tx.execute(
        "UPDATE users SET polygon_wallet = NULL WHERE id = $1",
        &[&uid],
    )
    .await?;
    tx.commit().await?;

    let mut meta = Map::new();
    meta.insert("address".into(), Value::String(removed_addr));
    append_profile_audit_log(
        pool,
        Some(uid),
        "profile_wallet_removed",
        Some(route_s),
        rid.as_deref(),
        Some(&meta),
    )
    .await;

    Ok(json!({
        "removed": true,
        "message": "Wallet removed successfully.",
        "wallet": Value::Null
    }))
}

pub async fn run_wallet_get(
    pool: &Pool,
    user_id: i64,
    history_limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let lim = history_limit
        .unwrap_or(WALLET_HISTORY_LIMIT_DEFAULT)
        .clamp(WALLET_HISTORY_LIMIT_MIN, WALLET_HISTORY_LIMIT_MAX);
    let conn = pool.get().await?;
    let user_row = conn
        .query_opt("SELECT polygon_wallet FROM users WHERE id = $1", &[&uid])
        .await?;
    let addr_norm = try_normalize_wallet(
        user_row
            .as_ref()
            .and_then(|r| opt_string(r, "polygon_wallet"))
            .as_deref(),
    );

    let mut connected_at: Option<String> = None;
    if let Some(ref addr) = addr_norm {
        let last = conn
            .query_opt(
                "SELECT created_at FROM user_wallet_history
                  WHERE user_id = $1
                    AND action = ANY(ARRAY['connected','changed','admin_changed'])
                    AND (new_wallet_address = $2 OR wallet_address = $2)
                  ORDER BY created_at DESC
                  LIMIT 1",
                &[&uid, addr],
            )
            .await?;
        if let Some(r) = last {
            let ms = i64_cell(&r, "created_at");
            connected_at = Some(ms_to_iso(ms));
        }
    }

    let hist = conn
        .query(
            "SELECT id::text AS id, action, wallet_address, network, previous_wallet_address,
                    new_wallet_address, ip_address, user_agent, created_at, actor_type,
                    actor_user_id, source, notes, metadata
               FROM user_wallet_history
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let history: Vec<Value> = hist
        .iter()
        .map(|r| {
            let meta: Option<Value> = r
                .try_get::<_, Option<Json<Value>>>("metadata")
                .ok()
                .flatten()
                .map(|j| j.0);
            json!({
                "id": string_cell(r, "id"),
                "action": string_cell(r, "action"),
                "walletAddress": opt_string(r, "wallet_address"),
                "network": opt_string(r, "network"),
                "previousWalletAddress": opt_string(r, "previous_wallet_address"),
                "newWalletAddress": opt_string(r, "new_wallet_address"),
                "ipAddress": opt_string(r, "ip_address"),
                "userAgent": opt_string(r, "user_agent"),
                "createdAt": ms_to_iso(i64_cell(r, "created_at")),
                "actorType": opt_string(r, "actor_type"),
                "actorUserId": r.try_get::<_, Option<i32>>("actor_user_id").ok().flatten(),
                "source": opt_string(r, "source"),
                "notes": opt_string(r, "notes"),
                "metadata": meta
            })
        })
        .collect();

    let wallet = addr_norm.map(|a| {
        json!({
            "address": a,
            "network": "polygon",
            "connectedAt": connected_at
        })
    });

    Ok(json!({
        "wallet": wallet,
        "history": history
    }))
}

fn ms_to_iso(ms: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let d = Duration::from_millis(ms.max(0) as u64);
    let dt = UNIX_EPOCH + d;
    // Format as RFC3339-ish via chrono-less: use httpdate-style approx
    // Prefer simple ISO from secs.
    let secs = dt
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_secs())
        .unwrap_or(0);
    let millis = (ms.max(0) as u64) % 1000;
    // Use a minimal UTC formatter without chrono.
    format_unix_ms_iso(secs, millis)
}

fn format_unix_ms_iso(secs: u64, millis: u64) -> String {
    // Civil date from unix seconds (UTC) — algorithm from civil_from_days.
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days (UTC).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}
