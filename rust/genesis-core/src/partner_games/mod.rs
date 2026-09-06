//! Partner Games (BlockMiner hub) — session config + heartbeat gate.
//! Pure domain; Node owns Redis / Kafka / HTTP.

use serde::{Deserialize, Serialize};

use crate::time::MS_PER_MINUTE;

/// Same-origin nginx proxy path into BlockMiner.
pub const EMBED_PATH: &str = "/bm/";
/// Public partner site (open in new tab).
pub const PUBLIC_URL: &str = "https://blockminer.space/";
/// Client heartbeat interval — 1 minute (i18n / product copy).
pub const HEARTBEAT_INTERVAL_MS: i64 = MS_PER_MINUTE as i64;
/// Kafka / analytics session kind.
pub const SESSION_KIND: &str = "blockminer";
/// Minutes credited per accepted heartbeat.
pub const CREDITED_MINUTES_PER_HEARTBEAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub embed_path: String,
    pub public_url: String,
    pub heartbeat_interval_ms: i64,
    pub session_kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDecision {
    pub accepted: bool,
    pub credited_minutes: u32,
    pub next_eligible_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionReason {
    Visit,
    Heartbeat,
    Stop,
}

impl SessionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Visit => "visit",
            Self::Heartbeat => "heartbeat",
            Self::Stop => "stop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub user_id: i64,
    pub reason: String,
    pub at_ms: i64,
    pub session_kind: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Canonical embed / public / heartbeat config for the hub.
pub fn session_config() -> SessionConfig {
    SessionConfig {
        embed_path: EMBED_PATH.to_string(),
        public_url: PUBLIC_URL.to_string(),
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        session_kind: SESSION_KIND.to_string(),
    }
}

/// Accept heartbeat when `last` is absent or `now - last >= HEARTBEAT_INTERVAL_MS`.
/// Credits one minute when accepted. `next_eligible_at_ms` is always the next
/// allowed tick: `now + interval` if accepted, else `last + interval`.
pub fn accept_heartbeat(last_accepted_ms: Option<i64>, now_ms: i64) -> HeartbeatDecision {
    let accepted = match last_accepted_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= HEARTBEAT_INTERVAL_MS,
    };
    if accepted {
        HeartbeatDecision {
            accepted: true,
            credited_minutes: CREDITED_MINUTES_PER_HEARTBEAT,
            next_eligible_at_ms: now_ms.saturating_add(HEARTBEAT_INTERVAL_MS),
        }
    } else {
        let last = last_accepted_ms.expect("rejected heartbeat requires last");
        HeartbeatDecision {
            accepted: false,
            credited_minutes: 0,
            next_eligible_at_ms: last.saturating_add(HEARTBEAT_INTERVAL_MS),
        }
    }
}

/// JSON-ready session event for Kafka (`genesis.partner_games.session`).
pub fn build_session_event(
    user_id: i64,
    reason: SessionReason,
    at_ms: i64,
    extra: serde_json::Map<String, serde_json::Value>,
) -> SessionEvent {
    SessionEvent {
        user_id,
        reason: reason.as_str().to_string(),
        at_ms,
        session_kind: SESSION_KIND.to_string(),
        extra,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_config_matches_constants() {
        let cfg = session_config();
        assert_eq!(cfg.embed_path, EMBED_PATH);
        assert_eq!(cfg.public_url, PUBLIC_URL);
        assert_eq!(cfg.heartbeat_interval_ms, HEARTBEAT_INTERVAL_MS);
        assert_eq!(cfg.session_kind, SESSION_KIND);
        assert_eq!(cfg.heartbeat_interval_ms, MS_PER_MINUTE as i64);
    }

    #[test]
    fn first_heartbeat_accepted() {
        let now = 1_700_000_000_000_i64;
        let d = accept_heartbeat(None, now);
        assert!(d.accepted);
        assert_eq!(d.credited_minutes, CREDITED_MINUTES_PER_HEARTBEAT);
        assert_eq!(d.next_eligible_at_ms, now + HEARTBEAT_INTERVAL_MS);
    }

    #[test]
    fn heartbeat_too_soon_rejected() {
        let last = 1_700_000_000_000_i64;
        let now = last + HEARTBEAT_INTERVAL_MS - 1;
        let d = accept_heartbeat(Some(last), now);
        assert!(!d.accepted);
        assert_eq!(d.credited_minutes, 0);
        assert_eq!(d.next_eligible_at_ms, last + HEARTBEAT_INTERVAL_MS);
    }

    #[test]
    fn heartbeat_at_interval_accepted() {
        let last = 1_700_000_000_000_i64;
        let now = last + HEARTBEAT_INTERVAL_MS;
        let d = accept_heartbeat(Some(last), now);
        assert!(d.accepted);
        assert_eq!(d.credited_minutes, 1);
        assert_eq!(d.next_eligible_at_ms, now + HEARTBEAT_INTERVAL_MS);
    }

    #[test]
    fn build_session_event_visit() {
        let ev = build_session_event(42, SessionReason::Visit, 99, Default::default());
        assert_eq!(ev.user_id, 42);
        assert_eq!(ev.reason, "visit");
        assert_eq!(ev.at_ms, 99);
        assert_eq!(ev.session_kind, SESSION_KIND);
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["userId"], 42);
        assert_eq!(v["reason"], "visit");
    }

    #[test]
    fn build_session_event_heartbeat_extra() {
        let mut extra = serde_json::Map::new();
        extra.insert("creditedMinutes".into(), json!(1));
        let ev = build_session_event(7, SessionReason::Heartbeat, 100, extra);
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["reason"], "heartbeat");
        assert_eq!(v["creditedMinutes"], 1);
        assert_eq!(v["sessionKind"], SESSION_KIND);
    }
}
