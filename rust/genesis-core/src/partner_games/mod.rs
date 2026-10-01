//! Partner Games — multi-game catalog + heartbeat gate.
//! Pure domain; mining-worker owns Redis / Kafka / HTTP.

use serde::{Deserialize, Serialize};

use crate::time::MS_PER_MINUTE;

/// Client heartbeat interval — 1 minute (i18n / product copy).
pub const HEARTBEAT_INTERVAL_MS: i64 = MS_PER_MINUTE as i64;
/// Minutes credited per accepted heartbeat.
pub const CREDITED_MINUTES_PER_HEARTBEAT: u32 = 1;

/// Hub section: official Genesis titles.
pub const SECTION_OFFICIAL: &str = "official";
/// Hub section: third-party partner titles.
pub const SECTION_PARTNER: &str = "partner";

// --- BlockMiner ---
pub const BLOCKMINER_SLUG: &str = "blockminer";
pub const BLOCKMINER_NAME: &str = "BlockMiner";
pub const BLOCKMINER_PUBLIC_URL: &str = "https://blockminer.space/";
/// Same-origin nginx proxy path into BlockMiner.
pub const BLOCKMINER_EMBED_PATH: &str = "/bm/";
pub const BLOCKMINER_IMAGE_URL: &str = "/img/partner/blockminer.webp";
pub const BLOCKMINER_SESSION_KIND: &str = "blockminer";

// --- Master Legends ---
pub const MASTER_LEGENDS_SLUG: &str = "master-legends";
pub const MASTER_LEGENDS_NAME: &str = "Master Legends";
pub const MASTER_LEGENDS_PUBLIC_URL: &str = "https://masterlegends.online/";
/// Same-origin nginx proxy path into Master Legends (like `/bm/`).
pub const MASTER_LEGENDS_EMBED_PATH: &str = "/ml/?v=16";
pub const MASTER_LEGENDS_SESSION_KIND: &str = "master-legends";

/// @deprecated Prefer per-game constants (`BLOCKMINER_*`). Kept for any residual callers.
pub const EMBED_PATH: &str = BLOCKMINER_EMBED_PATH;
/// @deprecated Prefer `BLOCKMINER_PUBLIC_URL`.
pub const PUBLIC_URL: &str = BLOCKMINER_PUBLIC_URL;
/// @deprecated Prefer `BLOCKMINER_SESSION_KIND`.
pub const SESSION_KIND: &str = BLOCKMINER_SESSION_KIND;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerGame {
    pub slug: String,
    pub name: String,
    pub public_url: String,
    pub embed_path: Option<String>,
    pub image_url: Option<String>,
    pub session_kind: String,
    /// Hub section: `"official"` | `"partner"`.
    pub section: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogConfig {
    pub heartbeat_interval_ms: i64,
    pub games: Vec<PartnerGame>,
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

fn master_legends_game() -> PartnerGame {
    PartnerGame {
        slug: MASTER_LEGENDS_SLUG.to_string(),
        name: MASTER_LEGENDS_NAME.to_string(),
        public_url: MASTER_LEGENDS_PUBLIC_URL.to_string(),
        embed_path: Some(MASTER_LEGENDS_EMBED_PATH.to_string()),
        image_url: None,
        session_kind: MASTER_LEGENDS_SESSION_KIND.to_string(),
        section: SECTION_OFFICIAL.to_string(),
    }
}

fn blockminer_game() -> PartnerGame {
    PartnerGame {
        slug: BLOCKMINER_SLUG.to_string(),
        name: BLOCKMINER_NAME.to_string(),
        public_url: BLOCKMINER_PUBLIC_URL.to_string(),
        embed_path: Some(BLOCKMINER_EMBED_PATH.to_string()),
        image_url: Some(BLOCKMINER_IMAGE_URL.to_string()),
        session_kind: BLOCKMINER_SESSION_KIND.to_string(),
        section: SECTION_PARTNER.to_string(),
    }
}

/// Canonical multi-game catalog for the Partner · Games hub.
/// Order: official first, then partner.
pub fn catalog() -> CatalogConfig {
    CatalogConfig {
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        games: vec![master_legends_game(), blockminer_game()],
    }
}

/// Lookup a catalog entry by slug (exact match).
pub fn game_by_slug(slug: &str) -> Option<PartnerGame> {
    let needle = slug.trim();
    if needle.is_empty() {
        return None;
    }
    catalog().games.into_iter().find(|g| g.slug == needle)
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
    session_kind: &str,
    extra: serde_json::Map<String, serde_json::Value>,
) -> SessionEvent {
    SessionEvent {
        user_id,
        reason: reason.as_str().to_string(),
        at_ms,
        session_kind: session_kind.to_string(),
        extra,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_has_two_games() {
        let cfg = catalog();
        assert_eq!(cfg.heartbeat_interval_ms, HEARTBEAT_INTERVAL_MS);
        assert_eq!(cfg.heartbeat_interval_ms, MS_PER_MINUTE as i64);
        assert_eq!(cfg.games.len(), 2);
        assert_eq!(cfg.games[0].slug, MASTER_LEGENDS_SLUG);
        assert_eq!(cfg.games[0].section, SECTION_OFFICIAL);
        assert_eq!(
            cfg.games[0].embed_path.as_deref(),
            Some(MASTER_LEGENDS_EMBED_PATH)
        );
        assert!(cfg.games[0].image_url.is_none());
        assert_eq!(cfg.games[0].public_url, MASTER_LEGENDS_PUBLIC_URL);
        assert_eq!(cfg.games[1].slug, BLOCKMINER_SLUG);
        assert_eq!(cfg.games[1].section, SECTION_PARTNER);
        assert_eq!(
            cfg.games[1].embed_path.as_deref(),
            Some(BLOCKMINER_EMBED_PATH)
        );
        assert_eq!(
            cfg.games[1].image_url.as_deref(),
            Some(BLOCKMINER_IMAGE_URL)
        );
    }

    #[test]
    fn game_by_slug_lookup() {
        let bm = game_by_slug("blockminer").expect("blockminer");
        assert_eq!(bm.session_kind, BLOCKMINER_SESSION_KIND);
        assert_eq!(bm.section, SECTION_PARTNER);
        let ml = game_by_slug("master-legends").expect("master-legends");
        assert_eq!(ml.session_kind, MASTER_LEGENDS_SESSION_KIND);
        assert_eq!(ml.section, SECTION_OFFICIAL);
        assert_eq!(ml.embed_path.as_deref(), Some(MASTER_LEGENDS_EMBED_PATH));
        assert!(game_by_slug("unknown").is_none());
        assert!(game_by_slug("").is_none());
        assert!(game_by_slug("  ").is_none());
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
    fn build_session_event_uses_session_kind() {
        let ev = build_session_event(
            42,
            SessionReason::Visit,
            99,
            MASTER_LEGENDS_SESSION_KIND,
            Default::default(),
        );
        assert_eq!(ev.user_id, 42);
        assert_eq!(ev.reason, "visit");
        assert_eq!(ev.at_ms, 99);
        assert_eq!(ev.session_kind, MASTER_LEGENDS_SESSION_KIND);
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["userId"], 42);
        assert_eq!(v["sessionKind"], MASTER_LEGENDS_SESSION_KIND);
    }

    #[test]
    fn build_session_event_heartbeat_extra() {
        let mut extra = serde_json::Map::new();
        extra.insert("creditedMinutes".into(), json!(1));
        let ev = build_session_event(7, SessionReason::Heartbeat, 100, BLOCKMINER_SESSION_KIND, extra);
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["reason"], "heartbeat");
        assert_eq!(v["creditedMinutes"], 1);
        assert_eq!(v["sessionKind"], BLOCKMINER_SESSION_KIND);
    }
}
