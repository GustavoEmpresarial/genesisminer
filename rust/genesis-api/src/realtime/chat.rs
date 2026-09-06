//! Socket.IO chat handlers — parity Node `modules/chat/services/socket.ts`.
//! Domain I/O goes through mining-worker `/v1/chat/*` twins (no SQL here).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use socketioxide::adapter::Adapter;
use socketioxide::extract::{Data, SocketRef, State};
use socketioxide::SocketIo;
use tracing::warn;

use crate::config::AppState;
use crate::realtime::auth::{resolve_chat_actor_arc, ChatActor};
use crate::realtime::rooms::{
    channel_from_chat_room, chat_room_name, chat_user_room, normalize_chat_channel,
    CHAT_CHANNEL_GLOBAL,
};
use crate::workers::post_mining;

const CHAT_CAN_ACCESS_PATH: &str = "/v1/chat/can-access";
const CHAT_RATE_LIMIT_PATH: &str = "/v1/chat/rate-limit";
const CHAT_SENDER_PATH: &str = "/v1/chat/sender";
const CHAT_INSERT_PATH: &str = "/v1/chat/insert";
const CHAT_EDIT_PATH: &str = "/v1/chat/edit";
const CHAT_DELETE_PATH: &str = "/v1/chat/delete";
const CHAT_MENTIONS_RESOLVE_PATH: &str = "/v1/chat/mentions-resolve";
const CHAT_PRESENCE_PATH: &str = "/v1/chat/presence";

/// Node `CHAT_MAX_BODY_LEN`.
const CHAT_MAX_BODY_LEN: usize = 280;
/// Node `MENTION_MAX_TOKENS`.
const MENTION_MAX_TOKENS: usize = 10;
/// Node mention token body: first char + up to 49 more (`{0,49}`).
const MENTION_TOKEN_TAIL_MAX: usize = 49;

#[derive(Clone, Default)]
struct JoinedRooms(Arc<Mutex<HashSet<String>>>);

#[derive(Clone)]
struct CachedActor(Arc<Mutex<Option<ChatActor>>>);

fn cookie_header_from_socket<A: Adapter>(socket: &SocketRef<A>) -> Option<String> {
    socket
        .req_parts()
        .headers
        .get(http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

async fn resolve_and_cache_actor<A: Adapter>(
    socket: &SocketRef<A>,
    state: &Arc<AppState>,
) -> Option<ChatActor> {
    let actor = resolve_chat_actor_arc(state, cookie_header_from_socket(socket).as_deref()).await;
    if let Some(cache) = socket.extensions.get::<CachedActor>() {
        if let Ok(mut g) = cache.0.lock() {
            *g = actor.clone();
        }
    }
    actor
}

fn cached_actor<A: Adapter>(socket: &SocketRef<A>) -> Option<ChatActor> {
    socket
        .extensions
        .get::<CachedActor>()
        .and_then(|c| c.0.lock().ok().and_then(|g| g.clone()))
}

fn payload_channel(payload: &Value) -> String {
    let raw = payload
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or(CHAT_CHANNEL_GLOBAL);
    normalize_chat_channel(raw)
}

fn payload_body_raw(payload: &Value) -> Value {
    payload
        .get("body")
        .cloned()
        .unwrap_or_else(|| payload.clone())
}

/// Node `sanitizeChatBody` — control chars / tags stripped; length capped.
pub fn sanitize_chat_body(raw: &Value) -> Option<String> {
    let s = match raw {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\0' || ch.is_control() {
            continue;
        }
        if ch == '<' || ch == '>' {
            continue;
        }
        out.push(ch);
    }
    let mut collapsed = String::new();
    let mut prev_space = false;
    for ch in out.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    let capped: String = trimmed.chars().take(CHAT_MAX_BODY_LEN).collect();
    if capped.trim().is_empty() {
        None
    } else {
        Some(capped)
    }
}

fn extract_mention_tokens(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let at_ok = bytes[i] == b'@'
            && (i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'(' | b'[' | b'{'));
        if !at_ok {
            i += 1;
            continue;
        }
        let start = i + 1;
        if start >= bytes.len() {
            break;
        }
        let first = bytes[start];
        if !(first.is_ascii_alphanumeric() || first == b'_') {
            i += 1;
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len()
            && end - start <= MENTION_TOKEN_TAIL_MAX
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'-')
        {
            end += 1;
        }
        let token = &body[start..end];
        let key = token.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(token.to_string());
            if out.len() >= MENTION_MAX_TOKENS {
                break;
            }
        }
        i = end;
    }
    out
}

fn message_dto_from_worker(body: &Value) -> Value {
    if let Some(row) = body.get("row").cloned().filter(|v| !v.is_null()) {
        let username = row
            .get("username")
            .cloned()
            .or_else(|| row.get("usernameSnapshot").cloned())
            .unwrap_or(json!(""));
        let mut msg = row;
        if let Value::Object(ref mut m) = msg {
            m.entry("username".to_string()).or_insert(username);
            if let Some(uid) = m.get("userId").cloned().or_else(|| m.remove("user_id")) {
                m.insert("userId".into(), uid);
            }
            if let Some(ca) = m
                .get("createdAt")
                .cloned()
                .or_else(|| m.remove("created_at"))
            {
                m.insert("createdAt".into(), ca);
            }
        }
        return msg;
    }
    body.get("message").cloned().unwrap_or_else(|| body.clone())
}

async fn twin(
    state: &AppState,
    path: &str,
    body: Value,
) -> Result<crate::workers::WorkerJson, crate::workers::WorkerCallError> {
    post_mining(&state.cfg, &state.http, path, &body).await
}

pub async fn on_connect<A: Adapter>(socket: SocketRef<A>, State(app): State<Arc<AppState>>) {
    let _ = app;
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let _ = socket.emit("stack:hello", &json!({ "ok": true, "t": t }));

    socket.extensions.insert(JoinedRooms::default());
    socket
        .extensions
        .insert(CachedActor(Arc::new(Mutex::new(None))));

    socket.on("chat:subscribe", on_subscribe::<A>);
    socket.on("chat:send", on_send::<A>);
    socket.on("chat:edit", on_edit::<A>);
    socket.on("chat:delete", on_delete::<A>);
    socket.on_disconnect(on_disconnect::<A>);
}

async fn on_subscribe<A: Adapter>(
    socket: SocketRef<A>,
    io: SocketIo<A>,
    Data(payload): Data<Value>,
    State(app): State<Arc<AppState>>,
) {
    let Some(actor) = resolve_and_cache_actor(&socket, &app).await else {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "AUTH", "error": "Sign in to use chat." }),
        );
        return;
    };
    let channel = payload_channel(&payload);
    match twin(
        &app,
        CHAT_CAN_ACCESS_PATH,
        json!({ "userId": actor.real_user_id, "channel": channel }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true && r.body["allowed"] == true => {}
        Ok(r) if r.body["ok"] == true => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "FORBIDDEN", "error": "No access to this channel." }),
            );
            return;
        }
        Ok(_) | Err(_) => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "INTERNAL", "error": "Could not join chat." }),
            );
            return;
        }
    }

    let sender = match twin(
        &app,
        CHAT_SENDER_PATH,
        json!({ "userId": actor.real_user_id }),
    )
    .await
    {
        Ok(r) if r.body["ok"] != false => r,
        _ => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "AUTH", "error": "Invalid user." }),
            );
            return;
        }
    };
    let username = sender.body["username"]
        .as_str()
        .or_else(|| sender.body["sender"]["username"].as_str())
        .unwrap_or("")
        .to_string();
    if username.is_empty() {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "AUTH", "error": "Invalid user." }),
        );
        return;
    }
    if sender.body["isBlocked"] == true || sender.body["sender"]["isBlocked"] == true {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "BLOCKED", "error": "Account blocked." }),
        );
        return;
    }

    let room = chat_room_name(&channel);
    socket.join(room.clone());
    if let Some(joined) = socket.extensions.get::<JoinedRooms>() {
        if let Ok(mut g) = joined.0.lock() {
            g.insert(room.clone());
        }
    }
    socket.join(chat_user_room(actor.real_user_id));

    let presence = twin(
        &app,
        CHAT_PRESENCE_PATH,
        json!({
            "action": "join",
            "channel": channel,
            "socketId": socket.id.to_string()
        }),
    )
    .await;
    let online = presence
        .ok()
        .and_then(|r| r.body["online"].as_i64())
        .unwrap_or(0);

    let _ = socket.emit(
        "chat:subscribed",
        &json!({
            "ok": true,
            "channel": channel,
            "username": username,
            "online": online,
            "realUserId": actor.real_user_id
        }),
    );
    if channel == CHAT_CHANNEL_GLOBAL {
        let _ = io
            .to(room)
            .emit(
                "chat:presence",
                &json!({ "channel": channel, "online": online }),
            )
            .await;
    }
}

async fn on_send<A: Adapter>(
    socket: SocketRef<A>,
    io: SocketIo<A>,
    Data(payload): Data<Value>,
    State(app): State<Arc<AppState>>,
) {
    let actor = match cached_actor(&socket) {
        Some(a) => a,
        None => match resolve_and_cache_actor(&socket, &app).await {
            Some(a) => a,
            None => {
                let _ = socket.emit(
                    "chat:error",
                    &json!({ "code": "AUTH", "error": "Sign in to send messages." }),
                );
                return;
            }
        },
    };
    let channel = payload_channel(&payload);
    let Some(body) = sanitize_chat_body(&payload_body_raw(&payload)) else {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "EMPTY", "error": "Empty message." }),
        );
        return;
    };

    match twin(
        &app,
        CHAT_CAN_ACCESS_PATH,
        json!({ "userId": actor.real_user_id, "channel": channel }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true && r.body["allowed"] == true => {}
        Ok(r) if r.body["ok"] == true => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "FORBIDDEN", "error": "No access to this channel." }),
            );
            return;
        }
        _ => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "INTERNAL", "error": "Failed to send message." }),
            );
            return;
        }
    }

    let sender_user_id = if channel == CHAT_CHANNEL_GLOBAL {
        actor.session_user_id
    } else {
        actor.real_user_id
    };

    match twin(
        &app,
        CHAT_RATE_LIMIT_PATH,
        json!({ "userId": actor.real_user_id }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => {}
        Ok(r) => {
            let _ = socket.emit(
                "chat:error",
                &json!({
                    "code": "RATE",
                    "error": "Wait a moment before sending another message.",
                    "retryAfterMs": r.body["retryAfterMs"]
                }),
            );
            return;
        }
        Err(_) => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "INTERNAL", "error": "Failed to send message." }),
            );
            return;
        }
    }

    let sender = match twin(&app, CHAT_SENDER_PATH, json!({ "userId": sender_user_id })).await {
        Ok(r) => r,
        Err(_) => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "AUTH", "error": "Invalid user." }),
            );
            return;
        }
    };
    let username = sender.body["username"]
        .as_str()
        .or_else(|| sender.body["sender"]["username"].as_str())
        .unwrap_or("")
        .to_string();
    if username.is_empty() {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "AUTH", "error": "Invalid user." }),
        );
        return;
    }
    if sender.body["isBlocked"] == true || sender.body["sender"]["isBlocked"] == true {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "BLOCKED", "error": "Account blocked." }),
        );
        return;
    }

    let room = chat_room_name(&channel);
    let already = socket
        .extensions
        .get::<JoinedRooms>()
        .and_then(|j| j.0.lock().ok().map(|g| g.contains(&room)))
        .unwrap_or(false);
    if !already {
        socket.join(room.clone());
        if let Some(joined) = socket.extensions.get::<JoinedRooms>() {
            if let Ok(mut g) = joined.0.lock() {
                g.insert(room.clone());
            }
        }
    }

    let inserted = match twin(
        &app,
        CHAT_INSERT_PATH,
        json!({
            "userId": sender_user_id,
            "username": username,
            "body": body,
            "channel": channel
        }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => r,
        _ => {
            let _ = socket.emit(
                "chat:error",
                &json!({ "code": "INTERNAL", "error": "Failed to send message." }),
            );
            return;
        }
    };

    let msg = message_dto_from_worker(&inserted.body);
    let mentions = resolve_mentions(&app, &body).await;
    let message_payload = if mentions.is_empty() {
        msg.clone()
    } else {
        let mut m = msg.clone();
        if let Value::Object(ref mut map) = m {
            map.insert("mentions".into(), Value::Array(mentions.clone()));
        }
        m
    };

    let _ = io.to(room).emit("chat:message", &message_payload).await;
    for mention in &mentions {
        let uid = mention["userId"].as_i64().unwrap_or(0);
        if uid == sender_user_id || uid == actor.real_user_id {
            continue;
        }
        let _ = io
            .to(chat_user_room(uid))
            .emit(
                "chat:mention",
                &json!({ "message": message_payload, "channel": channel }),
            )
            .await;
    }
}

async fn resolve_mentions(app: &AppState, body: &str) -> Vec<Value> {
    let tokens = extract_mention_tokens(body);
    if tokens.is_empty() {
        return vec![];
    }
    let keys: Vec<String> = tokens
        .iter()
        .map(|t| t.to_ascii_lowercase())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let Ok(r) = twin(app, CHAT_MENTIONS_RESOLVE_PATH, json!({ "tokens": keys })).await else {
        return vec![];
    };
    let users = r.body["users"].as_array().cloned().unwrap_or_default();
    let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for u in users {
        let username = u["username"].as_str().unwrap_or("").to_string();
        let user_id = u["userId"].as_i64().unwrap_or(0);
        if username.is_empty() || user_id <= 0 {
            continue;
        }
        let dto = json!({ "userId": user_id, "username": username });
        by_key.insert(username.to_ascii_lowercase(), dto.clone());
        by_key.insert(username.replace(' ', "").to_ascii_lowercase(), dto.clone());
        by_key.insert(username.replace(' ', "_").to_ascii_lowercase(), dto);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for token in tokens {
        if let Some(hit) = by_key.get(&token.to_ascii_lowercase()) {
            let uid = hit["userId"].as_i64().unwrap_or(0);
            if seen.insert(uid) {
                out.push(hit.clone());
            }
        }
    }
    out
}

async fn on_edit<A: Adapter>(
    socket: SocketRef<A>,
    io: SocketIo<A>,
    Data(payload): Data<Value>,
    State(app): State<Arc<AppState>>,
) {
    let actor = match cached_actor(&socket) {
        Some(a) => a,
        None => match resolve_and_cache_actor(&socket, &app).await {
            Some(a) => a,
            None => {
                let _ = socket.emit(
                    "chat:error",
                    &json!({ "code": "AUTH", "error": "Sign in to edit messages." }),
                );
                return;
            }
        },
    };
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let Some(body) = sanitize_chat_body(payload.get("body").unwrap_or(&Value::Null)) else {
        let _ = socket.emit(
            "chat:error",
            &json!({ "code": "EMPTY", "error": "Empty message." }),
        );
        return;
    };

    let edited = match try_mutate_edit(&app, &actor, &id, &body).await {
        Ok(r) => r,
        Err((code, error)) => {
            let _ = socket.emit("chat:error", &json!({ "code": code, "error": error }));
            return;
        }
    };
    let msg = message_dto_from_worker(&edited.body);
    let channel = msg
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or(CHAT_CHANNEL_GLOBAL)
        .to_string();
    let mentions = resolve_mentions(&app, &body).await;
    let message_payload = if mentions.is_empty() {
        msg
    } else {
        let mut m = msg;
        if let Value::Object(ref mut map) = m {
            map.insert("mentions".into(), Value::Array(mentions.clone()));
        }
        m
    };
    let _ = io
        .to(chat_room_name(&channel))
        .emit("chat:message_updated", &message_payload)
        .await;
    for mention in &mentions {
        let uid = mention["userId"].as_i64().unwrap_or(0);
        if uid == actor.real_user_id || uid == actor.session_user_id {
            continue;
        }
        let _ = io
            .to(chat_user_room(uid))
            .emit(
                "chat:mention",
                &json!({ "message": message_payload, "channel": channel }),
            )
            .await;
    }
}

async fn try_mutate_edit(
    app: &AppState,
    actor: &ChatActor,
    message_id: &str,
    body: &str,
) -> Result<crate::workers::WorkerJson, (String, String)> {
    for uid in unique_actor_ids(actor) {
        match twin(
            app,
            CHAT_EDIT_PATH,
            json!({ "userId": uid, "messageId": message_id, "body": body }),
        )
        .await
        {
            Ok(r) if r.body["ok"] == true => return Ok(r),
            Ok(r) => {
                let code = r.body["code"].as_str().unwrap_or("INTERNAL").to_string();
                if code == "FORBIDDEN" {
                    continue;
                }
                return Err((
                    code,
                    r.body["error"]
                        .as_str()
                        .unwrap_or("Failed to edit message.")
                        .to_string(),
                ));
            }
            Err(_) => {
                return Err(("INTERNAL".into(), "Failed to edit message.".into()));
            }
        }
    }
    Err((
        "FORBIDDEN".into(),
        "You can only edit your own messages.".into(),
    ))
}

async fn on_delete<A: Adapter>(
    socket: SocketRef<A>,
    io: SocketIo<A>,
    Data(payload): Data<Value>,
    State(app): State<Arc<AppState>>,
) {
    let actor = match cached_actor(&socket) {
        Some(a) => a,
        None => match resolve_and_cache_actor(&socket, &app).await {
            Some(a) => a,
            None => {
                let _ = socket.emit(
                    "chat:error",
                    &json!({ "code": "AUTH", "error": "Sign in to delete messages." }),
                );
                return;
            }
        },
    };
    let id = if let Some(s) = payload.get("id").and_then(|v| v.as_str()) {
        s.to_string()
    } else if let Some(s) = payload.as_str() {
        s.to_string()
    } else {
        payload.to_string()
    };

    let deleted = match try_mutate_delete(&app, &actor, &id).await {
        Ok(r) => r,
        Err((code, error)) => {
            let _ = socket.emit("chat:error", &json!({ "code": code, "error": error }));
            return;
        }
    };
    let channel = deleted.body["channel"]
        .as_str()
        .unwrap_or(CHAT_CHANNEL_GLOBAL)
        .to_string();
    let _ = io
        .to(chat_room_name(&channel))
        .emit(
            "chat:message_deleted",
            &json!({
                "id": deleted.body["id"],
                "channel": channel,
                "deletedAt": deleted.body["deletedAt"]
            }),
        )
        .await;
}

async fn try_mutate_delete(
    app: &AppState,
    actor: &ChatActor,
    message_id: &str,
) -> Result<crate::workers::WorkerJson, (String, String)> {
    for uid in unique_actor_ids(actor) {
        match twin(
            app,
            CHAT_DELETE_PATH,
            json!({ "userId": uid, "messageId": message_id }),
        )
        .await
        {
            Ok(r) if r.body["ok"] == true => return Ok(r),
            Ok(r) => {
                let code = r.body["code"].as_str().unwrap_or("INTERNAL").to_string();
                if code == "FORBIDDEN" {
                    continue;
                }
                return Err((
                    code,
                    r.body["error"]
                        .as_str()
                        .unwrap_or("Failed to delete message.")
                        .to_string(),
                ));
            }
            Err(_) => {
                return Err(("INTERNAL".into(), "Failed to delete message.".into()));
            }
        }
    }
    Err((
        "FORBIDDEN".into(),
        "You can only delete your own messages.".into(),
    ))
}

fn unique_actor_ids(actor: &ChatActor) -> Vec<i64> {
    let mut ids = vec![actor.session_user_id];
    if actor.real_user_id != actor.session_user_id {
        ids.push(actor.real_user_id);
    }
    ids
}

async fn on_disconnect<A: Adapter>(
    socket: SocketRef<A>,
    io: SocketIo<A>,
    State(app): State<Arc<AppState>>,
) {
    let rooms: Vec<String> = socket
        .extensions
        .get::<JoinedRooms>()
        .and_then(|j| j.0.lock().ok().map(|g| g.iter().cloned().collect()))
        .unwrap_or_default();
    for room in rooms {
        let Some(channel) = channel_from_chat_room(&room).map(|s| s.to_string()) else {
            continue;
        };
        let presence = twin(
            &app,
            CHAT_PRESENCE_PATH,
            json!({
                "action": "leave",
                "channel": channel,
                "socketId": socket.id.to_string()
            }),
        )
        .await;
        if channel == CHAT_CHANNEL_GLOBAL {
            let online = presence
                .as_ref()
                .ok()
                .and_then(|r| r.body["online"].as_i64())
                .unwrap_or(0);
            let _ = io
                .to(room)
                .emit(
                    "chat:presence",
                    &json!({ "channel": CHAT_CHANNEL_GLOBAL, "online": online }),
                )
                .await;
        }
    }
}

/// Emit `chat:message` after successful HTTP audio upload (Node controller parity).
pub async fn emit_chat_message_to_channel<A: Adapter>(
    io: &SocketIo<A>,
    channel: &str,
    message: &Value,
) {
    let room = chat_room_name(channel);
    if let Err(e) = io.to(room).emit("chat:message", message).await {
        warn!(err = %e, "chat audio emit failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_empty_and_caps_len() {
        assert!(sanitize_chat_body(&json!("")).is_none());
        assert!(sanitize_chat_body(&json!("   ")).is_none());
        let long: String = "a".repeat(CHAT_MAX_BODY_LEN + 10);
        let cleaned = sanitize_chat_body(&json!(long)).unwrap();
        assert_eq!(cleaned.chars().count(), CHAT_MAX_BODY_LEN);
    }

    #[test]
    fn mention_tokens_extract() {
        let t = extract_mention_tokens("hi @Alice and @bob_1");
        assert_eq!(t, vec!["Alice".to_string(), "bob_1".to_string()]);
    }
}
