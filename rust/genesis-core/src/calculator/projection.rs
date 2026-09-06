use super::checkin_bonus::aggregate_hash_by_coin_with_checkin_bonus;
use super::constants::{
    DAY_MULTIPLIER, HOUR_MULTIPLIER, PROJECTION_DAYS_PER_MONTH, PROJECTION_DAYS_PER_WEEK,
    PROJECTION_DAYS_PER_YEAR,
};
use super::nft::is_nft_room_exclusive_mining_coin_ref_str;
use super::room_id::normalize_placed_rack_room_id;
use super::slot_credits::list_slot_mining_credits;
use super::types::{
    CalculatorRackInput, CalculatorUpgradeLite, CheckinHashEntry, ProjectionPeriod,
    SlotMiningCredit,
};
use crate::time::SECONDS_PER_DAY;
use std::collections::{HashMap, HashSet};

pub use crate::mining::{
    effective_network_hashrate_for_coin, network_hashrate_from_yield_per_hash,
};

fn build_upgrades_map_for_rack(
    rack: &CalculatorRackInput,
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
) -> HashMap<String, CalculatorUpgradeLite> {
    let mut map = HashMap::new();
    for sid in &rack.slots {
        let Some(sid) = sid.as_ref() else {
            continue;
        };
        if let Some(u) = upgrades_by_id.get(sid.as_str()) {
            map.insert(sid.clone(), u.clone());
        }
    }
    for sid in &rack.multiplier_slots {
        let Some(sid) = sid.as_ref() else {
            continue;
        };
        if let Some(u) = upgrades_by_id.get(sid.as_str()) {
            map.insert(sid.clone(), u.clone());
        }
    }
    if let Some(rid) = rack.item_id.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Some(u) = upgrades_by_id.get(rid.as_str()) {
            map.insert(rid.clone(), u.clone());
        }
    }
    map
}

fn rack_slot_credits(
    rack: &CalculatorRackInput,
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
) -> Vec<SlotMiningCredit> {
    let upgrades_map = build_upgrades_map_for_rack(rack, upgrades_by_id);
    let selected = rack
        .selected_coin_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    list_slot_mining_credits(
        rack.room_id.as_deref(),
        &rack.slots,
        &rack.multiplier_slots,
        &upgrades_map,
        selected,
        Some(nft_room_ids),
        rack.item_id.as_deref(),
        Some(asic_room_ids),
    )
}

fn rack_matches_scope(rack: &CalculatorRackInput, scope_room: &str) -> bool {
    if scope_room == "total" {
        return true;
    }
    normalize_placed_rack_room_id(rack.room_id.as_deref().unwrap_or(""))
        == normalize_placed_rack_room_id(scope_room)
}

fn is_operational_rack(rack: &CalculatorRackInput) -> bool {
    rack.is_on
        && rack
            .wiring_id
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        && rack
            .battery_id
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

pub fn compute_user_hash_by_coin_id(
    racks: &[CalculatorRackInput],
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
    scope_room: &str,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for rack in racks {
        if !rack_matches_scope(rack, scope_room) || !is_operational_rack(rack) {
            continue;
        }
        for sc in rack_slot_credits(rack, upgrades_by_id, nft_room_ids, asic_room_ids) {
            *out.entry(sc.coin_id).or_insert(0.0) += sc.effective_base_prod;
        }
    }
    out
}

fn collect_operational_hash_entries(
    racks: &[CalculatorRackInput],
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
    scope_room: &str,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
) -> Vec<CheckinHashEntry> {
    let mut entries = Vec::new();
    for rack in racks {
        if !rack_matches_scope(rack, scope_room) || !is_operational_rack(rack) {
            continue;
        }
        for sc in rack_slot_credits(rack, upgrades_by_id, nft_room_ids, asic_room_ids) {
            if !sc.effective_base_prod.is_finite() || sc.effective_base_prod <= 0.0 {
                continue;
            }
            entries.push(CheckinHashEntry {
                coin_id: sc.coin_id,
                room_id: rack.room_id.clone(),
                base_hps: sc.effective_base_prod,
                counts_toward_general_power: sc.counts_toward_general_power,
            });
        }
    }
    entries
}

pub fn compute_user_hash_by_coin_id_with_checkin_bonus(
    racks: &[CalculatorRackInput],
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
    scope_room: &str,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
    bonus_hps: f64,
) -> HashMap<String, f64> {
    let bonus = bonus_hps;
    let entries = collect_operational_hash_entries(
        racks,
        upgrades_by_id,
        scope_room,
        nft_room_ids,
        asic_room_ids,
    );
    if !bonus.is_finite() || bonus <= 0.0 {
        return compute_user_hash_by_coin_id(
            racks,
            upgrades_by_id,
            scope_room,
            nft_room_ids,
            asic_room_ids,
        );
    }
    aggregate_hash_by_coin_with_checkin_bonus(&entries, bonus, nft_room_ids, Some(asic_room_ids))
}

pub fn compute_general_power_hps(
    racks: &[CalculatorRackInput],
    upgrades_by_id: &HashMap<String, CalculatorUpgradeLite>,
    scope_room: &str,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
) -> f64 {
    let mut total = 0.0;
    for rack in racks {
        if !rack_matches_scope(rack, scope_room) || !is_operational_rack(rack) {
            continue;
        }
        for sc in rack_slot_credits(rack, upgrades_by_id, nft_room_ids, asic_room_ids) {
            if !sc.counts_toward_general_power {
                continue;
            }
            if is_nft_room_exclusive_mining_coin_ref_str(&sc.coin_id) {
                continue;
            }
            total += sc.effective_base_prod;
        }
    }
    total
}

pub fn compute_daily_earnings(
    user_hash_hps: f64,
    block_time_sec: f64,
    effective_network_hash: f64,
    block_reward: f64,
    price_usd: f64,
) -> (f64, f64) {
    if !block_time_sec.is_finite()
        || block_time_sec <= 0.0
        || !effective_network_hash.is_finite()
        || effective_network_hash <= 0.0
    {
        return (0.0, 0.0);
    }
    let uh = user_hash_hps;
    if !uh.is_finite() || uh < 0.0 {
        return (0.0, 0.0);
    }
    let share = uh / effective_network_hash;
    let blocks_per_day = SECONDS_PER_DAY as f64 / block_time_sec;
    let br = if block_reward.is_finite() {
        block_reward
    } else {
        0.0
    };
    let daily_coins = share * br * blocks_per_day;
    let pu = if price_usd.is_finite() {
        price_usd
    } else {
        0.0
    };
    let daily_usd = daily_coins * pu;
    (daily_coins, daily_usd)
}

pub fn calculator_projection_periods() -> Vec<ProjectionPeriod> {
    vec![
        ProjectionPeriod {
            label: "1 Hora",
            multiplier: HOUR_MULTIPLIER,
        },
        ProjectionPeriod {
            label: "24 Horas",
            multiplier: DAY_MULTIPLIER,
        },
        ProjectionPeriod {
            label: "7 Dias",
            multiplier: PROJECTION_DAYS_PER_WEEK,
        },
        ProjectionPeriod {
            label: "30 Dias",
            multiplier: PROJECTION_DAYS_PER_MONTH,
        },
        ProjectionPeriod {
            label: "1 Ano",
            multiplier: PROJECTION_DAYS_PER_YEAR,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calculator::constants::NFT_AUTO_ROOM_ID;

    #[test]
    fn effective_network_uses_max_runtime_floor() {
        let mut runtime = HashMap::new();
        runtime.insert("btc".into(), 1e12);
        assert_eq!(
            effective_network_hashrate_for_coin("btc", 100.0, &runtime, &HashMap::new(), false),
            1e12
        );
        runtime.insert("btc".into(), 100.0);
        assert_eq!(
            effective_network_hashrate_for_coin("btc", 1e12, &runtime, &HashMap::new(), false),
            1e12
        );
    }

    #[test]
    fn effective_network_floor_when_runtime_absent() {
        assert_eq!(
            effective_network_hashrate_for_coin(
                "x",
                500.0,
                &HashMap::new(),
                &HashMap::new(),
                false
            ),
            500.0
        );
    }

    #[test]
    fn effective_network_implied_when_runtime_empty() {
        let mut implied = HashMap::new();
        implied.insert("pol".into(), 9_000.0);
        assert_eq!(
            effective_network_hashrate_for_coin("pol", 100.0, &HashMap::new(), &implied, false),
            9_000.0
        );
    }

    #[test]
    fn independent_pool_floor_only_ignores_live_and_implied() {
        let mut runtime = HashMap::new();
        runtime.insert("gemt".into(), 5_216.0);
        let mut implied = HashMap::new();
        implied.insert("gemt".into(), 4_869.0);
        assert_eq!(
            effective_network_hashrate_for_coin("gemt", 965.0, &runtime, &implied, true),
            965.0
        );
        assert_eq!(
            effective_network_hashrate_for_coin("gemt", 965.0, &HashMap::new(), &implied, true),
            965.0
        );
    }

    #[test]
    fn effective_network_minimum_one() {
        assert_eq!(
            effective_network_hashrate_for_coin("x", 0.0, &HashMap::new(), &HashMap::new(), false),
            1.0
        );
    }

    #[test]
    fn network_from_yield_per_hash() {
        assert!((network_hashrate_from_yield_per_hash(0.0001, 6.0, 60.0) - 1000.0).abs() < 1e-3);
    }

    #[test]
    fn daily_earnings_proportional() {
        let (daily_coins, daily_usd) = compute_daily_earnings(100.0, 600.0, 1000.0, 1.0, 2.0);
        assert!(daily_coins > 0.0);
        assert!((daily_usd - daily_coins * 2.0).abs() < 1e-6);
    }

    #[test]
    fn daily_earnings_zero_invalid_network() {
        assert_eq!(
            compute_daily_earnings(100.0, 0.0, 1000.0, 1.0, 2.0),
            (0.0, 0.0)
        );
        assert_eq!(
            compute_daily_earnings(100.0, 600.0, 0.0, 1.0, 2.0),
            (0.0, 0.0)
        );
    }

    #[test]
    fn daily_earnings_zero_negative_hash() {
        assert_eq!(
            compute_daily_earnings(-1.0, 600.0, 1000.0, 1.0, 2.0),
            (0.0, 0.0)
        );
    }

    fn sample_upgrade(id: &str, bp: f64) -> CalculatorUpgradeLite {
        CalculatorUpgradeLite {
            id: id.to_string(),
            upgrade_type: "machine".into(),
            category: None,
            base_production: bp,
            multiplier: None,
            power_capacity: None,
            nft_mining_coin_id: None,
        }
    }

    #[test]
    fn user_hash_sums_operational_rig() {
        let mut up = HashMap::new();
        up.insert(
            "bat".into(),
            CalculatorUpgradeLite {
                id: "bat".into(),
                upgrade_type: "battery".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: Some(-1.0),
                nft_mining_coin_id: None,
            },
        );
        up.insert(
            "wire".into(),
            CalculatorUpgradeLite {
                id: "wire".into(),
                upgrade_type: "wiring".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: None,
            },
        );
        up.insert("gpu".into(), sample_upgrade("gpu", 10.0));
        let racks = vec![CalculatorRackInput {
            item_id: None,
            room_id: Some("room_initial".into()),
            wiring_id: Some("wire".into()),
            battery_id: Some("bat".into()),
            battery_catalog_item_id: None,
            is_on: true,
            selected_coin_id: Some("c1".into()),
            slots: vec![Some("gpu".into()), None],
            multiplier_slots: vec![],
        }];
        let nft = HashSet::new();
        let asic = HashSet::new();
        let by = compute_user_hash_by_coin_id(&racks, &up, "total", &nft, &asic);
        assert_eq!(by.get("c1").copied(), Some(10.0));
    }

    #[test]
    fn user_hash_ignores_inoperational() {
        let mut up = HashMap::new();
        up.insert("gpu".into(), sample_upgrade("gpu", 10.0));
        let racks = vec![
            CalculatorRackInput {
                item_id: None,
                room_id: Some("room_initial".into()),
                wiring_id: None,
                battery_id: None,
                battery_catalog_item_id: None,
                is_on: true,
                selected_coin_id: Some("c1".into()),
                slots: vec![Some("gpu".into())],
                multiplier_slots: vec![],
            },
            CalculatorRackInput {
                item_id: None,
                room_id: Some("room_initial".into()),
                wiring_id: Some("wire".into()),
                battery_id: Some("bat".into()),
                battery_catalog_item_id: None,
                is_on: false,
                selected_coin_id: Some("c1".into()),
                slots: vec![Some("gpu".into())],
                multiplier_slots: vec![],
            },
        ];
        let nft = HashSet::new();
        let asic = HashSet::new();
        assert!(compute_user_hash_by_coin_id(&racks, &up, "total", &nft, &asic).is_empty());
    }

    #[test]
    fn user_hash_filters_scope() {
        let mut up = HashMap::new();
        up.insert(
            "bat".into(),
            CalculatorUpgradeLite {
                id: "bat".into(),
                upgrade_type: "battery".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: Some(-1.0),
                nft_mining_coin_id: None,
            },
        );
        up.insert(
            "wire".into(),
            CalculatorUpgradeLite {
                id: "wire".into(),
                upgrade_type: "wiring".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: None,
            },
        );
        up.insert("gpu".into(), sample_upgrade("gpu", 10.0));
        let racks = vec![
            CalculatorRackInput {
                item_id: None,
                room_id: Some("room_a".into()),
                wiring_id: Some("wire".into()),
                battery_id: Some("bat".into()),
                battery_catalog_item_id: None,
                is_on: true,
                selected_coin_id: Some("c1".into()),
                slots: vec![Some("gpu".into())],
                multiplier_slots: vec![],
            },
            CalculatorRackInput {
                item_id: None,
                room_id: Some("room_b".into()),
                wiring_id: Some("wire".into()),
                battery_id: Some("bat".into()),
                battery_catalog_item_id: None,
                is_on: true,
                selected_coin_id: Some("c1".into()),
                slots: vec![Some("gpu".into())],
                multiplier_slots: vec![],
            },
        ];
        let nft = HashSet::new();
        let asic = HashSet::new();
        let by = compute_user_hash_by_coin_id(&racks, &up, "room_a", &nft, &asic);
        assert_eq!(by.get("c1").copied(), Some(10.0));
    }

    #[test]
    fn general_power_excludes_nft_room() {
        let mut up = HashMap::new();
        up.insert(
            "bat".into(),
            CalculatorUpgradeLite {
                id: "bat".into(),
                upgrade_type: "battery".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: Some(-1.0),
                nft_mining_coin_id: None,
            },
        );
        up.insert(
            "wire".into(),
            CalculatorUpgradeLite {
                id: "wire".into(),
                upgrade_type: "wiring".into(),
                category: None,
                base_production: 0.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: None,
            },
        );
        up.insert("gpu".into(), sample_upgrade("gpu", 100.0));
        up.insert(
            "asic".into(),
            CalculatorUpgradeLite {
                id: "asic_s9".into(),
                upgrade_type: "machine".into(),
                category: None,
                base_production: 500.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: Some("usdt".into()),
            },
        );
        let mut nft = HashSet::new();
        nft.insert(NFT_AUTO_ROOM_ID.to_string());
        let asic = HashSet::new();
        let racks = vec![
            CalculatorRackInput {
                item_id: None,
                room_id: Some("room_initial".into()),
                wiring_id: Some("wire".into()),
                battery_id: Some("bat".into()),
                battery_catalog_item_id: None,
                is_on: true,
                selected_coin_id: Some("bnb".into()),
                slots: vec![Some("gpu".into())],
                multiplier_slots: vec![],
            },
            CalculatorRackInput {
                item_id: None,
                room_id: Some(NFT_AUTO_ROOM_ID.into()),
                wiring_id: Some("wire".into()),
                battery_id: Some("bat".into()),
                battery_catalog_item_id: None,
                is_on: true,
                selected_coin_id: Some("bnb".into()),
                slots: vec![Some("asic".into())],
                multiplier_slots: vec![],
            },
        ];
        assert_eq!(
            compute_general_power_hps(&racks, &up, "total", &nft, &asic),
            100.0
        );
    }
}
