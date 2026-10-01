//! Partner Games session I/O — Redis heartbeat + Kafka (multi-game by slug).

use genesis_core::partner_games::{
    accept_heartbeat, build_session_event, catalog, game_by_slug, PartnerGame, SessionReason,
    HEARTBEAT_INTERVAL_MS,
};
use genesis_core::time::MS_PER_SECOND;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::config::WorkerConfig;
use crate::kafka::SharedKafka;
use crate::player_reads::{pg_user_id, quests::bump_quest_action};
use crate::redis_lock::RedisLockClient;
use crate::users::{run_assert_active_user, AssertActiveError, AssertActiveRequest};

/// Node `bumpQuestProgress(userId, action, delta)` — best-effort, own tx.
async fn bump_partner_games_quest(
    pool: &deadpool_postgres::Pool,
    user_id: i64,
    action: &str,
    delta: i32,
    now_ms: i64,
) {
    let run = async {
        let uid = pg_user_id(user_id).map_err(|e| anyhow::anyhow!(e.error))?;
        let mut conn = pool.get().await?;
        let tx = conn.transaction().await?;
        bump_quest_action(&tx, uid, now_ms, action, delta)
            .await
            .map_err(|e| anyhow::anyhow!(e.error))?;
        tx.commit().await?;
        Ok::<(), anyhow::Error>(())
    };
    if let Err(e) = run.await {
        warn!(err = %e, user_id, action, "partner-games quest bump (non-fatal)");
    }
}

pub const PARTNER_GAMES_CONFIG_PATH: &str = "/v1/partner-games/config";
pub const PARTNER_GAMES_VISIT_PATH: &str = "/v1/partner-games/visit";
pub const PARTNER_GAMES_HEARTBEAT_PATH: &str = "/v1/partner-games/heartbeat";
pub const PARTNER_GAMES_STOP_PATH: &str = "/v1/partner-games/stop";

/// Kafka topic — Node `KAFKA_TOPIC_PARTNER_GAMES_SESSION`.
pub const KAFKA_TOPIC_PARTNER_GAMES_SESSION: &str = "genesis.partner_games.session";
/// TTL = 3 × heartbeat interval (seconds) — Node `HEARTBEAT_REDIS_TTL_MULTIPLIER`.
const HEARTBEAT_REDIS_TTL_MULTIPLIER: u64 = 3;
pub const PARTNER_GAMES_HEARTBEAT_REDIS_TTL_SECONDS: u64 =
    (HEARTBEAT_INTERVAL_MS as u64 * HEARTBEAT_REDIS_TTL_MULTIPLIER) / MS_PER_SECOND;

const _: () = assert!(HEARTBEAT_REDIS_TTL_MULTIPLIER == 3);
const _: () = assert!(PARTNER_GAMES_HEARTBEAT_REDIS_TTL_SECONDS > 0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerGamesUserRequest {
    pub user_id: i64,
    pub slug: Option<String>,
    pub now_ms: Option<i64>,
}

#[derive(Debug)]
pub struct PartnerGamesError {
    pub http_status: u16,
    pub body: Value,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hb_key(user_id: i64, slug: &str) -> String {
    format!("partner_games:hb:{user_id}:{slug}")
}

fn rejected_decision(now: i64) -> Value {
    let d = accept_heartbeat(Some(now), now);
    json!({
        "ok": true,
        "accepted": d.accepted,
        "creditedMinutes": d.credited_minutes,
        "nextEligibleAtMs": d.next_eligible_at_ms,
    })
}

fn require_slug(slug: &Option<String>) -> Result<PartnerGame, PartnerGamesError> {
    let raw = slug.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return Err(PartnerGamesError {
            http_status: 400,
            body: json!({ "ok": false, "error": "SLUG_REQUIRED", "code": "SLUG_REQUIRED" }),
        });
    }
    game_by_slug(raw).ok_or_else(|| PartnerGamesError {
        http_status: 400,
        body: json!({ "ok": false, "error": "UNKNOWN_SLUG", "code": "UNKNOWN_SLUG" }),
    })
}

async fn require_active(
    pool: &deadpool_postgres::Pool,
    user_id: i64,
) -> Result<(), PartnerGamesError> {
    match run_assert_active_user(pool, AssertActiveRequest { user_id }).await {
        Ok(_) => Ok(()),
        Err(AssertActiveError {
            http_status,
            message,
            code,
        }) => Err(PartnerGamesError {
            http_status,
            body: json!({ "error": message, "code": code }),
        }),
    }
}

async fn publish_session(
    kafka: &SharedKafka,
    user_id: i64,
    reason: SessionReason,
    at_ms: i64,
    session_kind: &str,
    extra: serde_json::Map<String, Value>,
) {
    let ev = build_session_event(user_id, reason, at_ms, session_kind, extra);
    match serde_json::to_value(&ev) {
        Ok(payload) => {
            kafka
                .publish_json(
                    KAFKA_TOPIC_PARTNER_GAMES_SESSION,
                    Some(&user_id.to_string()),
                    payload,
                )
                .await;
        }
        Err(e) => warn!(err = %e, "partner-games kafka serialize"),
    }
}

fn game_json(g: &PartnerGame) -> Value {
    json!({
        "slug": g.slug,
        "name": g.name,
        "publicUrl": g.public_url,
        "embedPath": g.embed_path,
        "imageUrl": g.image_url,
        "sessionKind": g.session_kind,
        "section": g.section,
    })
}

pub fn public_config(cfg: &WorkerConfig) -> Value {
    let c = catalog();
    let games: Vec<Value> = c.games.iter().map(game_json).collect();
    json!({
        "ok": true,
        "heartbeatIntervalMs": c.heartbeat_interval_ms,
        "games": games,
        "maintenance": cfg.partner_games_maintenance,
    })
}

pub async fn run_config(
    pool: &deadpool_postgres::Pool,
    cfg: &WorkerConfig,
    user_id: i64,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    Ok(public_config(cfg))
}

pub async fn run_visit(
    pool: &deadpool_postgres::Pool,
    cfg: &WorkerConfig,
    kafka: &SharedKafka,
    user_id: i64,
    slug: Option<String>,
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Err(PartnerGamesError {
            http_status: 503,
            body: json!({ "ok": false, "error": "MAINTENANCE", "maintenance": true }),
        });
    }
    let game = require_slug(&slug)?;
    let at = now.unwrap_or_else(now_ms);
    publish_session(
        kafka,
        user_id,
        SessionReason::Visit,
        at,
        &game.session_kind,
        Default::default(),
    )
    .await;
    bump_partner_games_quest(pool, user_id, "partner_games_visit", 1, at).await;
    Ok(json!({ "ok": true }))
}

pub async fn run_heartbeat(
    pool: &deadpool_postgres::Pool,
    cfg: &WorkerConfig,
    locks: &RedisLockClient,
    kafka: &SharedKafka,
    user_id: i64,
    slug: Option<String>,
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Err(PartnerGamesError {
            http_status: 503,
            body: json!({ "ok": false, "error": "MAINTENANCE", "maintenance": true }),
        });
    }
    let game = require_slug(&slug)?;
    if game.embed_path.is_none() {
        return Err(PartnerGamesError {
            http_status: 400,
            body: json!({
                "ok": false,
                "accepted": false,
                "error": "HEARTBEAT_NOT_SUPPORTED",
                "code": "HEARTBEAT_NOT_SUPPORTED",
            }),
        });
    }
    let at = now.unwrap_or_else(now_ms);
    if !locks.has_redis() {
        return Ok(rejected_decision(at));
    }
    let key = hb_key(user_id, &game.slug);
    let last = match locks.get_string(&key).await {
        Ok(Some(raw)) if !raw.trim().is_empty() => {
            let n: f64 = raw.trim().parse().unwrap_or(f64::NAN);
            if n.is_finite() {
                Some(n.floor() as i64)
            } else {
                None
            }
        }
        Ok(_) => None,
        Err(_) => return Ok(rejected_decision(at)),
    };
    let decision = accept_heartbeat(last, at);
    if !decision.accepted {
        return Ok(json!({
            "ok": true,
            "accepted": false,
            "creditedMinutes": 0,
            "nextEligibleAtMs": decision.next_eligible_at_ms,
        }));
    }
    if locks
        .set_ex(
            &key,
            &at.to_string(),
            PARTNER_GAMES_HEARTBEAT_REDIS_TTL_SECONDS,
        )
        .await
        .is_err()
    {
        return Ok(rejected_decision(at));
    }
    let mut extra = serde_json::Map::new();
    extra.insert("creditedMinutes".into(), json!(decision.credited_minutes));
    publish_session(
        kafka,
        user_id,
        SessionReason::Heartbeat,
        at,
        &game.session_kind,
        extra,
    )
    .await;
    let minutes = i32::try_from(decision.credited_minutes).unwrap_or(0).max(1);
    bump_partner_games_quest(pool, user_id, "partner_games_playtime", minutes, at).await;
    Ok(json!({
        "ok": true,
        "accepted": true,
        "creditedMinutes": decision.credited_minutes,
        "nextEligibleAtMs": decision.next_eligible_at_ms,
    }))
}

pub async fn run_stop(
    pool: &deadpool_postgres::Pool,
    cfg: &WorkerConfig,
    kafka: &SharedKafka,
    user_id: i64,
    slug: Option<String>,
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Ok(json!({ "ok": true }));
    }
    let game = require_slug(&slug)?;
    let at = now.unwrap_or_else(now_ms);
    publish_session(
        kafka,
        user_id,
        SessionReason::Stop,
        at,
        &game.session_kind,
        Default::default(),
    )
    .await;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(PARTNER_GAMES_CONFIG_PATH, "/v1/partner-games/config");
        assert_eq!(PARTNER_GAMES_VISIT_PATH, "/v1/partner-games/visit");
        assert_eq!(PARTNER_GAMES_HEARTBEAT_PATH, "/v1/partner-games/heartbeat");
        assert_eq!(PARTNER_GAMES_STOP_PATH, "/v1/partner-games/stop");
        assert_eq!(
            PARTNER_GAMES_HEARTBEAT_REDIS_TTL_SECONDS,
            (HEARTBEAT_INTERVAL_MS as u64 * 3) / MS_PER_SECOND
        );
    }

    #[test]
    fn hb_key_includes_slug() {
        assert_eq!(hb_key(42, "blockminer"), "partner_games:hb:42:blockminer");
    }

    #[test]
    fn require_slug_validates() {
        assert!(require_slug(&None).is_err());
        assert!(require_slug(&Some("".into())).is_err());
        assert!(require_slug(&Some("nope".into())).is_err());
        let g = require_slug(&Some("blockminer".into())).expect("bm");
        assert_eq!(g.slug, "blockminer");
    }

    #[test]
    fn master_legends_has_embed() {
        use genesis_core::partner_games::{
            MASTER_LEGENDS_EMBED_PATH, MASTER_LEGENDS_PUBLIC_URL, SECTION_OFFICIAL,
        };
        let g = require_slug(&Some("master-legends".into())).expect("ml");
        assert_eq!(g.embed_path.as_deref(), Some(MASTER_LEGENDS_EMBED_PATH));
        assert_eq!(g.section, SECTION_OFFICIAL);
        assert_eq!(g.public_url, MASTER_LEGENDS_PUBLIC_URL);
    }

    #[test]
    fn game_json_includes_section() {
        use genesis_core::partner_games::{
            BLOCKMINER_EMBED_PATH, MASTER_LEGENDS_EMBED_PATH, SECTION_OFFICIAL, SECTION_PARTNER,
        };
        let ml = require_slug(&Some("master-legends".into())).expect("ml");
        let ml_json = game_json(&ml);
        assert_eq!(ml_json["section"], SECTION_OFFICIAL);
        assert_eq!(ml_json["embedPath"], MASTER_LEGENDS_EMBED_PATH);
        let bm = require_slug(&Some("blockminer".into())).expect("bm");
        let bm_json = game_json(&bm);
        assert_eq!(bm_json["section"], SECTION_PARTNER);
        assert_eq!(bm_json["embedPath"], BLOCKMINER_EMBED_PATH);
    }
}
