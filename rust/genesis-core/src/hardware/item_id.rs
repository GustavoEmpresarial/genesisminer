//! Save-game item / instance id guard — 1:1 with `SAVE_GAME_ITEM_ID_RE` in `save-guard.ts`.
//! Rack / coin ids — 1:1 with Node `RACK_ID_RE` / `COIN_ID_RE` (`save-servers` / `room-coins`).

/// Max length of `SAVE_GAME_ITEM_ID_RE` `{1,200}`.
pub const SAVE_GAME_ITEM_ID_MAX_LEN: usize = 200;

/// Max length of Node `RACK_ID_RE` `{1,120}`.
pub const RACK_ID_MAX_LEN: usize = 120;
/// Max length of Node `COIN_ID_RE` `{1,120}` (same pattern as `RACK_ID_RE`).
pub const COIN_ID_MAX_LEN: usize = 120;

/// `^[a-zA-Z0-9_.-]{1,200}$`
pub fn is_valid_save_game_item_id(raw: &str) -> bool {
    is_ascii_id(raw, SAVE_GAME_ITEM_ID_MAX_LEN, false)
}

/// `^[a-zA-Z0-9_.:-]{1,120}$` — Node `RACK_ID_RE`.
pub fn is_valid_rack_id(raw: &str) -> bool {
    is_ascii_id(raw, RACK_ID_MAX_LEN, true)
}

/// `^[a-zA-Z0-9_.:-]{1,120}$` — Node `COIN_ID_RE`.
pub fn is_valid_coin_id(raw: &str) -> bool {
    is_ascii_id(raw, COIN_ID_MAX_LEN, true)
}

fn is_ascii_id(raw: &str, max_len: usize, allow_colon: bool) -> bool {
    let len = raw.len();
    if len < 1 || len > max_len {
        return false;
    }
    raw.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || b == b'_'
            || b == b'.'
            || b == b'-'
            || (allow_colon && b == b':')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_catalog_shaped_ids() {
        assert!(is_valid_save_game_item_id("gpu_rx6600"));
        assert!(is_valid_save_game_item_id("rack_a63"));
        assert!(is_valid_save_game_item_id(
            "merge_rack04_cores_uncommon_ab12cd"
        ));
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert!(!is_valid_save_game_item_id(""));
        let too_long = "a".repeat(SAVE_GAME_ITEM_ID_MAX_LEN + 1);
        assert!(!is_valid_save_game_item_id(&too_long));
    }

    #[test]
    fn rejects_illegal_chars() {
        assert!(!is_valid_save_game_item_id("gpu x"));
        assert!(!is_valid_save_game_item_id("gpu/x"));
    }

    #[test]
    fn rack_and_coin_id_match_node_regex() {
        assert!(is_valid_rack_id("rack_1"));
        assert!(is_valid_rack_id("a:b.c-d_1"));
        assert!(is_valid_coin_id("btc"));
        assert!(is_valid_coin_id("usdc_interno"));
        assert!(!is_valid_rack_id(""));
        assert!(!is_valid_rack_id("rack id"));
        assert!(!is_valid_coin_id("bad/coin"));
        let too_long = "a".repeat(RACK_ID_MAX_LEN + 1);
        assert!(!is_valid_rack_id(&too_long));
        assert!(!is_valid_coin_id(&too_long));
        assert_eq!(RACK_ID_MAX_LEN, COIN_ID_MAX_LEN);
    }
}
