use super::constants::ROOM_INITIAL_ID;

pub fn normalize_placed_rack_room_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() || s == "main" {
        return ROOM_INITIAL_ID.to_string();
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_empty_and_main_to_initial() {
        assert_eq!(normalize_placed_rack_room_id(""), ROOM_INITIAL_ID);
        assert_eq!(normalize_placed_rack_room_id("main"), ROOM_INITIAL_ID);
        assert_eq!(normalize_placed_rack_room_id(" room_nft "), "room_nft");
    }
}
