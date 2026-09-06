//! Room / machine predicates used by rack intents.
//! Ported from `nft-room-mining.ts` + `room-kind.ts` (only the gates intent needs).

use crate::calculator::constants::{
    ASIC_ROOM_ID, NFT_AUTO_ALLOWED_CHASSIS_ID, NFT_AUTO_ROOM_ID, NFT_ROOM_EXCLUDED_MACHINE_IDS,
    ROOM_INITIAL_ID,
};
use crate::calculator::room_id::normalize_placed_rack_room_id;
use std::collections::HashSet;

pub use crate::calculator::constants::{
    ASIC_ROOM_ID as HARDWARE_ASIC_ROOM_ID, NFT_AUTO_ALLOWED_CHASSIS_ID as NFT_CHASSIS_ID,
    NFT_AUTO_ROOM_ID as HARDWARE_NFT_AUTO_ROOM_ID,
};

/// `standard` = common room; `nft` = NFT room (own rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomKind {
    Standard,
    Nft,
}

pub struct RoomRules {
    pub allowed_chassis_id: Option<&'static str>,
    pub asic_machines_only: bool,
    pub coin_comes_from_machine: bool,
}

pub const ROOM_KIND_RULES_STANDARD: RoomRules = RoomRules {
    allowed_chassis_id: None,
    asic_machines_only: false,
    coin_comes_from_machine: false,
};

pub const ROOM_KIND_RULES_NFT: RoomRules = RoomRules {
    allowed_chassis_id: Some(NFT_AUTO_ALLOWED_CHASSIS_ID),
    asic_machines_only: true,
    coin_comes_from_machine: true,
};

#[derive(Debug, Clone, Default)]
pub struct MachineUpgradeRef {
    pub id: String,
    pub type_name: String,
    pub category: String,
    pub nft_mining_coin_id: Option<String>,
}

pub fn default_nft_room_ids() -> HashSet<String> {
    let mut ids = HashSet::new();
    ids.insert(normalize_placed_rack_room_id(NFT_AUTO_ROOM_ID));
    ids
}

pub fn default_asic_room_ids() -> HashSet<String> {
    let mut ids = HashSet::new();
    ids.insert(normalize_placed_rack_room_id(ASIC_ROOM_ID));
    ids
}

pub fn is_nft_mining_room_id(room_id: &str, nft_room_ids: &HashSet<String>) -> bool {
    let id = normalize_placed_rack_room_id(room_id);
    nft_room_ids.contains(&id)
}

pub fn resolve_room_kind(room_id: &str, nft_room_ids: Option<&HashSet<String>>) -> RoomKind {
    let owned;
    let ids: &HashSet<String> = match nft_room_ids {
        Some(s) => s,
        None => {
            owned = default_nft_room_ids();
            // lifetime: we can't return ref to owned here — branch below
            return if is_nft_mining_room_id(room_id, &owned) {
                RoomKind::Nft
            } else {
                RoomKind::Standard
            };
        }
    };
    if is_nft_mining_room_id(room_id, ids) {
        RoomKind::Nft
    } else {
        RoomKind::Standard
    }
}

pub fn room_rules(room_id: &str, nft_room_ids: Option<&HashSet<String>>) -> RoomRules {
    match resolve_room_kind(room_id, nft_room_ids) {
        RoomKind::Nft => ROOM_KIND_RULES_NFT,
        RoomKind::Standard => ROOM_KIND_RULES_STANDARD,
    }
}

pub fn is_asic_mining_room_id(room_id: &str, asic_room_ids: Option<&HashSet<String>>) -> bool {
    let id = normalize_placed_rack_room_id(room_id);
    if let Some(ids) = asic_room_ids {
        if ids.contains(&id) {
            return true;
        }
    }
    id == normalize_placed_rack_room_id(ASIC_ROOM_ID)
}

/// Power ON: standard rooms need a selected coin; NFT/ASIC rooms take coin from the machine catalog.
pub fn rack_power_is_on(
    want_on: bool,
    coin_comes_from_machine: bool,
    has_selected_coin: bool,
) -> bool {
    want_on && (coin_comes_from_machine || has_selected_coin)
}

pub fn is_asic_machine_upgrade_row(up: &MachineUpgradeRef) -> bool {
    if up.type_name != "machine" {
        return false;
    }
    let id = up.id.trim().to_ascii_lowercase();
    if id.starts_with("asic_") {
        return true;
    }
    up.category.trim().to_ascii_lowercase().contains("asic")
}

pub fn is_nft_collectible_machine_row(up: &MachineUpgradeRef) -> bool {
    if up.type_name != "machine" {
        return false;
    }
    let id = up.id.trim().to_ascii_lowercase();
    if NFT_ROOM_EXCLUDED_MACHINE_IDS.iter().any(|x| *x == id) {
        return false;
    }
    if is_asic_machine_upgrade_row(up) {
        return false;
    }
    if id.starts_with("nft_") {
        return true;
    }
    up.category.trim().to_ascii_lowercase().contains("nft")
}

pub fn is_nft_room_catalog_machine_row(up: &MachineUpgradeRef) -> bool {
    is_asic_machine_upgrade_row(up) || is_nft_collectible_machine_row(up)
}

pub fn is_chassis_allowed_in_room(
    chassis_id: &str,
    room_id: &str,
    nft_room_ids: Option<&HashSet<String>>,
    asic_room_ids: Option<&HashSet<String>>,
) -> bool {
    let id = chassis_id.trim();
    let exclusive = ROOM_KIND_RULES_NFT.allowed_chassis_id.unwrap_or("");
    if resolve_room_kind(room_id, nft_room_ids) == RoomKind::Nft {
        return id == exclusive;
    }
    if id != exclusive {
        return true;
    }
    is_asic_mining_room_id(room_id, asic_room_ids)
}

pub fn normalize_room_id(raw: &str) -> String {
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
    fn asic_row_by_id_prefix_or_category() {
        assert!(is_asic_machine_upgrade_row(&MachineUpgradeRef {
            id: "asic_x1".into(),
            type_name: "machine".into(),
            category: String::new(),
            nft_mining_coin_id: None,
        }));
        assert!(is_asic_machine_upgrade_row(&MachineUpgradeRef {
            id: "gpu_x1".into(),
            type_name: "machine".into(),
            category: "asic-line".into(),
            nft_mining_coin_id: None,
        }));
        assert!(!is_asic_machine_upgrade_row(&MachineUpgradeRef {
            id: "gpu_x1".into(),
            type_name: "machine".into(),
            category: "gpu".into(),
            nft_mining_coin_id: None,
        }));
    }

    #[test]
    fn nft_collectible_excludes_real_asic() {
        assert!(!is_nft_collectible_machine_row(&MachineUpgradeRef {
            id: "asic_x1".into(),
            type_name: "machine".into(),
            category: String::new(),
            nft_mining_coin_id: None,
        }));
        assert!(is_nft_collectible_machine_row(&MachineUpgradeRef {
            id: "nft_pioneer".into(),
            type_name: "machine".into(),
            category: String::new(),
            nft_mining_coin_id: Some("gemt".into()),
        }));
    }

    #[test]
    fn rack_power_nft_on_without_selected_coin() {
        let coin_comes_from_machine = true;
        let has_selected_coin = false;
        assert!(rack_power_is_on(
            true,
            coin_comes_from_machine,
            has_selected_coin
        ));
    }

    #[test]
    fn rack_power_asic_on_without_selected_coin() {
        let coin_comes_from_machine = true;
        let has_selected_coin = false;
        assert!(rack_power_is_on(
            true,
            coin_comes_from_machine,
            has_selected_coin
        ));
    }

    #[test]
    fn rack_power_standard_requires_selected_coin() {
        let coin_comes_from_machine = false;
        assert!(!rack_power_is_on(true, coin_comes_from_machine, false));
        assert!(rack_power_is_on(true, coin_comes_from_machine, true));
    }

    #[test]
    fn rack_power_want_off_stays_off() {
        assert!(!rack_power_is_on(false, true, false));
        assert!(!rack_power_is_on(false, true, true));
        assert!(!rack_power_is_on(false, false, true));
    }

    #[test]
    fn chassis_h1_only_nft_or_asic_room() {
        assert!(is_chassis_allowed_in_room(
            NFT_AUTO_ALLOWED_CHASSIS_ID,
            NFT_AUTO_ROOM_ID,
            None,
            None
        ));
        assert!(!is_chassis_allowed_in_room(
            "rack04_cores",
            NFT_AUTO_ROOM_ID,
            None,
            None
        ));
        assert!(is_chassis_allowed_in_room(
            "rack04_cores",
            ROOM_INITIAL_ID,
            None,
            None
        ));
    }
}
