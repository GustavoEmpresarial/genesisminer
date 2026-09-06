//! Partner Games session I/O — Redis heartbeat + Kafka (Node `session.ts`).

use genesis_core::partner_games::{
    accept_heartbeat, build_session_event, session_config, SessionReason, HEARTBEAT_INTERVAL_MS,
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

fn hb_key(user_id: i64) -> String {
    format!("partner_games:hb:{user_id}")
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
    extra: serde_json::Map<String, Value>,
) {
    let ev = build_session_event(user_id, reason, at_ms, extra);
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

pub fn public_config(cfg: &WorkerConfig) -> Value {
    let c = session_config();
    json!({
        "ok": true,
        "embedPath": c.embed_path,
        "publicUrl": c.public_url,
        "heartbeatIntervalMs": c.heartbeat_interval_ms,
        "sessionKind": c.session_kind,
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
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Err(PartnerGamesError {
            http_status: 503,
            body: json!({ "ok": false, "error": "MAINTENANCE", "maintenance": true }),
        });
    }
    let at = now.unwrap_or_else(now_ms);
    publish_session(kafka, user_id, SessionReason::Visit, at, Default::default()).await;
    bump_partner_games_quest(pool, user_id, "partner_games_visit", 1, at).await;
    Ok(json!({ "ok": true }))
}

pub async fn run_heartbeat(
    pool: &deadpool_postgres::Pool,
    cfg: &WorkerConfig,
    locks: &RedisLockClient,
    kafka: &SharedKafka,
    user_id: i64,
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Err(PartnerGamesError {
            http_status: 503,
            body: json!({ "ok": false, "error": "MAINTENANCE", "maintenance": true }),
        });
    }
    let at = now.unwrap_or_else(now_ms);
    if !locks.has_redis() {
        return Ok(rejected_decision(at));
    }
    let key = hb_key(user_id);
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
    publish_session(kafka, user_id, SessionReason::Heartbeat, at, extra).await;
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
    now: Option<i64>,
) -> Result<Value, PartnerGamesError> {
    require_active(pool, user_id).await?;
    if cfg.partner_games_maintenance {
        return Ok(json!({ "ok": true }));
    }
    let at = now.unwrap_or_else(now_ms);
    publish_session(kafka, user_id, SessionReason::Stop, at, Default::default()).await;
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
}
