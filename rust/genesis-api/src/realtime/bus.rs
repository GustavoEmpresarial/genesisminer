//! App-level Redis pub/sub for cross-service Socket.IO emits.
//!
//! Channel protocol is MineStation-owned — **not** the JS `@socket.io/redis-adapter`
//! wire format. Message JSON: `{ "event": string, "room": string|null, "payload": any }`.

use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

/// Cross-service emit fanout — same string as Node plans / ops docs.
pub const WS_EMIT_CHANNEL: &str = "genesis:ws:emit";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsEmitMessage {
    pub event: String,
    /// `null` = broadcast all connected sockets.
    pub room: Option<String>,
    pub payload: Value,
}

pub async fn publish_ws_emit(
    redis_url: &str,
    msg: &WsEmitMessage,
) -> Result<(), redis::RedisError> {
    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    let body = serde_json::to_string(msg).map_err(|e| {
        redis::RedisError::from((
            redis::ErrorKind::TypeError,
            "ws emit serialize",
            e.to_string(),
        ))
    })?;
    let _: i64 = conn.publish(WS_EMIT_CHANNEL, body).await?;
    Ok(())
}

/// Subscribe loop — caller supplies a local emit callback (room + event + payload).
pub async fn run_ws_emit_subscriber<F, Fut>(redis_url: String, mut on_msg: F)
where
    F: FnMut(WsEmitMessage) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        match subscribe_once(&redis_url, &mut on_msg).await {
            Ok(()) => {
                warn!(
                    channel = WS_EMIT_CHANNEL,
                    "ws emit subscriber ended — reconnecting"
                );
            }
            Err(e) => {
                warn!(
                    channel = WS_EMIT_CHANNEL,
                    err = %e,
                    "ws emit subscriber error — reconnecting"
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            genesis_core::time::MS_PER_SECOND,
        ))
        .await;
    }
}

async fn subscribe_once<F, Fut>(redis_url: &str, on_msg: &mut F) -> Result<(), redis::RedisError>
where
    F: FnMut(WsEmitMessage) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let client = redis::Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(WS_EMIT_CHANNEL).await?;
    info!(channel = WS_EMIT_CHANNEL, "ws emit subscriber listening");
    let mut stream = pubsub.on_message();
    use futures_util::StreamExt;
    while let Some(msg) = stream.next().await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                warn!(err = %e, "ws emit payload read failed");
                continue;
            }
        };
        match serde_json::from_str::<WsEmitMessage>(&payload) {
            Ok(parsed) => on_msg(parsed).await,
            Err(e) => warn!(err = %e, "ws emit JSON parse failed"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_const_matches_contract() {
        assert_eq!(WS_EMIT_CHANNEL, "genesis:ws:emit");
    }

    #[test]
    fn message_roundtrip_null_room() {
        let msg = WsEmitMessage {
            event: "market".into(),
            room: None,
            payload: serde_json::json!({ "type": "market", "event": "listing_sold" }),
        };
        let s = serde_json::to_string(&msg).unwrap();
        let back: WsEmitMessage = serde_json::from_str(&s).unwrap();
        assert_eq!(back.event, "market");
        assert!(back.room.is_none());
    }
}
