//! Chat Socket.IO room name helpers — Node `chatRoomName` / `chatUserRoom`.
//! Also maps worker AM contract rows to the HTTP `GET /api/chat/peers` DTO
//! (`listAmPeersForUser` in Node `server/modules/chat/services/chat.ts`).

use serde_json::{json, Value};

/// Node `CHAT_CHANNEL_GLOBAL`.
pub const CHAT_CHANNEL_GLOBAL: &str = "global";

const CHAT_ROOM_PREFIX: &str = "chat:";
const CHAT_USER_ROOM_PREFIX: &str = "chat:user:";
/// Node `listAmPeersForUser` fallback when `managerUsername` is empty.
const AM_PEER_FALLBACK_MANAGER: &str = "Gerente";
/// Node `listAmPeersForUser` fallback when `ownerUsername` is empty.
const AM_PEER_FALLBACK_OWNER: &str = "Dono";

/// Node `chatRoomName`.
pub fn chat_room_name(channel: &str) -> String {
    format!("{CHAT_ROOM_PREFIX}{}", normalize_chat_channel(channel))
}

/// Node `chatUserRoom`.
pub fn chat_user_room(user_id: i64) -> String {
    format!("{CHAT_USER_ROOM_PREFIX}{user_id}")
}

/// Channel from a `chat:<channel>` room (skips `chat:user:*`).
pub fn channel_from_chat_room(room: &str) -> Option<&str> {
    if room.starts_with(CHAT_USER_ROOM_PREFIX) {
        return None;
    }
    room.strip_prefix(CHAT_ROOM_PREFIX)
        .filter(|c| !c.is_empty())
}

/// Node `normalizeChatChannel` (global or `am:owner:manager`).
pub fn normalize_chat_channel(raw: &str) -> String {
    let s = raw.trim();
    let s = if s.is_empty() { CHAT_CHANNEL_GLOBAL } else { s };
    if s == CHAT_CHANNEL_GLOBAL {
        return CHAT_CHANNEL_GLOBAL.to_string();
    }
    if let Some((owner, manager)) = parse_am_channel(s) {
        return format!("am:{owner}:{manager}");
    }
    CHAT_CHANNEL_GLOBAL.to_string()
}

fn parse_am_channel(channel: &str) -> Option<(i64, i64)> {
    let rest = channel.strip_prefix("am:")?;
    let mut parts = rest.split(':');
    let owner = parts.next()?.parse::<i64>().ok()?;
    let manager = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if owner <= 0 || manager <= 0 || owner == manager {
        return None;
    }
    Some((owner, manager))
}

fn nonempty_username(v: Option<&Value>) -> Option<&str> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Worker `/v1/chat/peers` returns `{ rows }`; the client widget expects
/// `{ peers: ChatAmPeerDto[], realUserId }`. `real_user_id` is the human
/// (gerente in `manager_mode`), same as Node `listAmPeersForUser`.
pub fn map_am_peer_dtos(real_user_id: i64, rows: &Value) -> Vec<Value> {
    let Some(arr) = rows.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|r| {
            let owner = r.get("ownerUserId")?.as_i64().filter(|n| *n > 0)?;
            let manager = r.get("managerUserId")?.as_i64().filter(|n| *n > 0)?;
            if owner == manager {
                return None;
            }
            let is_owner = real_user_id == owner;
            let owner_username = nonempty_username(r.get("ownerUsername"));
            let manager_username = nonempty_username(r.get("managerUsername"));
            let (peer_user_id, peer_username, role) = if is_owner {
                (
                    manager,
                    manager_username.unwrap_or(AM_PEER_FALLBACK_MANAGER),
                    "owner",
                )
            } else {
                (
                    owner,
                    owner_username.unwrap_or(AM_PEER_FALLBACK_OWNER),
                    "manager",
                )
            };
            Some(json!({
                "channel": format!("am:{owner}:{manager}"),
                "ownerUserId": owner,
                "managerUserId": manager,
                "peerUserId": peer_user_id,
                "peerUsername": peer_username,
                "role": role,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_helpers_match_node() {
        assert_eq!(chat_room_name("global"), "chat:global");
        assert_eq!(chat_room_name(""), "chat:global");
        assert_eq!(chat_room_name("am:1:2"), "chat:am:1:2");
        assert_eq!(chat_user_room(42), "chat:user:42");
        assert_eq!(channel_from_chat_room("chat:global"), Some("global"));
        assert_eq!(channel_from_chat_room("chat:user:9"), None);
    }

    #[test]
    fn map_am_peers_gerente_sees_owner() {
        let rows = json!([{
            "ownerUserId": 10,
            "managerUserId": 20,
            "ownerUsername": "DonoX",
            "managerUsername": "GerY"
        }]);
        let peers = map_am_peer_dtos(20, &rows);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["channel"], "am:10:20");
        assert_eq!(peers[0]["peerUserId"], 10);
        assert_eq!(peers[0]["peerUsername"], "DonoX");
        assert_eq!(peers[0]["role"], "manager");
    }

    #[test]
    fn map_am_peers_owner_sees_gerente() {
        let rows = json!([{
            "ownerUserId": 10,
            "managerUserId": 20,
            "ownerUsername": "DonoX",
            "managerUsername": "GerY"
        }]);
        let peers = map_am_peer_dtos(10, &rows);
        assert_eq!(peers[0]["peerUserId"], 20);
        assert_eq!(peers[0]["peerUsername"], "GerY");
        assert_eq!(peers[0]["role"], "owner");
    }

    #[test]
    fn map_am_peers_empty_username_uses_node_fallback() {
        let rows = json!([{
            "ownerUserId": 1,
            "managerUserId": 2,
            "ownerUsername": "  ",
            "managerUsername": null
        }]);
        let as_owner = map_am_peer_dtos(1, &rows);
        assert_eq!(as_owner[0]["peerUsername"], AM_PEER_FALLBACK_MANAGER);
        let as_manager = map_am_peer_dtos(2, &rows);
        assert_eq!(as_manager[0]["peerUsername"], AM_PEER_FALLBACK_OWNER);
    }

    #[test]
    fn map_am_peers_skips_invalid_rows() {
        let rows = json!([
            { "ownerUserId": 5, "managerUserId": 5, "ownerUsername": "x", "managerUsername": "y" },
            { "ownerUserId": 0, "managerUserId": 2 },
            "nope"
        ]);
        assert!(map_am_peer_dtos(2, &rows).is_empty());
        assert!(map_am_peer_dtos(2, &json!({})).is_empty());
    }
}
