use super::constants::NFT_AUTO_ALLOWED_CHASSIS_ID;
use super::nft::{
    is_asic_room_for_mining_credits, is_nft_auto_room_id, is_nft_collectible_machine,
    is_nft_mining_room_id, is_nft_room_exclusive_mining_coin_ref_str,
    slot_counts_toward_general_power_for_upgrade,
};
use super::types::{CalculatorUpgradeLite, SlotMiningCredit};
use std::collections::{HashMap, HashSet};

pub fn rack_multiplier_factor(
    multiplier_slots: &[Option<String>],
    upgrades_map: &HashMap<String, CalculatorUpgradeLite>,
    rack_item_id: Option<&str>,
) -> f64 {
    let mut mult = 1.0;
    for sid in multiplier_slots {
        let Some(sid) = sid.as_ref() else {
            continue;
        };
        let Some(up) = upgrades_map.get(sid.as_str()) else {
            continue;
        };
        if let Some(m) = up.multiplier {
            if m.is_finite() {
                mult += m;
            }
        }
    }
    if let Some(rid) = rack_item_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(rack_up) = upgrades_map.get(rid) {
            if rack_up.upgrade_type == "infrastructure" {
                if let Some(m) = rack_up.multiplier {
                    if m.is_finite() && m > 0.0 {
                        mult += m;
                    }
                }
            }
        }
    }
    mult
}

fn nft_mining_coin_id_from_upgrade(up: &CalculatorUpgradeLite) -> Option<&str> {
    up.nft_mining_coin_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

pub fn list_slot_mining_credits(
    room_id: Option<&str>,
    slots: &[Option<String>],
    multiplier_slots: &[Option<String>],
    upgrades_map: &HashMap<String, CalculatorUpgradeLite>,
    rack_selected_coin_id: &str,
    nft_room_ids: Option<&HashSet<String>>,
    rack_item_id: Option<&str>,
    asic_room_ids: Option<&HashSet<String>>,
) -> Vec<SlotMiningCredit> {
    let mult = rack_multiplier_factor(multiplier_slots, upgrades_map, rack_item_id);
    let is_nft_room = match nft_room_ids {
        Some(ids) => is_nft_mining_room_id(room_id, ids),
        None => is_nft_auto_room_id(room_id),
    };
    let is_asic_room = is_asic_room_for_mining_credits(room_id, asic_room_ids);
    let chassis = rack_item_id.map(str::trim).unwrap_or("");

    if !is_nft_room && !is_asic_room && chassis == NFT_AUTO_ALLOWED_CHASSIS_ID {
        return vec![];
    }

    if !is_nft_room {
        let mut fixed_credits = Vec::new();
        let mut general_base = 0.0;
        let mut special_base = 0.0;

        for sid in slots {
            let Some(sid) = sid.as_ref() else {
                continue;
            };
            let Some(up) = upgrades_map.get(sid.as_str()) else {
                continue;
            };
            let bp = up.base_production;
            if !bp.is_finite() || bp <= 0.0 {
                continue;
            }

            if up.upgrade_type == "machine" {
                if let Some(fixed_coin_id) = nft_mining_coin_id_from_upgrade(up) {
                    fixed_credits.push(SlotMiningCredit {
                        coin_id: fixed_coin_id.to_string(),
                        effective_base_prod: bp * mult,
                        counts_toward_general_power: if is_asic_room {
                            false
                        } else {
                            slot_counts_toward_general_power_for_upgrade(up)
                        },
                    });
                    continue;
                }
            }

            if !is_asic_room && slot_counts_toward_general_power_for_upgrade(up) {
                general_base += bp;
            } else {
                special_base += bp;
            }
        }

        let cid = rack_selected_coin_id.trim();
        let mut selected_coin_credits = Vec::new();
        if !cid.is_empty() && !is_nft_room_exclusive_mining_coin_ref_str(cid) {
            if general_base > 0.0 {
                selected_coin_credits.push(SlotMiningCredit {
                    coin_id: cid.to_string(),
                    effective_base_prod: general_base * mult,
                    counts_toward_general_power: true,
                });
            }
            if special_base > 0.0 {
                selected_coin_credits.push(SlotMiningCredit {
                    coin_id: cid.to_string(),
                    effective_base_prod: special_base * mult,
                    counts_toward_general_power: false,
                });
            }
        }
        fixed_credits.extend(selected_coin_credits);
        return fixed_credits;
    }

    let mut out = Vec::new();
    for sid in slots {
        let Some(sid) = sid.as_ref() else {
            continue;
        };
        let Some(up) = upgrades_map.get(sid.as_str()) else {
            continue;
        };
        if !is_nft_collectible_machine(&up.upgrade_type, &up.id, up.category.as_deref()) {
            continue;
        }
        let Some(coin_id) = nft_mining_coin_id_from_upgrade(up) else {
            continue;
        };
        let bp = up.base_production;
        if !bp.is_finite() || bp <= 0.0 {
            continue;
        }
        out.push(SlotMiningCredit {
            coin_id: coin_id.to_string(),
            effective_base_prod: bp * mult,
            counts_toward_general_power: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upgrade(
        id: &str,
        ty: &str,
        bp: f64,
        mult: Option<f64>,
        nft_coin: Option<&str>,
    ) -> CalculatorUpgradeLite {
        CalculatorUpgradeLite {
            id: id.to_string(),
            upgrade_type: ty.to_string(),
            category: None,
            base_production: bp,
            multiplier: mult,
            power_capacity: None,
            nft_mining_coin_id: nft_coin.map(String::from),
        }
    }

    #[test]
    fn normal_room_credits_selected_coin() {
        let mut map = HashMap::new();
        map.insert("gpu".into(), upgrade("gpu", "machine", 10.0, None, None));
        let credits = list_slot_mining_credits(
            Some("room_initial"),
            &[Some("gpu".into()), None],
            &[],
            &map,
            "bnb",
            None,
            None,
            None,
        );
        assert_eq!(credits.len(), 1);
        assert_eq!(credits[0].coin_id, "bnb");
        assert_eq!(credits[0].effective_base_prod, 10.0);
        assert!(credits[0].counts_toward_general_power);
    }

    #[test]
    fn nft_chassis_outside_special_rooms_yields_nothing() {
        let mut map = HashMap::new();
        map.insert(
            "asic".into(),
            upgrade("asic_s9", "machine", 500.0, None, Some("usdt")),
        );
        let credits = list_slot_mining_credits(
            Some("room_initial"),
            &[Some("asic".into())],
            &[],
            &map,
            "bnb",
            None,
            Some(NFT_AUTO_ALLOWED_CHASSIS_ID),
            None,
        );
        assert!(credits.is_empty());
    }

    #[test]
    fn nft_room_credits_per_collectible_coin() {
        use super::super::constants::NFT_AUTO_ROOM_ID;
        let mut map = HashMap::new();
        map.insert(
            "nft1".into(),
            CalculatorUpgradeLite {
                id: "nft_miner_1".into(),
                upgrade_type: "machine".into(),
                category: Some("nft".into()),
                base_production: 500.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: Some("gemt".into()),
            },
        );
        let mut nft_ids = HashSet::new();
        nft_ids.insert(NFT_AUTO_ROOM_ID.to_string());
        let credits = list_slot_mining_credits(
            Some(NFT_AUTO_ROOM_ID),
            &[Some("nft1".into())],
            &[],
            &map,
            "bnb",
            Some(&nft_ids),
            None,
            None,
        );
        assert_eq!(credits.len(), 1);
        assert_eq!(credits[0].coin_id, "gemt");
        assert!(!credits[0].counts_toward_general_power);
    }
}
