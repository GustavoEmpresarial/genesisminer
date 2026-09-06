//! Referral bind / overview / state — Node referral-bind + overview + state slice.

use deadpool_postgres::Pool;
use genesis_core::validate_optional_referral_code_input;
use serde_json::{json, Map, Value};

use super::audit::append_profile_audit_log;
use super::clamp_request_id;
use crate::player_reads::profile::run_profile_state;
use crate::player_reads::{
    f64_cell, i32_cell, i64_cell, now_ms, opt_string, pg_user_id, string_cell, PlayerReadError,
    HTTP_UNPROCESSABLE,
};
use crate::support::LOCK_TIMEOUT_MS;

/// Node `REFERRAL_DEPOSIT_COMMISSION_PERCENT`.
const REFERRAL_DEPOSIT_COMMISSION_PERCENT: i32 = 5;
const PERCENT_TO_RATE: f64 = 100.0;
/// Node `SOURCE_TRANSACTION_ID_MAX_CHARS`.
const SOURCE_TRANSACTION_ID_MAX_CHARS: usize = 240;
/// Node `EMAIL_MASK_VISIBLE_CHARS`.
const EMAIL_MASK_VISIBLE_CHARS: usize = 2;
/// Node `OVERVIEW_HISTORY_LIMIT_MIN/MAX/DEFAULT`.
const OVERVIEW_HISTORY_LIMIT_MIN: i64 = 10;
const OVERVIEW_HISTORY_LIMIT_MAX: i64 = 200;
const OVERVIEW_HISTORY_LIMIT_DEFAULT: i64 = 50;
/// Node `REFERRAL_BONUS_NOT_CLAIMED`.
const REFERRAL_BONUS_NOT_CLAIMED: i32 = 0;

const HTTP_UNAUTHORIZED: u16 = 401;
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_CONFLICT: u16 = 409;

const _: () = assert!(REFERRAL_DEPOSIT_COMMISSION_PERCENT == 5);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(HTTP_UNPROCESSABLE == 422);
const _: () = assert!(OVERVIEW_HISTORY_LIMIT_DEFAULT == 50);

fn mask_email(email: Option<&str>) -> Option<String> {
    let t = email.map(str::trim).unwrap_or("").to_lowercase();
    if t.is_empty() || !t.contains('@') {
        return None;
    }
    let (local, domain) = t.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    let visible_n = EMAIL_MASK_VISIBLE_CHARS.min(local.len());
    let visible = &local[..visible_n];
    let stars = "*".repeat((local.len() - visible_n).max(1));
    Some(format!("{visible}{stars}@{domain}"))
}

pub async fn run_referral_state(
    pool: &Pool,
    user_id: i64,
    invite_base_url: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let st = run_profile_state(pool, user_id, invite_base_url).await?;
    let referral = st.get("referral").cloned().unwrap_or(Value::Null);
    Ok(json!({ "referral": referral }))
}

pub async fn run_referral_bind(
    pool: &Pool,
    user_id: i64,
    code_raw: Option<&str>,
    request_id: Option<&str>,
    route: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    if user_id <= 0 {
        return Err(PlayerReadError::controlled(
            HTTP_UNAUTHORIZED,
            "Not authenticated.",
            "AUTH_REQUIRED",
        ));
    }
    let rid = clamp_request_id(request_id);
    let route_s = route.unwrap_or("/api/profile/referral/bind");

    let code_check = validate_optional_referral_code_input(code_raw);
    if !code_check.ok {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            code_check
                .error
                .unwrap_or_else(|| "Invalid referral code.".into()),
            "VALIDATION",
        ));
    }
    let Some(code_normalized) = code_check.code.filter(|c| !c.is_empty()) else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Provide the referral code.",
            "VALIDATION",
        ));
    };

    let conn = pool.get().await?;
    let self_peek = conn
        .query_opt(
            "SELECT username, referred_by, referral_code FROM users WHERE id = $1",
            &[&uid],
        )
        .await?;
    let Some(self_peek) = self_peek else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "User not found.",
            "NOT_FOUND",
        ));
    };
    if opt_string(&self_peek, "username").is_none() {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "User not found.",
            "NOT_FOUND",
        ));
    }
    if opt_string(&self_peek, "referred_by").is_some() {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "Code already linked.",
            "REFERRAL_ALREADY_BOUND",
        ));
    }

    let referrer = conn
        .query_opt(
            "SELECT id, username, referral_code FROM users
              WHERE LOWER(referral_code) = LOWER($1)
              LIMIT 1",
            &[&code_normalized],
        )
        .await?;
    let Some(referrer) = referrer else {
        append_profile_audit_log(
            pool,
            Some(uid),
            "referral_bind_invalid_code",
            Some(route_s),
            rid.as_deref(),
            Some(&meta_reason("code_not_found")),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Invalid referral code.",
            "REFERRAL_CODE_INVALID",
        ));
    };
    let referrer_id: i32 = referrer.get("id");
    if referrer_id == uid {
        append_profile_audit_log(
            pool,
            Some(uid),
            "referral_bind_self_attempt",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "You cannot use your own code.",
            "REFERRAL_SELF",
        ));
    }
    let self_code = opt_string(&self_peek, "referral_code").unwrap_or_default();
    let ref_code = opt_string(&referrer, "referral_code").unwrap_or_default();
    if !self_code.is_empty() && self_code.eq_ignore_ascii_case(&ref_code) {
        append_profile_audit_log(
            pool,
            Some(uid),
            "referral_bind_self_code_match",
            Some(route_s),
            rid.as_deref(),
            Some(&Map::new()),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "You cannot use your own code.",
            "REFERRAL_SELF",
        ));
    }

    let referrer_username = string_cell(&referrer, "username");
    let cycle = conn
        .query_opt(
            "SELECT id FROM referrals WHERE user_id = $1 AND referred_username = $2 LIMIT 1",
            &[&uid, &referrer_username],
        )
        .await?;
    if cycle.is_some() {
        let mut meta = Map::new();
        meta.insert("referrerId".into(), json!(referrer_id));
        append_profile_audit_log(
            pool,
            Some(uid),
            "referral_bind_cycle_blocked",
            Some(route_s),
            rid.as_deref(),
            Some(&meta),
        )
        .await;
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "You cannot use the code of someone you already referred.",
            "REFERRAL_CYCLE",
        ));
    }

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await?;
    let locked = tx
        .query(
            "SELECT id, referred_by, username FROM users WHERE id = $1 FOR UPDATE",
            &[&uid],
        )
        .await?;
    let Some(self_row) = locked.first() else {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "User not found.",
            "NOT_FOUND",
        ));
    };
    if opt_string(self_row, "username").is_none() {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "User not found.",
            "NOT_FOUND",
        ));
    }
    if opt_string(self_row, "referred_by").is_some() {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            "Code already linked.",
            "REFERRAL_ALREADY_BOUND",
        ));
    }
    let referred_username = string_cell(self_row, "username");
    tx.execute(
        "UPDATE users SET referred_by = $1 WHERE id = $2",
        &[&code_normalized, &uid],
    )
    .await?;
    bind_referral_and_accrue_claim(&tx, referrer_id, &referred_username).await?;
    tx.commit().await?;

    let mut meta = Map::new();
    meta.insert("referrerId".into(), json!(referrer_id));
    append_profile_audit_log(
        pool,
        Some(uid),
        "referral_bound",
        Some(route_s),
        rid.as_deref(),
        Some(&meta),
    )
    .await;

    Ok(json!({}))
}

async fn bind_referral_and_accrue_claim<C: deadpool_postgres::GenericClient>(
    tx: &C,
    referrer_id: i32,
    referred_username: &str,
) -> Result<(), PlayerReadError> {
    if referrer_id <= 0 || referred_username.trim().is_empty() {
        return Ok(());
    }
    let lock_key = format!("{referrer_id}:{referred_username}");
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        &[&"referral_bind", &lock_key],
    )
    .await?;
    let existing = tx
        .query_opt(
            "SELECT id FROM referrals WHERE user_id = $1 AND referred_username = $2 LIMIT 1",
            &[&referrer_id, &referred_username],
        )
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO referrals (user_id, referred_username) VALUES ($1, $2)",
        &[&referrer_id, &referred_username],
    )
    .await?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO game_states (
            user_id, usdc, start_time, last_updated_at, claimed_referrals,
            referral_bonus_claimed, black_market_balance
         ) VALUES ($1, 0, $2, $2, 1, $3, 0)
         ON CONFLICT (user_id) DO UPDATE SET
            claimed_referrals = game_states.claimed_referrals + 1,
            last_updated_at = EXCLUDED.last_updated_at",
        &[&referrer_id, &now, &REFERRAL_BONUS_NOT_CLAIMED],
    )
    .await?;
    Ok(())
}

pub async fn run_referral_overview(
    pool: &Pool,
    user_id: i64,
    invite_base_url: Option<&str>,
    history_limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    if user_id <= 0 {
        return Err(PlayerReadError::bad(
            "uid inválido em buildReferralOverview",
        ));
    }
    let limit = history_limit
        .unwrap_or(OVERVIEW_HISTORY_LIMIT_DEFAULT)
        .clamp(OVERVIEW_HISTORY_LIMIT_MIN, OVERVIEW_HISTORY_LIMIT_MAX);

    let conn = pool.get().await?;
    let user_row = conn
        .query_opt(
            "SELECT id, username, referral_code, referred_by FROM users WHERE id = $1",
            &[&uid],
        )
        .await?;
    let referral_code = user_row
        .as_ref()
        .and_then(|r| opt_string(r, "referral_code"));
    let referred_by = user_row.as_ref().and_then(|r| opt_string(r, "referred_by"));
    let base = invite_base_url.unwrap_or("").trim().trim_end_matches('/');
    let invite_url = match referral_code.as_deref() {
        Some(code) if !code.is_empty() && !base.is_empty() => {
            Some(format!("{base}/registro?ref={}", urlencoding_lite(code)))
        }
        Some(code) if !code.is_empty() => Some(format!("/registro?ref={}", urlencoding_lite(code))),
        _ => None,
    };

    let referred_rows = conn
        .query(
            "SELECT
                u.id AS referred_user_id,
                u.username AS username,
                u.email AS email,
                rl.link_id AS link_id,
                cm.first_commission_at AS first_commission_at,
                COALESCE(cm.total_deposit, 0)::float8 AS total_deposit_usdc,
                COALESCE(cm.total_commission, 0)::float8 AS total_commission_usdc,
                COALESCE(cm.commissions_count, 0) AS commissions_count
             FROM users u
             JOIN (
                SELECT referred_username, MIN(id) AS link_id
                FROM referrals
                WHERE user_id = $1
                GROUP BY referred_username
             ) rl ON rl.referred_username = u.username
             LEFT JOIN (
                SELECT
                  referred_user_id,
                  MIN(created_at) AS first_commission_at,
                  SUM(base_amount_usdc) AS total_deposit,
                  SUM(commission_usdc) AS total_commission,
                  COUNT(id) AS commissions_count
                FROM referral_commission_ledger
                WHERE referrer_user_id = $1
                GROUP BY referred_user_id
             ) cm ON cm.referred_user_id = u.id
             ORDER BY rl.link_id DESC",
            &[&uid],
        )
        .await?;

    let commission_rows = conn
        .query(
            "SELECT
                l.id::text AS id,
                l.created_at AS created_at,
                l.referred_user_id AS referred_user_id,
                l.base_amount_usdc AS base_amount_usdc,
                l.commission_percent AS commission_percent,
                l.commission_usdc AS commission_usdc,
                l.source_type AS source_type,
                l.idempotency_key AS idempotency_key,
                u.username AS referred_username,
                u.email AS referred_email
             FROM referral_commission_ledger l
             LEFT JOIN users u ON u.id = l.referred_user_id
             WHERE l.referrer_user_id = $1
             ORDER BY l.created_at DESC
             LIMIT $2",
            &[&uid, &limit],
        )
        .await?;

    let referred_users: Vec<Value> = referred_rows
        .iter()
        .map(|row| {
            json!({
                "id": i32_cell(row, "referred_user_id"),
                "username": opt_string(row, "username"),
                "emailMasked": mask_email(opt_string(row, "email").as_deref()),
                "createdAt": i64_cell(row, "first_commission_at"),
                "linkId": i64_cell(row, "link_id"),
                "totalDepositedUsdc": f64_cell(row, "total_deposit_usdc"),
                "totalCommissionUsdc": f64_cell(row, "total_commission_usdc"),
                "commissionsCount": f64_cell(row, "commissions_count") as i64
            })
        })
        .collect();

    let commissions: Vec<Value> = commission_rows
        .iter()
        .map(|row| {
            let key = string_cell(row, "idempotency_key");
            let key: String = key.chars().take(SOURCE_TRANSACTION_ID_MAX_CHARS).collect();
            json!({
                "id": string_cell(row, "id"),
                "createdAt": i64_cell(row, "created_at"),
                "referredUser": {
                    "id": i32_cell(row, "referred_user_id"),
                    "username": opt_string(row, "referred_username"),
                    "emailMasked": mask_email(opt_string(row, "referred_email").as_deref())
                },
                "depositAmountUsdc": f64_cell(row, "base_amount_usdc"),
                "commissionRate": f64_cell(row, "commission_percent") / PERCENT_TO_RATE,
                "commissionAmountUsdc": f64_cell(row, "commission_usdc"),
                "sourceType": opt_string(row, "source_type").unwrap_or_else(|| "deposit".into()),
                "sourceTransactionId": key,
                "status": "paid"
            })
        })
        .collect();

    let total_referred_deposits: f64 = referred_users
        .iter()
        .filter_map(|u| u.get("totalDepositedUsdc").and_then(|v| v.as_f64()))
        .sum();
    let total_commission: f64 = referred_users
        .iter()
        .filter_map(|u| u.get("totalCommissionUsdc").and_then(|v| v.as_f64()))
        .sum();
    let commissions_count: f64 = referred_users
        .iter()
        .filter_map(|u| {
            u.get("commissionsCount")
                .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        })
        .sum();

    Ok(json!({
        "referralCode": referral_code,
        "inviteUrl": invite_url,
        "referredBy": referred_by,
        "stats": {
            "invitedCount": referred_users.len(),
            "totalReferredDepositsUsdc": total_referred_deposits,
            "totalCommissionUsdc": total_commission,
            "paidCommissionUsdc": total_commission,
            "pendingCommissionUsdc": 0,
            "commissionRate": f64::from(REFERRAL_DEPOSIT_COMMISSION_PERCENT) / PERCENT_TO_RATE,
            "commissionPercent": REFERRAL_DEPOSIT_COMMISSION_PERCENT,
            "commissionsCount": commissions_count
        },
        "referredUsers": referred_users,
        "commissions": commissions
    }))
}

fn meta_reason(reason: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("reason".into(), Value::String(reason.into()));
    m
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
