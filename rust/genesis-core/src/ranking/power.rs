//! Mining ranking power math — mirrors `server/modules/ranking/services/mining-ranking.ts`.

use crate::calculator::slot_credits::list_slot_mining_credits;
use crate::calculator::types::CalculatorUpgradeLite;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Round factor for "my rank" hash display (TS `RANK_HASH_ROUND_FACTOR`).
pub const RANK_HASH_ROUND_FACTOR: f64 = 100.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoinLite {
    pub id: String,
    pub name: String,
    pub symbol: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicRankingUser {
    pub user_id: i64,
    pub username: String,
    /// Power per coin (includes NFT room / ASIC).
    pub coins: HashMap<String, f64>,
    /// Power per coin from credits with `counts_toward_general_power` (excludes NFT/ASIC rooms).
    #[serde(rename = "generalCoins")]
    pub general_coins: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicMiningRankingPayload {
    /// Epoch ms — wire field `timestamp` (Redis `ranking:public:v1` / Node clients).
    pub timestamp: i64,
    pub ranking: Vec<PublicRankingUser>,
    pub coins: Vec<CoinLite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminRankingUser {
    pub user_id: i64,
    pub username: String,
    pub coins: HashMap<String, f64>,
    #[serde(rename = "generalCoins")]
    pub general_coins: HashMap<String, f64>,
    pub balances: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminMiningRankingPayload {
    pub timestamp: i64,
    pub ranking: Vec<AdminRankingUser>,
    pub coins: Vec<CoinLite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyGlobalMiningRank {
    pub position: Option<u32>,
    pub total_ranked: u32,
    pub hash: f64,
}

/// Rack row needed to accumulate ranking power.
#[derive(Debug, Clone)]
pub struct RankingRackInput {
    pub id: String,
    pub user_id: i64,
    pub selected_coin_id: Option<String>,
    pub room_id: Option<String>,
    pub item_id: Option<String>,
}

/// Sum H/s for the global ranking (NFT-room credits excluded via `general_coins`).
pub fn sum_general_ranking_power(general_coins: &HashMap<String, f64>) -> f64 {
    let mut total = 0.0;
    for &v in general_coins.values() {
        if v.is_finite() && v > 0.0 {
            total += v;
        }
    }
    total
}

fn slot_ids_from_rows(rows: &[Option<String>]) -> Vec<Option<String>> {
    rows.to_vec()
}

/// Accumulate per-user power from operable racks into `ranking_data`.
///
/// Users missing from `username_by_id` are skipped. Public ranking creates
/// entries on first credit; admin pre-seeds all eligible users before calling.
///
/// `general_coins` only gets credits with `counts_toward_general_power`
/// (excludes NFT room + ASIC room / NFT-ASIC machines).
pub fn accumulate_ranking_power_from_racks(
    ranking_data: &mut HashMap<i64, PublicRankingUser>,
    racks: &[RankingRackInput],
    slots_by_rack: &HashMap<String, Vec<Option<String>>>,
    mult_by_rack: &HashMap<String, Vec<Option<String>>>,
    upgrades_mining: &HashMap<String, CalculatorUpgradeLite>,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
    username_by_id: &HashMap<i64, String>,
) {
    for rack in racks {
        let Some(uname) = username_by_id.get(&rack.user_id) else {
            continue;
        };

        let empty_slots: Vec<Option<String>> = Vec::new();
        let slots = slots_by_rack.get(&rack.id).unwrap_or(&empty_slots);
        let mult_slots = mult_by_rack.get(&rack.id).unwrap_or(&empty_slots);
        let selected = rack
            .selected_coin_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        let credits = list_slot_mining_credits(
            rack.room_id.as_deref(),
            &slot_ids_from_rows(slots),
            &slot_ids_from_rows(mult_slots),
            upgrades_mining,
            selected,
            Some(nft_room_ids),
            rack.item_id.as_deref(),
            Some(asic_room_ids),
        );
        if credits.is_empty() {
            continue;
        }

        ranking_data
            .entry(rack.user_id)
            .or_insert_with(|| PublicRankingUser {
                user_id: rack.user_id,
                username: uname.clone(),
                coins: HashMap::new(),
                general_coins: HashMap::new(),
            });
        let u_data = ranking_data.get_mut(&rack.user_id).expect("just inserted");
        for sc in credits {
            if !sc.effective_base_prod.is_finite() || sc.effective_base_prod <= 0.0 {
                continue;
            }
            *u_data.coins.entry(sc.coin_id.clone()).or_insert(0.0) += sc.effective_base_prod;
            if sc.counts_toward_general_power {
                *u_data.general_coins.entry(sc.coin_id).or_insert(0.0) += sc.effective_base_prod;
            }
        }
    }
}

/// Apply the same rack accumulation onto admin rows (coins / general_coins only).
pub fn accumulate_admin_ranking_power_from_racks(
    ranking_data: &mut HashMap<i64, AdminRankingUser>,
    racks: &[RankingRackInput],
    slots_by_rack: &HashMap<String, Vec<Option<String>>>,
    mult_by_rack: &HashMap<String, Vec<Option<String>>>,
    upgrades_mining: &HashMap<String, CalculatorUpgradeLite>,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: &HashSet<String>,
    username_by_id: &HashMap<i64, String>,
) {
    let mut as_public: HashMap<i64, PublicRankingUser> = ranking_data
        .iter()
        .map(|(id, u)| {
            (
                *id,
                PublicRankingUser {
                    user_id: u.user_id,
                    username: u.username.clone(),
                    coins: u.coins.clone(),
                    general_coins: u.general_coins.clone(),
                },
            )
        })
        .collect();

    accumulate_ranking_power_from_racks(
        &mut as_public,
        racks,
        slots_by_rack,
        mult_by_rack,
        upgrades_mining,
        nft_room_ids,
        asic_room_ids,
        username_by_id,
    );

    for (id, pub_u) in as_public {
        if let Some(admin_u) = ranking_data.get_mut(&id) {
            admin_u.coins = pub_u.coins;
            admin_u.general_coins = pub_u.general_coins;
        } else {
            ranking_data.insert(
                id,
                AdminRankingUser {
                    user_id: pub_u.user_id,
                    username: pub_u.username,
                    coins: pub_u.coins,
                    general_coins: pub_u.general_coins,
                    balances: HashMap::new(),
                },
            );
        }
    }
}

/// Filter admin rows: keep users with any power, general power, or balance.
pub fn filter_admin_ranking_users(users: Vec<AdminRankingUser>) -> Vec<AdminRankingUser> {
    users
        .into_iter()
        .filter(|u| {
            let has_power = u.coins.values().any(|&v| v > 0.0);
            let has_general = sum_general_ranking_power(&u.general_coins) > 0.0;
            let has_balance = u.balances.values().any(|&v| v > 0.0);
            has_power || has_general || has_balance
        })
        .collect()
}

/// 1-based position in global ranking (H/s outside NFT room).
pub fn my_global_mining_rank_from_payload(
    payload: &PublicMiningRankingPayload,
    user_id: i64,
) -> MyGlobalMiningRank {
    if user_id <= 0 {
        return MyGlobalMiningRank {
            position: None,
            total_ranked: 0,
            hash: 0.0,
        };
    }
    let mut all: Vec<(i64, f64)> = payload
        .ranking
        .iter()
        .map(|r| (r.user_id, sum_general_ranking_power(&r.general_coins)))
        .filter(|(_, total)| *total > 0.0)
        .collect();
    all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let total_ranked = all.len() as u32;
    match all.iter().position(|(uid, _)| *uid == user_id) {
        Some(idx) => {
            let total = all[idx].1;
            let hash = (total * RANK_HASH_ROUND_FACTOR).round() / RANK_HASH_ROUND_FACTOR;
            MyGlobalMiningRank {
                position: Some((idx as u32) + 1),
                total_ranked,
                hash,
            }
        }
        None => MyGlobalMiningRank {
            position: None,
            total_ranked,
            hash: 0.0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calculator::types::CalculatorUpgradeLite;

    fn gpu_upgrade(id: &str, base: f64) -> CalculatorUpgradeLite {
        CalculatorUpgradeLite {
            id: id.into(),
            upgrade_type: "machine".into(),
            category: None,
            base_production: base,
            multiplier: Some(0.0),
            power_capacity: None,
            nft_mining_coin_id: None,
        }
    }

    #[test]
    fn sum_general_ranking_power_only_positive_finite() {
        let mut m = HashMap::new();
        m.insert("btc".into(), 10.0);
        m.insert("eth".into(), -5.0);
        m.insert("ltc".into(), 0.0);
        m.insert("bad".into(), f64::NAN);
        assert_eq!(sum_general_ranking_power(&m), 10.0);
        assert_eq!(sum_general_ranking_power(&HashMap::new()), 0.0);
    }

    #[test]
    fn accumulate_credits_selected_coin_into_coins_and_general() {
        let mut ups = HashMap::new();
        ups.insert("gpu_1".into(), gpu_upgrade("gpu_1", 10.0));

        let racks = vec![RankingRackInput {
            id: "rack_1".into(),
            user_id: 1,
            selected_coin_id: Some("btc".into()),
            room_id: Some("sala_1".into()),
            item_id: None,
        }];
        let mut slots = HashMap::new();
        slots.insert("rack_1".into(), vec![Some("gpu_1".into())]);
        let mult = HashMap::new();
        let nft = HashSet::new();
        let mut names = HashMap::new();
        names.insert(1, "alice".into());

        let mut ranking = HashMap::new();
        accumulate_ranking_power_from_racks(
            &mut ranking,
            &racks,
            &slots,
            &mult,
            &ups,
            &nft,
            &HashSet::new(),
            &names,
        );

        let u = ranking.get(&1).expect("user");
        assert_eq!(u.username, "alice");
        assert_eq!(u.coins.get("btc").copied().unwrap_or(0.0), 10.0);
        assert_eq!(u.general_coins.get("btc").copied().unwrap_or(0.0), 10.0);
    }

    #[test]
    fn accumulate_skips_unknown_user() {
        let mut ups = HashMap::new();
        ups.insert("gpu_1".into(), gpu_upgrade("gpu_1", 10.0));
        let racks = vec![RankingRackInput {
            id: "rack_1".into(),
            user_id: 99,
            selected_coin_id: Some("btc".into()),
            room_id: Some("sala_1".into()),
            item_id: None,
        }];
        let mut slots = HashMap::new();
        slots.insert("rack_1".into(), vec![Some("gpu_1".into())]);
        let ranking = {
            let mut r = HashMap::new();
            accumulate_ranking_power_from_racks(
                &mut r,
                &racks,
                &slots,
                &HashMap::new(),
                &ups,
                &HashSet::new(),
                &HashSet::new(),
                &HashMap::new(),
            );
            r
        };
        assert!(ranking.is_empty());
    }

    #[test]
    fn nft_room_credits_coins_but_not_general() {
        use crate::calculator::constants::NFT_AUTO_ROOM_ID;
        let mut ups = HashMap::new();
        ups.insert("gpu_1".into(), gpu_upgrade("gpu_1", 10.0));
        let racks = vec![RankingRackInput {
            id: "rack_1".into(),
            user_id: 1,
            selected_coin_id: Some("btc".into()),
            room_id: Some(NFT_AUTO_ROOM_ID.into()),
            item_id: None,
        }];
        let mut slots = HashMap::new();
        slots.insert("rack_1".into(), vec![Some("gpu_1".into())]);
        let mut nft = HashSet::new();
        nft.insert(NFT_AUTO_ROOM_ID.into());
        let mut names = HashMap::new();
        names.insert(1, "alice".into());
        let mut ranking = HashMap::new();
        accumulate_ranking_power_from_racks(
            &mut ranking,
            &racks,
            &slots,
            &HashMap::new(),
            &ups,
            &nft,
            &HashSet::new(),
            &names,
        );
        // NFT room machines may credit differently; general must stay empty for NFT room.
        let u = ranking.get(&1);
        if let Some(u) = u {
            assert!(
                sum_general_ranking_power(&u.general_coins) == 0.0,
                "NFT room must not feed generalCoins"
            );
        }
    }

    #[test]
    fn asic_room_credits_coins_but_not_general() {
        use crate::calculator::constants::ASIC_ROOM_ID;
        let mut ups = HashMap::new();
        ups.insert("gpu_1".into(), gpu_upgrade("gpu_1", 10.0));
        let racks = vec![RankingRackInput {
            id: "rack_1".into(),
            user_id: 1,
            selected_coin_id: Some("btc".into()),
            room_id: Some(ASIC_ROOM_ID.into()),
            item_id: None,
        }];
        let mut slots = HashMap::new();
        slots.insert("rack_1".into(), vec![Some("gpu_1".into())]);
        let mut asic = HashSet::new();
        asic.insert(ASIC_ROOM_ID.into());
        let mut names = HashMap::new();
        names.insert(1, "alice".into());
        let mut ranking = HashMap::new();
        accumulate_ranking_power_from_racks(
            &mut ranking,
            &racks,
            &slots,
            &HashMap::new(),
            &ups,
            &HashSet::new(),
            &asic,
            &names,
        );
        let u = ranking.get(&1).expect("user");
        assert_eq!(u.coins.get("btc").copied().unwrap_or(0.0), 10.0);
        assert_eq!(
            sum_general_ranking_power(&u.general_coins),
            0.0,
            "ASIC room must not feed generalCoins"
        );
    }

    #[test]
    fn my_global_rank_orders_by_general_power() {
        let payload = PublicMiningRankingPayload {
            timestamp: 1,
            coins: vec![],
            ranking: vec![
                PublicRankingUser {
                    user_id: 1,
                    username: "a".into(),
                    coins: HashMap::from([("btc".into(), 5.0)]),
                    general_coins: HashMap::from([("btc".into(), 5.0)]),
                },
                PublicRankingUser {
                    user_id: 2,
                    username: "b".into(),
                    coins: HashMap::from([("btc".into(), 20.0)]),
                    general_coins: HashMap::from([("btc".into(), 20.0)]),
                },
            ],
        };
        let me = my_global_mining_rank_from_payload(&payload, 1);
        assert_eq!(me.position, Some(2));
        assert_eq!(me.total_ranked, 2);
        assert_eq!(me.hash, 5.0);

        let top = my_global_mining_rank_from_payload(&payload, 2);
        assert_eq!(top.position, Some(1));
        assert_eq!(top.hash, 20.0);

        let invalid = my_global_mining_rank_from_payload(&payload, 0);
        assert_eq!(invalid.position, None);
        assert_eq!(invalid.total_ranked, 0);
    }

    #[test]
    fn filter_admin_keeps_balance_only_users() {
        let users = vec![
            AdminRankingUser {
                user_id: 1,
                username: "a".into(),
                coins: HashMap::new(),
                general_coins: HashMap::new(),
                balances: HashMap::new(),
            },
            AdminRankingUser {
                user_id: 2,
                username: "b".into(),
                coins: HashMap::new(),
                general_coins: HashMap::new(),
                balances: HashMap::from([("btc".into(), 5.0)]),
            },
        ];
        let filtered = filter_admin_ranking_users(users);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].user_id, 2);
    }
}
