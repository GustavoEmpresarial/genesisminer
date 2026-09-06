//! Kafka producer for mining-worker (ranking snapshot + progress header events).
//!
//! Best-effort: failures are logged and never fail the HTTP / job path.
//! When `KAFKA_ENABLED≠1` or brokers unset, all publishes are no-ops.

use std::sync::Arc;
use std::time::Duration;

use genesis_core::ranking::{sum_general_ranking_power, PublicMiningRankingPayload};
use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use serde_json::json;
use tracing::{info, warn};

use crate::config::{WorkerConfig, KAFKA_TOPIC_MINING_PROGRESS, KAFKA_TOPIC_RANKING_SNAPSHOT};

/// Shared fire-and-forget producer.
#[derive(Clone)]
pub struct KafkaBus {
    producer: Option<FutureProducer>,
    enabled: bool,
}

impl KafkaBus {
    pub fn connect(cfg: &WorkerConfig) -> Self {
        if !cfg.kafka_enabled {
            return Self {
                producer: None,
                enabled: false,
            };
        }
        let Some(brokers) = cfg
            .kafka_brokers
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        else {
            warn!("KAFKA_ENABLED=1 but KAFKA_BROKERS empty — kafka bus off");
            return Self {
                producer: None,
                enabled: false,
            };
        };
        let client_id = cfg
            .kafka_client_id
            .clone()
            .unwrap_or_else(|| "genesis-mining-worker".to_string());
        match ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("client.id", &client_id)
            .set("message.timeout.ms", "5000")
            .set("socket.timeout.ms", "5000")
            .set("acks", "1")
            .create()
        {
            Ok(producer) => {
                info!(
                    brokers,
                    client_id = %client_id,
                    "kafka producer ready"
                );
                Self {
                    producer: Some(producer),
                    enabled: true,
                }
            }
            Err(e) => {
                warn!(err = %e, "kafka producer create failed — emits disabled");
                Self {
                    producer: None,
                    enabled: false,
                }
            }
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled && self.producer.is_some()
    }

    /// Best-effort publish — failures logged, never bubble to HTTP.
    pub async fn publish_json(&self, topic: &str, key: Option<&str>, payload: serde_json::Value) {
        let Some(producer) = self.producer.as_ref() else {
            return;
        };
        let body = match serde_json::to_string(&payload) {
            Ok(s) => s,
            Err(e) => {
                warn!(err = %e, topic, "kafka serialize failed");
                return;
            }
        };
        let mut record = FutureRecord::to(topic).payload(&body);
        if let Some(k) = key {
            record = record.key(k);
        }
        match producer.send(record, Duration::from_secs(5)).await {
            Ok(_) => info!(topic, key, event = "kafka_publish", "kafka publish ok"),
            Err((e, _)) => warn!(err = %e, topic, key, "kafka publish failed"),
        }
    }

    pub async fn publish_ranking_snapshot(&self, payload: &PublicMiningRankingPayload) {
        if !self.enabled() {
            return;
        }
        let at = payload.timestamp;
        let user_count = payload.ranking.len();
        let top = payload
            .ranking
            .iter()
            .map(|u| (u.user_id, sum_general_ranking_power(&u.general_coins)))
            .filter(|(_, p)| *p > 0.0)
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| id);
        let body = json!({
            "at": at,
            "userCount": user_count,
            "topUserId": top,
            "reason": "ranking_snapshot",
        });
        self.publish_json(KAFKA_TOPIC_RANKING_SNAPSHOT, Some("public"), body)
            .await;
    }

    pub async fn publish_mining_progress(&self, user_id: i64) {
        if !self.enabled() {
            return;
        }
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let body = json!({
            "userId": user_id,
            "reason": "mining_progress",
            "at": at,
        });
        self.publish_json(
            KAFKA_TOPIC_MINING_PROGRESS,
            Some(&user_id.to_string()),
            body,
        )
        .await;
    }
}

pub type SharedKafka = Arc<KafkaBus>;
