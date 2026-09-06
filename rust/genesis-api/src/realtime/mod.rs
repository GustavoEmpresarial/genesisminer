//! Socket.IO realtime on genesis-api (`socketioxide`).
//!
//! Multi-instance fanout uses the MineStation app bus [`bus::WS_EMIT_CHANNEL`]
//! (not the JS `@socket.io/redis-adapter` protocol). Local adapter only —
//! `socketioxide-redis` is incompatible with typed `RealtimeHandle` storage
//! without erasing the adapter (bus covers the same ops need).

mod auth;
mod bus;
mod chat;
mod rooms;

pub use bus::{publish_ws_emit, WsEmitMessage, WS_EMIT_CHANNEL};
pub use rooms::{chat_room_name, CHAT_CHANNEL_GLOBAL};

use std::sync::Arc;

use axum::http::{HeaderName, HeaderValue, Method};
use serde_json::{json, Value};
use socketioxide::layer::SocketIoLayer;
use socketioxide::{SocketIo, SocketIoBuilder};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

use crate::config::AppState;

use self::bus::run_ws_emit_subscriber;
use self::chat::on_connect;

/// Cloneable emit handle for HTTP facades (market / chat audio).
#[derive(Clone)]
pub struct RealtimeHandle {
    io: SocketIo,
    redis_url: Option<String>,
}

impl RealtimeHandle {
    /// Emit `event` to `room` (or broadcast when `room` is `None`).
    ///
    /// With `REDIS_URL`: publish to [`WS_EMIT_CHANNEL`] so every genesis-api
    /// instance (including this one) emits locally via the bus subscriber.
    /// Without Redis: emit on this process only.
    pub async fn emit(&self, event: &str, room: Option<&str>, payload: Value) {
        if let Some(url) = &self.redis_url {
            let msg = WsEmitMessage {
                event: event.to_string(),
                room: room.map(|s| s.to_string()),
                payload: payload.clone(),
            };
            if let Err(e) = publish_ws_emit(url, &msg).await {
                warn!(err = %e, "ws emit publish failed — falling back local");
                emit_local(&self.io, event, room, &payload).await;
            }
        } else {
            emit_local(&self.io, event, room, &payload).await;
        }
    }

    pub async fn emit_market(&self, payload: Value) {
        self.emit("market", None, payload).await;
    }

    pub async fn emit_chat_message(&self, channel: &str, message: Value) {
        let room = chat_room_name(channel);
        self.emit("chat:message", Some(&room), message).await;
    }
}

async fn emit_local(io: &SocketIo, event: &str, room: Option<&str>, payload: &Value) {
    let result = if let Some(room) = room {
        io.to(room.to_string()).emit(event, payload).await
    } else {
        io.emit(event, payload).await
    };
    if let Err(e) = result {
        warn!(err = %e, event, "socket emit failed");
    }
}

/// CORS origins — Node `attach.ts` `parseSocketOrigins`.
pub fn parse_socket_origins() -> Option<Vec<HeaderValue>> {
    let mut out: Vec<HeaderValue> = Vec::new();
    if let Ok(primary) = std::env::var("FRONTEND_URL") {
        let t = primary.trim();
        if !t.is_empty() {
            if let Ok(hv) = HeaderValue::from_str(t) {
                out.push(hv);
            }
        }
    }
    if let Ok(raw) = std::env::var("CORS_ALLOWED_ORIGINS") {
        for part in raw.split(',') {
            let t = part.trim();
            if t.is_empty() {
                continue;
            }
            if let Ok(hv) = HeaderValue::from_str(t) {
                if !out.iter().any(|e| e == &hv) {
                    out.push(hv);
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn cors_layer_for_socket() -> CorsLayer {
    let mut layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("content-type"),
            http::header::COOKIE,
            http::header::AUTHORIZATION,
        ])
        .allow_credentials(true);
    match parse_socket_origins() {
        Some(origins) => {
            layer = layer.allow_origin(AllowOrigin::list(origins));
        }
        None => {
            layer = layer.allow_origin(AllowOrigin::mirror_request());
        }
    }
    layer
}

fn spawn_bus_subscriber(handle: RealtimeHandle) {
    let Some(url) = handle.redis_url.clone() else {
        info!("REDIS_URL unset — genesis:ws:emit subscriber off");
        return;
    };
    let handle_bus = handle.clone();
    tokio::spawn(async move {
        run_ws_emit_subscriber(url, move |msg| {
            let handle = handle_bus.clone();
            async move {
                emit_local(&handle.io, &msg.event, msg.room.as_deref(), &msg.payload).await;
            }
        })
        .await;
    });
}

/// Build Socket.IO tower layer + handle; spawn bus subscriber when Redis is set.
pub async fn build_socketio(state: Arc<AppState>) -> (SocketIoLayer, RealtimeHandle) {
    let redis_url = std::env::var("REDIS_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (layer, io) = SocketIoBuilder::new().with_state(state).build_layer();
    let _ = io.ns("/", on_connect);
    info!("Socket.IO attached at /socket.io");
    if redis_url.is_some() {
        info!("multi-instance emits via {}", WS_EMIT_CHANNEL);
    } else {
        info!("REDIS_URL unset — Socket.IO single-instance");
    }
    let handle = RealtimeHandle { io, redis_url };
    spawn_bus_subscriber(handle.clone());
    (layer, handle)
}

pub fn stack_hello_payload(unix_ms: i64) -> Value {
    json!({ "ok": true, "t": unix_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_channel_exported() {
        assert_eq!(WS_EMIT_CHANNEL, "genesis:ws:emit");
    }

    #[test]
    fn stack_hello_shape() {
        let p = stack_hello_payload(1_700_000_000_000);
        assert_eq!(p["ok"], true);
        assert_eq!(p["t"], 1_700_000_000_000_i64);
    }
}
