//! ZERads offerwall credit — ledger + `game_states.usdc` in one TX.
//!
//! Mirrors Node `creditZeradsCallback` (idempotent via `zerads_earnings_ledger.idempotency_key`,
//! 60‑min bucket). IP / password / token gates stay in Node.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::checkin::{utc_checkin_period_start_ms, utc_day_from_ms};
use genesis_core::time::MS_PER_MINUTE;
use genesis_core::utc_week::utc_week_start_ms;
use serde::Serialize;
use sha1::{Digest, Sha1};
use tokio_postgres::error::SqlState;
use tracing::warn;

use crate::config::{current_unix_ms, WALLET_LOCK_TIMEOUT_MS};
use crate::errors::WalletError;
use crate::pg_types::pg_user_id;
use crate::util::assert_active_user;

/// Node `IDEMPOTENCY_BUCKET_MINUTES`.
const IDEMPOTENCY_BUCKET_MINUTES: u64 = 60;
/// Node `ZERADS_IDEMPOTENCY_BUCKET_MS`.
const ZERADS_IDEMPOTENCY_BUCKET_MS: i64 = (IDEMPOTENCY_BUCKET_MINUTES * MS_PER_MINUTE) as i64;
/// Node `DEFAULT_ZER_TO_USDC_RATE`.
const DEFAULT_ZER_TO_USDC_RATE: f64 = 0.013;
/// Node `DEFAULT_USER_SPLIT`.
const DEFAULT_USER_SPLIT: f64 = 0.8;
/// Node `DEFAULT_MAX_AMOUNT_ZER`.
const DEFAULT_MAX_AMOUNT_ZER: f64 = 1000.0;
/// Node `IDEMPOTENCY_SIG_HEX_LENGTH`.
const IDEMPOTENCY_SIG_HEX_LENGTH: usize = 16;
/// Node `AMOUNT_DECIMALS_FOR_SIG`.
const AMOUNT_DECIMALS_FOR_SIG: usize = 8;
/// Postgres unique_violation (Node Prisma `P2002`).
const PG_UNIQUE_VIOLATION: &str = "23505";
/// Split clamp bounds (Node `Math.min(1, Math.max(0, …))`).
const USER_SPLIT_MIN: f64 = 0.0;
const USER_SPLIT_MAX: f64 = 1.0;

const _: () = assert!(IDEMPOTENCY_BUCKET_MINUTES == 60);
const _: () = assert!(ZERADS_IDEMPOTENCY_BUCKET_MS == 3_600_000);
const _: () = assert!(AMOUNT_DECIMALS_FOR_SIG == 8);
const _: () = assert!(IDEMPOTENCY_SIG_HEX_LENGTH == 16);

pub const ZERADS_CREDIT_PATH: &str = "/v1/wallet/offerwall/zerads-credit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZeradsCreditOk {
    pub ok: bool,
    pub duplicate: bool,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_split: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_usdc: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_usdc: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
struct ZeradsSplit {
    rate: f64,
    user_split: f64,
    total_usdc: f64,
    user_usdc: f64,
    platform_usdc: f64,
}

enum CreditOutcome {
    Fresh(ZeradsCreditOk),
    Duplicate { idempotency_key: String },
}

fn read_env_float(key: &str, fallback: f64) -> f64 {
    match std::env::var(key) {
        Ok(raw) => match raw.trim().parse::<f64>() {
            Ok(v) if v.is_finite() && v > 0.0 => v,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

fn read_max_amount_zer() -> f64 {
    read_env_float("ZERADS_MAX_AMOUNT_ZER", DEFAULT_MAX_AMOUNT_ZER)
}

fn compute_zerads_split(amount_zer: f64) -> ZeradsSplit {
    let rate = read_env_float("ZERADS_ZER_TO_USDC", DEFAULT_ZER_TO_USDC_RATE);
    let user_split = read_env_float("ZERADS_USER_SPLIT", DEFAULT_USER_SPLIT)
        .clamp(USER_SPLIT_MIN, USER_SPLIT_MAX);
    let total_usdc = amount_zer * rate;
    let user_usdc = total_usdc * user_split;
    let platform_usdc = total_usdc - user_usdc;
    ZeradsSplit {
        rate,
        user_split,
        total_usdc,
        user_usdc,
        platform_usdc,
    }
}

/// Node `buildZeradsIdempotencyKey` — SHA1 hex prefix of `toFixed(8)|clicks`.
pub fn build_zerads_idempotency_key(
    user_id: i64,
    amount_zer: f64,
    clicks: i32,
    now_ms: i64,
) -> String {
    let bucket = now_ms.div_euclid(ZERADS_IDEMPOTENCY_BUCKET_MS);
    let amount_sig = format!("{amount_zer:.AMOUNT_DECIMALS_FOR_SIG$}");
    let mut hasher = Sha1::new();
    hasher.update(format!("{amount_sig}|{clicks}").as_bytes());
    let hex = hex::encode(hasher.finalize());
    let sig = &hex[..IDEMPOTENCY_SIG_HEX_LENGTH.min(hex.len())];
    format!("{user_id}:{bucket}:{sig}")
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code() == Some(&SqlState::UNIQUE_VIOLATION)
        || err
            .code()
            .map(|c| c.code() == PG_UNIQUE_VIOLATION)
            .unwrap_or(false)
}

pub async fn run_zerads_credit(
    pool: &Pool,
    user_id: i64,
    amount_zer: f64,
    clicks: i32,
    server_now_ms: Option<i64>,
) -> Result<ZeradsCreditOk, WalletError> {
    if user_id <= 0 {
        return Err(WalletError::unauthorized("Sessão necessária."));
    }
    let max_zer = read_max_amount_zer();
    if !(amount_zer.is_finite() && amount_zer >= 0.0 && amount_zer <= max_zer) {
        return Err(WalletError::bad(format!(
            "ZERads: amountZer fora do limite (max={max_zer})"
        )));
    }
    if clicks < 0 {
        return Err(WalletError::bad("ZERads: clicks inválido"));
    }

    let now_ms = server_now_ms.unwrap_or_else(current_unix_ms);
    let idempotency_key = build_zerads_idempotency_key(user_id, amount_zer, clicks, now_ms);
    let split = compute_zerads_split(amount_zer);
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;

    let mut client = pool.get().await.map_err(WalletError::transport)?;
    let tx = client.transaction().await.map_err(WalletError::transport)?;

    let outcome = match run_inner(
        &tx,
        uid,
        user_id,
        amount_zer,
        clicks,
        now_ms,
        &idempotency_key,
        &split,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };

    match outcome {
        CreditOutcome::Fresh(out) => {
            tx.commit().await.map_err(WalletError::transport)?;
            // Node `bumpQuestProgress(userId, 'offerwall', 1)` — best-effort, own tx.
            bump_offerwall_quests(pool, uid, now_ms).await;
            Ok(out)
        }
        CreditOutcome::Duplicate { idempotency_key } => {
            let _ = tx.rollback().await;
            Ok(ZeradsCreditOk {
                ok: true,
                duplicate: true,
                idempotency_key,
                rate: None,
                user_split: None,
                total_usdc: None,
                user_usdc: None,
                platform_usdc: None,
            })
        }
    }
}

/// Advance every enabled `action_type = 'offerwall'` quest (daily + weekly) by 1,
/// capped at `target_count`. Best-effort in its own tx — never fails the credit.
async fn bump_offerwall_quests(pool: &Pool, uid: i32, now_ms: i64) {
    if let Err(e) = try_bump_offerwall_quests(pool, uid, now_ms).await {
        warn!(err = %e, uid, "offerwall quest bump (non-fatal)");
    }
}

async fn try_bump_offerwall_quests(pool: &Pool, uid: i32, now_ms: i64) -> anyhow::Result<()> {
    let daily_key = format!("d:{}", utc_day_from_ms(utc_checkin_period_start_ms(now_ms)));
    let weekly_key = format!("w:{}", utc_day_from_ms(utc_week_start_ms(now_ms)));
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let defs = tx
        .query(
            "SELECT id, period, target_count FROM quest_definitions
              WHERE action_type = 'offerwall' AND COALESCE(enabled, 1) <> 0",
            &[],
        )
        .await?;
    for d in &defs {
        let qid: String = d.get("id");
        let period: String = d.get("period");
        let target: i32 = d.get("target_count");
        let pk = if period == "weekly" { &weekly_key } else { &daily_key };
        tx.execute(
            "INSERT INTO user_quest_progress
                (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
             VALUES ($1, $2, $3, 0, NULL, NULL, $4)
             ON CONFLICT (user_id, quest_id, period_key) DO NOTHING",
            &[&uid, &qid, pk, &now_ms],
        )
        .await?;
        let row = tx
            .query_opt(
                "SELECT progress, completed_at, claimed_at FROM user_quest_progress
                  WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE",
                &[&uid, &qid, pk],
            )
            .await?;
        let Some(row) = row else { continue };
        if row.get::<_, Option<i64>>("claimed_at").is_some() {
            continue;
        }
        let cur: i32 = row.get::<_, Option<i32>>("progress").unwrap_or(0).max(0);
        let next = (cur + 1).min(target);
        let completed_at: Option<i64> = if next >= target {
            Some(row.get::<_, Option<i64>>("completed_at").unwrap_or(now_ms))
        } else {
            None
        };
        tx.execute(
            "UPDATE user_quest_progress SET progress = $4, completed_at = $5, updated_at = $6
              WHERE user_id = $1 AND quest_id = $2 AND period_key = $3",
            &[&uid, &qid, pk, &next, &completed_at, &now_ms],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    amount_zer: f64,
    clicks: i32,
    now_ms: i64,
    idempotency_key: &str,
    split: &ZeradsSplit,
) -> Result<CreditOutcome, WalletError> {
    client
        .execute(
            &format!("SET LOCAL lock_timeout = {WALLET_LOCK_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WalletError::transport)?;

    assert_active_user(client, user_id).await?;

    if split.user_usdc > 0.0 {
        let gs = client
            .query(
                "SELECT usdc FROM game_states WHERE user_id = $1 FOR UPDATE",
                &[&uid],
            )
            .await
            .map_err(WalletError::transport)?;
        if gs.is_empty() {
            return Err(WalletError::bad(
                "ZERads: game_states em falta para crédito USDC",
            ));
        }
    }

    match client
        .execute(
            "INSERT INTO zerads_earnings_ledger (
               idempotency_key, user_id, amount_zer, amount_usdc_total,
               user_amount_usdc, platform_amount_usdc, clicks, zer_to_usdc_rate, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            &[
                &idempotency_key,
                &uid,
                &amount_zer,
                &split.total_usdc,
                &split.user_usdc,
                &split.platform_usdc,
                &clicks,
                &split.rate,
                &now_ms,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            return Ok(CreditOutcome::Duplicate {
                idempotency_key: idempotency_key.to_string(),
            });
        }
        Err(e) => return Err(WalletError::transport(e)),
    }

    if split.user_usdc > 0.0 {
        let upd = client
            .execute(
                "UPDATE game_states SET usdc = COALESCE(usdc, 0) + $1 WHERE user_id = $2",
                &[&split.user_usdc, &uid],
            )
            .await
            .map_err(WalletError::transport)?;
        if upd == 0 {
            return Err(WalletError::bad(
                "ZERads: UPDATE game_states afetou 0 linhas",
            ));
        }
    }

    Ok(CreditOutcome::Fresh(ZeradsCreditOk {
        ok: true,
        duplicate: false,
        idempotency_key: idempotency_key.to_string(),
        rate: Some(split.rate),
        user_split: Some(split.user_split),
        total_usdc: Some(split.total_usdc),
        user_usdc: Some(split.user_usdc),
        platform_usdc: Some(split.platform_usdc),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_node() {
        assert_eq!(DEFAULT_ZER_TO_USDC_RATE, 0.013);
        assert_eq!(DEFAULT_USER_SPLIT, 0.8);
        assert_eq!(DEFAULT_MAX_AMOUNT_ZER, 1000.0);
        assert_eq!(ZERADS_IDEMPOTENCY_BUCKET_MS, 3_600_000);
    }

    #[test]
    fn idempotency_key_stable_in_bucket() {
        let t0 = 1_700_000_000_000_i64;
        let k1 = build_zerads_idempotency_key(1, 2.5, 10, t0);
        let k2 = build_zerads_idempotency_key(1, 2.5, 10, t0 + 1000);
        assert_eq!(k1, k2);
        let k3 = build_zerads_idempotency_key(1, 2.5, 10, t0 + ZERADS_IDEMPOTENCY_BUCKET_MS);
        assert_ne!(k3, k1);
    }

    #[test]
    fn idempotency_key_differs_on_amount() {
        let t0 = 1_700_000_000_000_i64;
        assert_ne!(
            build_zerads_idempotency_key(1, 2.5, 10, t0),
            build_zerads_idempotency_key(1, 3.5, 10, t0)
        );
    }

    #[test]
    fn split_defaults() {
        let s = compute_zerads_split(100.0);
        assert!((s.rate - 0.013).abs() < 1e-12);
        assert!((s.total_usdc - 1.3).abs() < 1e-12);
        assert!((s.user_usdc - 1.04).abs() < 1e-12);
        assert!((s.platform_usdc - 0.26).abs() < 1e-12);
    }
}
