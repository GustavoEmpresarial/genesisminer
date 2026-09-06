use super::constants::PROJECTION_30D_DAYS;
use super::nft::{
    is_independent_network_pool_mining_coin_ref, is_nft_room_exclusive_mining_coin_ref,
    resolve_mining_coin_usd_rate,
};
use super::projection::{
    calculator_projection_periods, compute_daily_earnings, compute_general_power_hps,
    compute_user_hash_by_coin_id, compute_user_hash_by_coin_id_with_checkin_bonus,
    effective_network_hashrate_for_coin,
};
use super::types::{
    BlockHistoryEntry, CalculatorComputeInput, PlayerCalculatorCoinComparison,
    PlayerCalculatorCoinPayload, PlayerCalculatorCoinRow, PlayerCalculatorSnapshot,
};
use std::collections::{HashMap, HashSet};

fn build_coin_comparison_rows(daily_coins: f64, daily_usd: f64) -> Vec<PlayerCalculatorCoinRow> {
    calculator_projection_periods()
        .into_iter()
        .map(|p| PlayerCalculatorCoinRow {
            label: p.label.to_string(),
            coins: daily_coins * p.multiplier,
            usd: daily_usd * p.multiplier,
        })
        .collect()
}

pub fn compute_snapshot(input: &CalculatorComputeInput) -> PlayerCalculatorSnapshot {
    let nft_room_ids: HashSet<String> = input.nft_room_ids.iter().cloned().collect();
    let asic_room_ids: HashSet<String> = input.asic_room_ids.iter().cloned().collect();
    let scope = input.scope.clone();

    let checkin_bonus_hps = if input.checkin_frozen {
        0.0
    } else {
        input.checkin_bonus_hps.max(0.0)
    };

    let power_by_coin_raw = if input.checkin_frozen {
        HashMap::new()
    } else {
        compute_user_hash_by_coin_id(
            &input.racks,
            &input.upgrades_by_id,
            &scope,
            &nft_room_ids,
            &asic_room_ids,
        )
    };

    let power_by_coin = if input.checkin_frozen {
        power_by_coin_raw.clone()
    } else {
        compute_user_hash_by_coin_id_with_checkin_bonus(
            &input.racks,
            &input.upgrades_by_id,
            &scope,
            &nft_room_ids,
            &asic_room_ids,
            checkin_bonus_hps,
        )
    };

    let general_power_hps = if input.checkin_frozen {
        0.0
    } else {
        compute_general_power_hps(
            &input.racks,
            &input.upgrades_by_id,
            &scope,
            &nft_room_ids,
            &asic_room_ids,
        ) + checkin_bonus_hps
    };

    let mut block_history_by_coin: HashMap<String, Vec<BlockHistoryEntry>> = HashMap::new();
    for row in &input.block_history_rows {
        let coin_id = row.coin_id.trim();
        if coin_id.is_empty() {
            continue;
        }
        let room_id = row
            .room_id
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from);
        block_history_by_coin
            .entry(coin_id.to_string())
            .or_default()
            .push(BlockHistoryEntry {
                id: row.id.clone(),
                room_id,
                window_start_ms: row.window_start_ms,
                window_end_ms: row.window_end_ms,
                credited_blocks: row.credit_blocks.max(1.0),
                amount_coins: row.amount_coins,
                amount_usd: row.amount_usd,
                user_hash_hps: row.user_hash_hps,
                network_hashrate: row.network_hashrate,
                block_reward: row.block_reward,
                block_time: row.block_time,
            });
    }

    let coins: Vec<PlayerCalculatorCoinPayload> = input
        .coins
        .iter()
        .map(|c| {
            let id = c.id.clone();
            let exclusive = is_nft_room_exclusive_mining_coin_ref(c);
            let independent_pool = is_independent_network_pool_mining_coin_ref(c);
            let user_power_hps = if exclusive {
                *power_by_coin_raw.get(&id).unwrap_or(&0.0)
            } else {
                *power_by_coin.get(&id).unwrap_or(&0.0)
            };
            let net_eff = effective_network_hashrate_for_coin(
                &id,
                c.network_hashrate,
                &input.runtime_network_by_coin,
                &input.implied_network_by_coin,
                independent_pool,
            );
            let block_time = c.block_time;
            let block_reward = c.block_reward;
            let price_usd = resolve_mining_coin_usd_rate(c);
            let (daily_coins, daily_usd) = compute_daily_earnings(
                user_power_hps,
                block_time,
                net_eff,
                block_reward,
                price_usd,
            );
            let rows = build_coin_comparison_rows(daily_coins, daily_usd);
            let symbol = if c.symbol.trim().is_empty() {
                c.name.clone()
            } else {
                c.symbol.clone()
            };
            let name = if c.name.trim().is_empty() {
                id.clone()
            } else {
                c.name.clone()
            };
            PlayerCalculatorCoinPayload {
                id: id.clone(),
                symbol,
                name,
                price_usd,
                network_hashrate: net_eff,
                block_reward,
                block_time,
                user_power_hps,
                daily_coins,
                daily_usd,
                projection30_usd: daily_usd * PROJECTION_30D_DAYS,
                nft_room_only: exclusive,
                independent_pool,
                rows,
                block_history: block_history_by_coin.remove(&id).unwrap_or_default(),
            }
        })
        .collect();

    let mut coin_comparisons: Vec<PlayerCalculatorCoinComparison> = input
        .coins
        .iter()
        .filter(|c| !is_independent_network_pool_mining_coin_ref(c))
        .map(|c| {
            let id = c.id.clone();
            let net_eff = effective_network_hashrate_for_coin(
                &id,
                c.network_hashrate,
                &input.runtime_network_by_coin,
                &input.implied_network_by_coin,
                false,
            );
            let block_time = c.block_time;
            let block_reward = c.block_reward;
            let price_usd = resolve_mining_coin_usd_rate(c);
            let (daily_coins, daily_usd) = compute_daily_earnings(
                general_power_hps,
                block_time,
                net_eff,
                block_reward,
                price_usd,
            );
            let symbol = if c.symbol.trim().is_empty() {
                c.name.clone()
            } else {
                c.symbol.clone()
            };
            let name = if c.name.trim().is_empty() {
                id.clone()
            } else {
                c.name.clone()
            };
            PlayerCalculatorCoinComparison {
                id: id.clone(),
                symbol,
                name,
                price_usd,
                is_actively_mining: power_by_coin_raw.get(&id).copied().unwrap_or(0.0) > 0.0,
                daily_coins,
                daily_usd,
                projection30_usd: daily_usd * PROJECTION_30D_DAYS,
                rows: build_coin_comparison_rows(daily_coins, daily_usd),
            }
        })
        .collect();

    coin_comparisons.sort_by(|a, b| {
        if a.is_actively_mining != b.is_actively_mining {
            return if a.is_actively_mining {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        b.daily_usd
            .partial_cmp(&a.daily_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    PlayerCalculatorSnapshot {
        scope,
        scopes_ui: input.scopes_ui.clone(),
        general_power_hps,
        coin_comparisons,
        coins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calculator::projection::compute_daily_earnings;
    use crate::calculator::types::{
        CalculatorRackInput, CalculatorUpgradeLite, MiningCoinInput, ScopeOption,
    };

    fn coin(id: &str, sym: &str) -> MiningCoinInput {
        MiningCoinInput {
            id: id.into(),
            symbol: sym.into(),
            name: sym.into(),
            network_hashrate: 1000.0,
            block_reward: 1.0,
            block_time: 600.0,
            price_usd: 2.0,
            usdc_rate: 0.0,
            nft_room_only: false,
        }
    }

    #[test]
    fn snapshot_empty_racks_yields_zero_power() {
        let input = CalculatorComputeInput {
            scope: "total".into(),
            scopes_ui: vec![ScopeOption {
                id: "total".into(),
                name: "Poder Total".into(),
            }],
            checkin_frozen: false,
            checkin_bonus_hps: 0.0,
            racks: vec![],
            upgrades_by_id: HashMap::new(),
            coins: vec![coin("c1", "C1")],
            nft_room_ids: vec![],
            asic_room_ids: vec![],
            runtime_network_by_coin: HashMap::new(),
            implied_network_by_coin: HashMap::new(),
            block_history_rows: vec![],
        };
        let snap = compute_snapshot(&input);
        assert_eq!(snap.general_power_hps, 0.0);
        assert_eq!(snap.coins[0].user_power_hps, 0.0);
        assert_eq!(snap.coins[0].daily_coins, 0.0);
    }

    #[test]
    fn snapshot_coin_comparisons_sort_active_first() {
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
        up.insert(
            "gpu".into(),
            CalculatorUpgradeLite {
                id: "gpu".into(),
                upgrade_type: "machine".into(),
                category: None,
                base_production: 100.0,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: None,
            },
        );
        let racks = vec![CalculatorRackInput {
            item_id: None,
            room_id: Some("room_initial".into()),
            wiring_id: Some("wire".into()),
            battery_id: Some("bat".into()),
            battery_catalog_item_id: None,
            is_on: true,
            selected_coin_id: Some("c1".into()),
            slots: vec![Some("gpu".into())],
            multiplier_slots: vec![],
        }];
        let input = CalculatorComputeInput {
            scope: "total".into(),
            scopes_ui: vec![],
            checkin_frozen: false,
            checkin_bonus_hps: 0.0,
            racks,
            upgrades_by_id: up,
            coins: vec![coin("c1", "C1"), coin("c2", "C2")],
            nft_room_ids: vec![],
            asic_room_ids: vec![],
            runtime_network_by_coin: HashMap::new(),
            implied_network_by_coin: HashMap::new(),
            block_history_rows: vec![],
        };
        let snap = compute_snapshot(&input);
        assert!(snap.coin_comparisons[0].is_actively_mining);
        assert_eq!(snap.coin_comparisons[0].id, "c1");
    }

    fn operational_rack_with_machine(
        room_id: &str,
        selected_coin: &str,
        machine_id: &str,
    ) -> CalculatorRackInput {
        CalculatorRackInput {
            item_id: None,
            room_id: Some(room_id.into()),
            wiring_id: Some("wire".into()),
            battery_id: Some("bat".into()),
            battery_catalog_item_id: None,
            is_on: true,
            selected_coin_id: Some(selected_coin.into()),
            slots: vec![Some(machine_id.into())],
            multiplier_slots: vec![],
        }
    }

    fn wire_bat_machine(
        machine_id: &str,
        base: f64,
        nft_coin: Option<&str>,
    ) -> HashMap<String, CalculatorUpgradeLite> {
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
        up.insert(
            machine_id.into(),
            CalculatorUpgradeLite {
                id: machine_id.into(),
                upgrade_type: "machine".into(),
                category: None,
                base_production: base,
                multiplier: None,
                power_capacity: None,
                nft_mining_coin_id: nft_coin.map(String::from),
            },
        );
        up
    }

    fn independent_net_input(
        coin: MiningCoinInput,
        racks: Vec<CalculatorRackInput>,
        upgrades: HashMap<String, CalculatorUpgradeLite>,
        live: Option<f64>,
    ) -> CalculatorComputeInput {
        let mut runtime = HashMap::new();
        let mut implied = HashMap::new();
        if let Some(live_hps) = live {
            runtime.insert(coin.id.clone(), live_hps);
            implied.insert(coin.id.clone(), live_hps);
        }
        CalculatorComputeInput {
            scope: "total".into(),
            scopes_ui: vec![],
            checkin_frozen: false,
            checkin_bonus_hps: 0.0,
            racks,
            upgrades_by_id: upgrades,
            coins: vec![coin],
            nft_room_ids: vec![],
            asic_room_ids: vec![],
            runtime_network_by_coin: runtime,
            implied_network_by_coin: implied,
            block_history_rows: vec![],
        }
    }

    fn assert_independent_net(snap: &PlayerCalculatorSnapshot, net: f64, user_hps: f64) {
        assert_eq!(snap.coins.len(), 1);
        let c = &snap.coins[0];
        assert!(c.independent_pool);
        assert_eq!(c.network_hashrate, net);
        assert_eq!(c.user_power_hps, user_hps);
        let (expect_coins, expect_usd) =
            compute_daily_earnings(user_hps, c.block_time, net, c.block_reward, c.price_usd);
        assert!((c.daily_coins - expect_coins).abs() < 1e-9);
        assert!((c.daily_usd - expect_usd).abs() < 1e-9);
        assert!(snap.coin_comparisons.is_empty());
    }

    #[test]
    fn gho_independent_uses_admin_floor_only() {
        let floor = 965.0;
        let live = 178.0;
        let user_hps = 100.0;
        let coin = MiningCoinInput {
            id: "GHO".into(),
            symbol: "GHO".into(),
            name: "GHO".into(),
            network_hashrate: floor,
            block_reward: 1.0,
            block_time: 600.0,
            price_usd: 2.0,
            usdc_rate: 0.0,
            nft_room_only: false,
        };
        let snap = compute_snapshot(&independent_net_input(
            coin,
            vec![operational_rack_with_machine(
                "room_initial",
                "bnb",
                "asic_gho",
            )],
            wire_bat_machine("asic_gho", user_hps, Some("GHO")),
            Some(live),
        ));
        assert_independent_net(&snap, floor, user_hps);
    }

    #[test]
    fn gho_independent_floor_when_live_absent() {
        let floor = 965.0;
        let user_hps = 100.0;
        let coin = MiningCoinInput {
            id: "GHO".into(),
            symbol: "GHO".into(),
            name: "GHO".into(),
            network_hashrate: floor,
            block_reward: 1.0,
            block_time: 600.0,
            price_usd: 2.0,
            usdc_rate: 0.0,
            nft_room_only: false,
        };
        let snap = compute_snapshot(&independent_net_input(
            coin,
            vec![operational_rack_with_machine(
                "room_initial",
                "bnb",
                "asic_gho",
            )],
            wire_bat_machine("asic_gho", user_hps, Some("GHO")),
            None,
        ));
        assert_independent_net(&snap, floor, user_hps);
    }

    #[test]
    fn gho_nft_independent_uses_admin_floor_only() {
        let floor = 500.0;
        let live = 9e15;
        let user_hps = 80.0;
        let coin = MiningCoinInput {
            id: "GHO_nft".into(),
            symbol: "GHO".into(),
            name: "GHO NFT".into(),
            network_hashrate: floor,
            block_reward: 1.0,
            block_time: 600.0,
            price_usd: 1.0,
            usdc_rate: 0.0,
            nft_room_only: true,
        };
        let snap = compute_snapshot(&independent_net_input(
            coin,
            vec![operational_rack_with_machine(
                "room_initial",
                "bnb",
                "asic_gho_nft",
            )],
            wire_bat_machine("asic_gho_nft", user_hps, Some("GHO_nft")),
            Some(live),
        ));
        assert_independent_net(&snap, floor, user_hps);
        assert!(snap.coins[0].nft_room_only);
    }

    #[test]
    fn usdc_interno_independent_uses_admin_floor_only() {
        let floor = 1_000.0;
        let live = 1e12;
        let user_hps = 50.0;
        let coin = MiningCoinInput {
            id: "usdc_interno".into(),
            symbol: "USDC_INT".into(),
            name: "USDC interno".into(),
            network_hashrate: floor,
            block_reward: 1.0,
            block_time: 600.0,
            price_usd: 1.0,
            usdc_rate: 1.0,
            nft_room_only: false,
        };
        let snap = compute_snapshot(&independent_net_input(
            coin,
            vec![operational_rack_with_machine(
                "room_initial",
                "usdc_interno",
                "gpu",
            )],
            wire_bat_machine("gpu", user_hps, None),
            Some(live),
        ));
        assert_independent_net(&snap, floor, user_hps);
        assert!(!snap.coins[0].nft_room_only);
    }
}
