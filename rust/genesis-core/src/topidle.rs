//! TopIdle vote webhook contract — HMAC, event types, prize trigger.
//!
//! Spec: https://topidle.com/integracao.html
//! HMAC-SHA256 of `{timestamp}.{rawBody}` (exact bytes). Header
//! `X-TopIdle-Signature: sha256=<hex>`. Timestamp skew = 5 minutes.

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

use crate::auth::timing_safe_token_hash_equal;
use crate::time::{MS_PER_SECOND, SECONDS_PER_MINUTE};

type HmacSha256 = Hmac<Sha256>;

/// TopIdle listing slug (painel + URL de voto).
pub const TOPIDLE_GAME_ID: &str = "genesis-miner-cea25b";
/// In-game button target (`?votar=1` abre o fluxo de voto).
pub const TOPIDLE_VOTE_URL: &str = "https://topidle.com/jogo/genesis-miner-cea25b?votar=1";

/// Public HTTPS path on genesis-api (TopIdle panel).
pub const TOPIDLE_PUBLIC_WEBHOOK_PATH: &str = "/api/webhooks/topidle";
/// Authenticated player status (nextVoteAt).
pub const TOPIDLE_PUBLIC_STATUS_PATH: &str = "/api/topidle/status";
/// genesis-api → mining-worker.
pub const TOPIDLE_WORKER_WEBHOOK_PATH: &str = "/v1/topidle/webhook";
pub const TOPIDLE_WORKER_STATUS_PATH: &str = "/v1/topidle/status";

/// Signature header prefix from TopIdle examples.
pub const TOPIDLE_SIGNATURE_PREFIX: &str = "sha256=";
/// Header names (HTTP is case-insensitive; listed as sent by TopIdle).
pub const TOPIDLE_HEADER_SIGNATURE: &str = "x-topidle-signature";
pub const TOPIDLE_HEADER_TIMESTAMP: &str = "x-topidle-timestamp";

/// `|now - timestamp|` max (TopIdle examples: 300s).
pub const TOPIDLE_TIMESTAMP_SKEW_SECONDS: i64 = (5 * SECONDS_PER_MINUTE) as i64;
/// Respond within this wall time (TopIdle: 5s). PG `statement_timeout` uses the same value.
pub const TOPIDLE_WEBHOOK_TIMEOUT_SECONDS: u64 = 5;
pub const TOPIDLE_WEBHOOK_TIMEOUT_MS: u64 = TOPIDLE_WEBHOOK_TIMEOUT_SECONDS * MS_PER_SECOND;

pub const TOPIDLE_EVENT_VOTE_CREATED: &str = "vote.created";
pub const TOPIDLE_EVENT_VOTE_TEST: &str = "vote.test";

/// Hashrate credited to `game_states.checkin_bonus_hps` on each paid vote.
pub const TOPIDLE_VOTE_REWARD_HPS: f64 = 1.0;
/// In-game Hub tab + `/topidle`.
pub const TOPIDLE_NAV_ENABLED: bool = true;
/// Credited-vote rows on GET status — same cap as wallet `HISTORY_MAX_LIMIT`.
pub const TOPIDLE_HISTORY_LIMIT: i64 = 50;

const _: () = assert!(TOPIDLE_TIMESTAMP_SKEW_SECONDS == 300);
const _: () = assert!(TOPIDLE_WEBHOOK_TIMEOUT_MS == 5_000);
const _: () = assert!(TOPIDLE_VOTE_REWARD_HPS == 1.0);
const _: () = assert!(TOPIDLE_HISTORY_LIMIT == 50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopIdleSigError {
    Missing,
    Stale,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopIdleNoticeKind {
    VoteCreated,
    VoteTest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopIdleVoteNotice {
    pub kind: TopIdleNoticeKind,
    pub event_id: String,
    pub game_id: String,
    pub email: String,
    pub voted_at: Option<String>,
    pub next_vote_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopIdleNoticeError {
    Malformed,
    GameMismatch,
    MissingEventId,
    MissingEmail,
}

#[derive(Debug, Deserialize)]
struct RawNotice {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "eventId")]
    event_id: Option<String>,
    #[serde(rename = "gameId")]
    game_id: Option<String>,
    email: Option<String>,
    #[serde(rename = "votedAt")]
    voted_at: Option<String>,
    #[serde(rename = "nextVoteAt")]
    next_vote_at: Option<String>,
}

fn opt_trim(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// HMAC-SHA256 hex with `sha256=` prefix (what TopIdle sends / Postman signs).
pub fn sign_body(secret: &str, timestamp: i64, raw_body: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    let msg = format!("{timestamp}.{raw_body}");
    mac.update(msg.as_bytes());
    format!(
        "{TOPIDLE_SIGNATURE_PREFIX}{}",
        hex::encode(mac.finalize().into_bytes())
    )
}

/// Verify `X-TopIdle-Signature` against `{timestamp}.{rawBody}`. Returns the parsed timestamp.
pub fn verify_signature(
    secret: &str,
    timestamp_header: &str,
    signature_header: &str,
    raw_body: &str,
    now_unix: i64,
) -> Result<i64, TopIdleSigError> {
    let ts_raw = timestamp_header.trim();
    if ts_raw.is_empty() {
        return Err(TopIdleSigError::Missing);
    }
    let ts: i64 = ts_raw.parse().map_err(|_| TopIdleSigError::Invalid)?;
    let skew = now_unix.abs_diff(ts);
    if skew > TOPIDLE_TIMESTAMP_SKEW_SECONDS as u64 {
        return Err(TopIdleSigError::Stale);
    }
    let sig = signature_header.trim();
    let Some(hex_sig) = sig.strip_prefix(TOPIDLE_SIGNATURE_PREFIX) else {
        return Err(TopIdleSigError::Invalid);
    };
    let expected = sign_body(secret, ts, raw_body);
    let Some(expected_hex) = expected.strip_prefix(TOPIDLE_SIGNATURE_PREFIX) else {
        return Err(TopIdleSigError::Invalid);
    };
    if !timing_safe_token_hash_equal(hex_sig, expected_hex) {
        return Err(TopIdleSigError::Invalid);
    }
    Ok(ts)
}

/// Try each non-empty secret. Missing/stale timestamp fails without trying the rest.
pub fn verify_signature_with_secrets(
    secrets: &[&str],
    timestamp_header: &str,
    signature_header: &str,
    raw_body: &str,
    now_unix: i64,
) -> Result<i64, TopIdleSigError> {
    let mut last = TopIdleSigError::Invalid;
    let mut any = false;
    for secret in secrets {
        let secret = secret.trim();
        if secret.is_empty() {
            continue;
        }
        any = true;
        match verify_signature(
            secret,
            timestamp_header,
            signature_header,
            raw_body,
            now_unix,
        ) {
            Ok(ts) => return Ok(ts),
            Err(TopIdleSigError::Missing) => return Err(TopIdleSigError::Missing),
            Err(TopIdleSigError::Stale) => return Err(TopIdleSigError::Stale),
            Err(err) => last = err,
        }
    }
    if !any {
        return Err(TopIdleSigError::Invalid);
    }
    Err(last)
}

pub fn parse_vote_notice(raw_body: &str) -> Result<TopIdleVoteNotice, TopIdleNoticeError> {
    let raw: RawNotice =
        serde_json::from_str(raw_body).map_err(|_| TopIdleNoticeError::Malformed)?;
    let kind_s = raw.kind.as_deref().map(str::trim).unwrap_or("");
    let kind = match kind_s {
        TOPIDLE_EVENT_VOTE_CREATED => TopIdleNoticeKind::VoteCreated,
        TOPIDLE_EVENT_VOTE_TEST => TopIdleNoticeKind::VoteTest,
        _ => return Err(TopIdleNoticeError::Malformed),
    };
    let event_id = opt_trim(raw.event_id).ok_or(TopIdleNoticeError::MissingEventId)?;
    let game_id = opt_trim(raw.game_id).ok_or(TopIdleNoticeError::Malformed)?;
    if game_id != TOPIDLE_GAME_ID {
        return Err(TopIdleNoticeError::GameMismatch);
    }
    let email = raw.email.unwrap_or_default().trim().to_lowercase();
    if kind == TopIdleNoticeKind::VoteCreated && email.is_empty() {
        return Err(TopIdleNoticeError::MissingEmail);
    }
    Ok(TopIdleVoteNotice {
        kind,
        event_id,
        game_id,
        email,
        voted_at: opt_trim(raw.voted_at),
        next_vote_at: opt_trim(raw.next_vote_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "topidle-test-secret";
    const TS: i64 = 1_700_000_000;
    const BODY: &str = r#"{"type":"vote.created","eventId":"evt-1","gameId":"genesis-miner-cea25b","email":"Ada@Gmail.com","votedAt":"2026-01-01T00:00:00Z","nextVoteAt":"2026-01-02T00:00:00Z"}"#;

    #[test]
    fn sign_and_verify_roundtrip() {
        let sig = sign_body(SECRET, TS, BODY);
        assert!(sig.starts_with(TOPIDLE_SIGNATURE_PREFIX));
        assert_eq!(
            verify_signature(SECRET, &TS.to_string(), &sig, BODY, TS).unwrap(),
            TS
        );
    }

    #[test]
    fn reject_bad_signature() {
        let sig = sign_body(SECRET, TS, BODY);
        assert_eq!(
            verify_signature("other-secret", &TS.to_string(), &sig, BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
        assert_eq!(
            verify_signature(SECRET, &TS.to_string(), "sha256=deadbeef", BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
        assert_eq!(
            verify_signature(SECRET, &TS.to_string(), "not-a-sig", BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
    }

    #[test]
    fn reject_stale_and_missing_timestamp() {
        let sig = sign_body(SECRET, TS, BODY);
        let now = TS + TOPIDLE_TIMESTAMP_SKEW_SECONDS + 1;
        assert_eq!(
            verify_signature(SECRET, &TS.to_string(), &sig, BODY, now),
            Err(TopIdleSigError::Stale)
        );
        assert_eq!(
            verify_signature(SECRET, "", &sig, BODY, TS),
            Err(TopIdleSigError::Missing)
        );
        assert_eq!(
            verify_signature(SECRET, "nope", &sig, BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
    }

    #[test]
    fn raw_body_must_not_be_reserialized() {
        let sig = sign_body(SECRET, TS, BODY);
        let pretty =
            serde_json::to_string_pretty(&serde_json::from_str::<serde_json::Value>(BODY).unwrap())
                .unwrap();
        assert_eq!(
            verify_signature(SECRET, &TS.to_string(), &sig, &pretty, TS),
            Err(TopIdleSigError::Invalid)
        );
    }

    #[test]
    fn parse_created_normalizes_email() {
        let n = parse_vote_notice(BODY).unwrap();
        assert_eq!(n.kind, TopIdleNoticeKind::VoteCreated);
        assert_eq!(n.event_id, "evt-1");
        assert_eq!(n.email, "ada@gmail.com");
        assert_eq!(n.next_vote_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    #[test]
    fn parse_test_does_not_require_email() {
        let body = r#"{"type":"vote.test","eventId":"evt-test","gameId":"genesis-miner-cea25b"}"#;
        let n = parse_vote_notice(body).unwrap();
        assert_eq!(n.kind, TopIdleNoticeKind::VoteTest);
        assert!(n.email.is_empty());
    }

    #[test]
    fn parse_rejects_wrong_game_and_missing_email() {
        let bad_game = r#"{"type":"vote.created","eventId":"e","gameId":"other","email":"a@b.c"}"#;
        assert_eq!(
            parse_vote_notice(bad_game),
            Err(TopIdleNoticeError::GameMismatch)
        );
        let no_email = r#"{"type":"vote.created","eventId":"e","gameId":"genesis-miner-cea25b"}"#;
        assert_eq!(
            parse_vote_notice(no_email),
            Err(TopIdleNoticeError::MissingEmail)
        );
        assert!(parse_vote_notice("{").is_err());
    }

    #[test]
    fn verify_accepts_any_matching_secret() {
        let alt = "topidle-alt-secret";
        let sig = sign_body(alt, TS, BODY);
        assert_eq!(
            verify_signature_with_secrets(&[SECRET, alt], &TS.to_string(), &sig, BODY, TS).unwrap(),
            TS
        );
        assert_eq!(
            verify_signature_with_secrets(&[SECRET], &TS.to_string(), &sig, BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
        assert_eq!(
            verify_signature_with_secrets(&[], &TS.to_string(), &sig, BODY, TS),
            Err(TopIdleSigError::Invalid)
        );
    }

    #[test]
    fn vote_reward_is_one_hps() {
        assert_eq!(TOPIDLE_VOTE_REWARD_HPS, 1.0);
        assert!(TOPIDLE_NAV_ENABLED);
        assert_eq!(TOPIDLE_HISTORY_LIMIT, 50);
        assert!(TOPIDLE_VOTE_URL.contains(TOPIDLE_GAME_ID));
        assert!(TOPIDLE_VOTE_URL.contains("votar=1"));
    }
}
