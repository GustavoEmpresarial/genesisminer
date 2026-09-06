//! Profile GET state (mínimo) — Node `buildProfileStatePayload` without referral-code write.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{i32_cell, opt_string, pg_user_id, string_cell, PlayerReadError};

/// Node `REFERRAL_DEPOSIT_COMMISSION_PERCENT`.
const REFERRAL_DEPOSIT_COMMISSION_PERCENT: i32 = 5;
/// Node `POLYGON_CHAIN_ID`.
const POLYGON_CHAIN_ID: i32 = 137;
/// Node `USERNAME_MIN_LENGTH`.
const USERNAME_MIN_LENGTH: i32 = 3;
/// Node `USERNAME_MAX_LENGTH`.
const USERNAME_MAX_LENGTH: i32 = 50;
/// Node `PASSWORD_MAX_LENGTH`.
const PASSWORD_MAX_LENGTH: i32 = 50;
/// Node `REFERRAL_CODE_MAX_LENGTH`.
const REFERRAL_CODE_MAX_LENGTH: i32 = 50;

const _: () = assert!(REFERRAL_DEPOSIT_COMMISSION_PERCENT == 5);
const _: () = assert!(POLYGON_CHAIN_ID == 137);
const _: () = assert!(USERNAME_MIN_LENGTH == 3);
const _: () = assert!(USERNAME_MAX_LENGTH == 50);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    pub user_id: i64,
    #[serde(default)]
    pub invite_base_url: Option<String>,
}

pub async fn run_profile_state(
    pool: &Pool,
    user_id: i64,
    invite_base_url: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let user = conn
        .query_opt(
            "SELECT id, username, email, access_level_id, polygon_wallet, referral_code, referred_by, is_blocked
               FROM users WHERE id = $1",
            &[&uid],
        )
        .await?;
    let Some(user) = user else {
        return Ok(json!({ "ok": false, "error": "User not found." }));
    };
    let invited = conn
        .query_one(
            "SELECT COUNT(*)::int AS n FROM referrals WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let invited_count = i32_cell(&invited, "n");
    let levels = conn
        .query(
            "SELECT id, name, is_active, news_posting_enabled FROM access_levels",
            &[],
        )
        .await?;
    let primary = opt_string(&user, "access_level_id").unwrap_or_default();
    let access_label = levels
        .iter()
        .find(|r| string_cell(r, "id") == primary)
        .map(|r| string_cell(r, "name"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if primary.is_empty() {
                "—".into()
            } else {
                primary.clone()
            }
        });
    let extra_ids = conn
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await;
    let mut user_lvl_ids = Vec::new();
    if !primary.is_empty() {
        user_lvl_ids.push(primary.clone());
    }
    if let Ok(rows) = extra_ids {
        for r in rows {
            let id = string_cell(&r, "access_level_id");
            if !id.is_empty() && !user_lvl_ids.contains(&id) {
                user_lvl_ids.push(id);
            }
        }
    }
    let referral_code = opt_string(&user, "referral_code").unwrap_or_default();
    let base = safe_invite_base(invite_base_url.unwrap_or(""));
    let invite_url = if !referral_code.is_empty() && !base.is_empty() {
        format!("{base}/registro?ref={}", urlencoding_lite(&referral_code))
    } else if !referral_code.is_empty() {
        format!("/registro?ref={}", urlencoding_lite(&referral_code))
    } else {
        String::new()
    };
    let wallet = opt_string(&user, "polygon_wallet");
    Ok(json!({
        "ok": true,
        "identity": {
            "email": string_cell(&user, "email"),
            "username": string_cell(&user, "username"),
            "displayName": string_cell(&user, "username"),
            "accessLevelId": primary,
            "accessLevelLabel": access_label,
            "status": if i32_cell(&user, "is_blocked") != 0 { "blocked" } else { "active" },
            "emailReadOnly": true
        },
        "permissions": {
            "canChangeUsername": true,
            "canBindReferral": opt_string(&user, "referred_by").is_none(),
            "canConnectWallet": true,
            "canRemoveWallet": wallet.is_some()
        },
        "limits": {
            "usernameMin": USERNAME_MIN_LENGTH,
            "usernameMax": USERNAME_MAX_LENGTH,
            "passwordMax": PASSWORD_MAX_LENGTH,
            "referralCodeMax": REFERRAL_CODE_MAX_LENGTH
        },
        "referral": {
            "code": referral_code,
            "inviteUrl": invite_url,
            "invitedCount": invited_count,
            "commissionPercent": REFERRAL_DEPOSIT_COMMISSION_PERCENT,
            "commissionRule": "O indicador recebe comissão em USDC apenas quando o indicado tem depósito USDC creditado; o valor é calculado no servidor.",
            "referredBy": opt_string(&user, "referred_by")
        },
        "wallet": {
            "network": "polygon",
            "chainId": POLYGON_CHAIN_ID,
            "address": wallet
        },
        "accessLevelsCatalog": levels.iter().map(|l| json!({
            "id": string_cell(l, "id"),
            "name": string_cell(l, "name"),
            "isActive": i32_cell(l, "is_active") != 0,
            "newsPostingEnabled": i32_cell(l, "news_posting_enabled") != 0
        })).collect::<Vec<_>>(),
        "userAccessLevelIds": user_lvl_ids
    }))
}

fn safe_invite_base(raw: &str) -> String {
    let t = raw.trim().trim_end_matches('/');
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return String::new();
    }
    let rest = if let Some(r) = t.strip_prefix("https://") {
        r
    } else if let Some(r) = t.strip_prefix("http://") {
        r
    } else {
        return String::new();
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    if host.is_empty() {
        return String::new();
    }
    let scheme = if lower.starts_with("https://") {
        "https"
    } else {
        "http"
    };
    format!("{scheme}://{host}")
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
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
