//! Chat Socket.IO room name helpers — Node `chatRoomName` / `chatUserRoom`.

/// Node `CHAT_CHANNEL_GLOBAL`.
pub const CHAT_CHANNEL_GLOBAL: &str = "global";

const CHAT_ROOM_PREFIX: &str = "chat:";
const CHAT_USER_ROOM_PREFIX: &str = "chat:user:";

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
}
