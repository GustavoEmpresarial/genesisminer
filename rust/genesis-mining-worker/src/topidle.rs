//! TopIdle vote webhook + player status — HMAC, idempotent prize, nextVoteAt.

use deadpool_postgres::{GenericClient, Pool, Transaction};
use genesis_core::time::MS_PER_SECOND;
use genesis_core::topidle::{
    parse_vote_notice, verify_signature_with_secrets, TopIdleNoticeError, TopIdleNoticeKind,
    TopIdleSigError,
    TOPIDLE_GAME_ID, TOPIDLE_HISTORY_LIMIT, TOPIDLE_VOTE_REWARD_HPS, TOPIDLE_VOTE_URL,
    TOPIDLE_WEBHOOK_TIMEOUT_MS, TOPIDLE_WORKER_STATUS_PATH, TOPIDLE_WORKER_WEBHOOK_PATH,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::error::SqlState;

use crate::player_reads::{
    f64_cell, now_ms, pg_user_id, PlayerReadError, HTTP_SERVICE_UNAVAILABLE,
};

pub const TOPIDLE_WEBHOOK_PATH: &str = TOPIDLE_WORKER_WEBHOOK_PATH;
pub const TOPIDLE_STATUS_PATH: &str = TOPIDLE_WORKER_STATUS_PATH;

const HTTP_UNAUTHORIZED: u16 = 401;
const _: () = assert!(HTTP_UNAUTHORIZED == 401);
const _: () = assert!(TOPIDLE_WEBHOOK_TIMEOUT_MS == 5_000);
const _: () = assert!(TOPIDLE_HISTORY_LIMIT == 50);
const _: () = assert!(MS_PER_SECOND == 1_000);

fn history_select_sql() -> String {
    format!(
        "SELECT event_id,
                COALESCE(
                  (EXTRACT(EPOCH FROM voted_at) * {MS_PER_SECOND})::bigint,
                  created_at
                ) AS voted_at_ms,
                (EXTRACT(EPOCH FROM next_vote_at) * {MS_PER_SECOND})::bigint AS next_vote_at_ms
           FROM topidle_vote_events
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT {TOPIDLE_HISTORY_LIMIT}"
    )
}

const ERR_INVALID_SIGNATURE: &str = "Invalid signature.";
const ERR_MISSING_TIMESTAMP: &str = "Missing timestamp.";
const ERR_STALE_TIMESTAMP: &str = "Timestamp too old.";
const ERR_SECRET_UNSET: &str = "Webhook secret not configured.";
const ERR_MALFORMED: &str = "Malformed payload.";
const ERR_GAME_MISMATCH: &str = "Unknown gameId.";
const ERR_MISSING_EVENT: &str = "Missing eventId.";
const ERR_MISSING_EMAIL: &str = "Missing email.";
const ERR_PLAYER_NOT_FOUND: &str = "Player not found.";
const CODE_UNAUTHORIZED: &str = "UNAUTHORIZED";
const CODE_UNAVAILABLE: &str = "UNAVAILABLE";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopIdleWebhookForward {
    pub raw_body: String,
    pub timestamp: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopIdleStatusRequest {
    pub user_id: i64,
}

fn now_unix_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(0))
        .unwrap_or(0)
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code() == Some(&SqlState::UNIQUE_VIOLATION)
}

fn map_sig(err: TopIdleSigError) -> PlayerReadError {
    match err {
        TopIdleSigError::Missing => PlayerReadError::bad(ERR_MISSING_TIMESTAMP),
        TopIdleSigError::Stale => PlayerReadError::bad(ERR_STALE_TIMESTAMP),
        TopIdleSigError::Invalid => {
            PlayerReadError::controlled(HTTP_UNAUTHORIZED, ERR_INVALID_SIGNATURE, CODE_UNAUTHORIZED)
        }
    }
}

fn map_notice(err: TopIdleNoticeError) -> PlayerReadError {
    match err {
        TopIdleNoticeError::Malformed => PlayerReadError::bad(ERR_MALFORMED),
        TopIdleNoticeError::GameMismatch => PlayerReadError::bad(ERR_GAME_MISMATCH),
        TopIdleNoticeError::MissingEventId => PlayerReadError::bad(ERR_MISSING_EVENT),
        TopIdleNoticeError::MissingEmail => PlayerReadError::bad(ERR_MISSING_EMAIL),
    }
}

fn parse_vote_timestamptz(raw: &Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
    let s = raw.as_deref()?.trim();
    if s.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

async fn lookup_user_id(
    client: &impl GenericClient,
    email: &str,
) -> Result<Option<i32>, PlayerReadError> {
    let row = client
        .query_opt(
            "SELECT id FROM users WHERE lower(btrim(email)) = $1 LIMIT 1",
            &[&email],
        )
        .await?;
    Ok(row.map(|r| r.get::<_, i32>("id")))
}

async fn grant_vote_hps(tx: &Transaction<'_>, uid: i32, now: i64) -> Result<f64, PlayerReadError> {
    tx.execute(
        "INSERT INTO game_states (
           user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
           last_updated_at, server_updated_at, black_market_balance
         ) VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
         ON CONFLICT (user_id) DO NOTHING",
        &[&uid, &now],
    )
    .await?;
    let row = tx
        .query_opt(
            "UPDATE game_states
                SET checkin_bonus_hps = COALESCE(checkin_bonus_hps, 0) + $2,
                    server_updated_at = $3,
                    last_updated_at = $3
              WHERE user_id = $1
          RETURNING checkin_bonus_hps::double precision AS checkin_bonus_hps",
            &[&uid, &TOPIDLE_VOTE_REWARD_HPS, &now],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::internal(
            "game_states missing after insert",
        ));
    };
    Ok(f64_cell(&row, "checkin_bonus_hps").max(0.0))
}

pub async fn run_topidle_webhook(
    pool: &Pool,
    secret: Option<&str>,
    secret_alt: Option<&str>,
    raw_body: &str,
    timestamp: &str,
    signature: &str,
) -> Result<Value, PlayerReadError> {
    let mut secrets: Vec<&str> = Vec::new();
    if let Some(s) = secret.map(str::trim).filter(|s| !s.is_empty()) {
        secrets.push(s);
    }
    if let Some(s) = secret_alt.map(str::trim).filter(|s| !s.is_empty()) {
        if !secrets.iter().any(|have| *have == s) {
            secrets.push(s);
        }
    }
    if secrets.is_empty() {
        return Err(PlayerReadError::controlled(
            HTTP_SERVICE_UNAVAILABLE,
            ERR_SECRET_UNSET,
            CODE_UNAVAILABLE,
        ));
    }
    verify_signature_with_secrets(
        &secrets,
        timestamp,
        signature,
        raw_body,
        now_unix_seconds(),
    )
    .map_err(map_sig)?;
    let notice = parse_vote_notice(raw_body).map_err(map_notice)?;
    if notice.kind == TopIdleNoticeKind::VoteTest {
        return Ok(json!({
            "test": true,
            "gameId": TOPIDLE_GAME_ID,
        }));
    }

    let mut conn = pool.get().await?;
    let Some(uid) = lookup_user_id(&conn, &notice.email).await? else {
        return Err(PlayerReadError::not_found(ERR_PLAYER_NOT_FOUND));
    };

    let tx = conn.transaction().await?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = {TOPIDLE_WEBHOOK_TIMEOUT_MS}; SET LOCAL lock_timeout = {TOPIDLE_WEBHOOK_TIMEOUT_MS}"
    ))
    .await?;

    let voted_at = parse_vote_timestamptz(&notice.voted_at);
    let next_vote_at = parse_vote_timestamptz(&notice.next_vote_at);
    let now = now_ms();
    match tx
        .execute(
            "INSERT INTO topidle_vote_events (event_id, user_id, voted_at, next_vote_at, created_at)
             VALUES ($1, $2, $3, $4, $5)",
            &[
                &notice.event_id,
                &uid,
                &voted_at,
                &next_vote_at,
                &now,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            return Ok(json!({
                "duplicate": true,
                "eventId": notice.event_id,
            }));
        }
        Err(e) => return Err(e.into()),
    }

    let checkin_bonus_hps = grant_vote_hps(&tx, uid, now).await?;
    tx.commit().await?;
    Ok(json!({
        "credited": true,
        "eventId": notice.event_id,
        "hpsGranted": TOPIDLE_VOTE_REWARD_HPS,
        "checkinBonusHps": checkin_bonus_hps,
    }))
}

pub async fn run_topidle_status(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let conn = pool.get().await?;
    let count_row = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM topidle_vote_events WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let vote_count: i64 = count_row.get("n");
    let rows = conn.query(&history_select_sql(), &[&uid]).await?;
    let next_vote_at_ms: Option<i64> = rows
        .first()
        .and_then(|r| r.get::<_, Option<i64>>("next_vote_at_ms"));
    let now = now_ms();
    let can_vote_now = match next_vote_at_ms {
        None => true,
        Some(ms) => ms <= now,
    };
    let history: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "eventId": r.get::<_, String>("event_id"),
                "votedAtMs": r.get::<_, i64>("voted_at_ms"),
                "hpsGranted": TOPIDLE_VOTE_REWARD_HPS,
            })
        })
        .collect();
    let total_hps = (vote_count as f64) * TOPIDLE_VOTE_REWARD_HPS;
    Ok(json!({
        "voteUrl": TOPIDLE_VOTE_URL,
        "gameId": TOPIDLE_GAME_ID,
        "nextVoteAtMs": next_vote_at_ms,
        "canVoteNow": can_vote_now,
        "voteCount": vote_count,
        "totalHps": total_hps,
        "history": history,
    }))
}

#[cfg(test)]
mod tests {
    use super::{history_select_sql, parse_vote_timestamptz};
    use genesis_core::time::MS_PER_SECOND;
    use genesis_core::topidle::TOPIDLE_HISTORY_LIMIT;

    #[test]
    fn parses_rfc3339_zulu() {
        let raw = Some("2026-09-01T14:32:07Z".to_string());
        let dt = parse_vote_timestamptz(&raw).expect("rfc3339");
        assert_eq!(dt.format("%Y-%m-%dT%H:%M:%SZ").to_string(), "2026-09-01T14:32:07Z");
    }

    #[test]
    fn empty_or_junk_is_null() {
        assert!(parse_vote_timestamptz(&None).is_none());
        assert!(parse_vote_timestamptz(&Some(String::new())).is_none());
        assert!(parse_vote_timestamptz(&Some("not-a-date".to_string())).is_none());
    }

    #[test]
    fn history_sql_binds_only_user_id() {
        let sql = history_select_sql();
        assert!(sql.contains(&format!("* {MS_PER_SECOND})")));
        assert!(sql.contains(&format!("LIMIT {TOPIDLE_HISTORY_LIMIT}")));
        assert!(!sql.contains("$2"));
        assert!(!sql.contains("$3"));
    }
}
