use super::constants::{ROOM_ID_MAX_LEN, ROOM_INITIAL_ID};

pub fn normalize_placed_rack_room_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() || s == "main" {
        return ROOM_INITIAL_ID.to_string();
    }
    s.to_string()
}

/// `snapshot.ts` `ROOM_ID_PATTERN` = `/^[a-zA-Z0-9_.-]{1,120}$/`.
pub fn is_valid_calculator_room_scope_id(raw: &str) -> bool {
    let len = raw.len();
    if len < 1 || len > ROOM_ID_MAX_LEN {
        return false;
    }
    raw.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_scope_id_mirrors_node_pattern() {
        assert!(is_valid_calculator_room_scope_id("room_initial"));
        assert!(is_valid_calculator_room_scope_id("room_nft"));
        assert!(!is_valid_calculator_room_scope_id("sala com espaço!"));
        assert!(!is_valid_calculator_room_scope_id(""));
        assert!(!is_valid_calculator_room_scope_id(
            &"x".repeat(ROOM_ID_MAX_LEN + 1)
        ));
    }
}
