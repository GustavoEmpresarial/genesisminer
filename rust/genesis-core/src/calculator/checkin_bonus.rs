use super::nft::{
    is_asic_room_for_mining_credits, is_nft_mining_room_id,
    is_nft_room_exclusive_mining_coin_ref_str,
};
use super::types::CheckinHashEntry;
use std::collections::{HashMap, HashSet};

pub fn sum_non_nft_room_rig_hash_hps(
    entries: &[CheckinHashEntry],
    nft_room_ids: &HashSet<String>,
    asic_room_ids: Option<&HashSet<String>>,
) -> f64 {
    let mut total = 0.0;
    for e in entries {
        if !e.counts_toward_general_power {
            continue;
        }
        if is_nft_mining_room_id(e.room_id.as_deref(), nft_room_ids) {
            continue;
        }
        if is_asic_room_for_mining_credits(e.room_id.as_deref(), asic_room_ids) {
            continue;
        }
        if is_nft_room_exclusive_mining_coin_ref_str(&e.coin_id) {
            continue;
        }
        let h = e.base_hps;
        if h.is_finite() && h > 0.0 {
            total += h;
        }
    }
    total
}

pub fn effective_hash_with_checkin_bonus(
    base_hps: f64,
    coin_id: &str,
    room_id: Option<&str>,
    bonus_hps: f64,
    total_non_nft_rig_hash: f64,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: Option<&HashSet<String>>,
    counts_toward_general_power: Option<bool>,
) -> f64 {
    let base = base_hps;
    if !base.is_finite() || base < 0.0 {
        return 0.0;
    }
    let bonus = bonus_hps;
    if !bonus.is_finite() || bonus <= 0.0 || total_non_nft_rig_hash <= 0.0 {
        return base;
    }
    if counts_toward_general_power == Some(false) {
        return base;
    }
    if is_nft_mining_room_id(room_id, nft_room_ids) {
        return base;
    }
    if is_asic_room_for_mining_credits(room_id, asic_room_ids) {
        return base;
    }
    if is_nft_room_exclusive_mining_coin_ref_str(coin_id) {
        return base;
    }
    base + bonus * (base / total_non_nft_rig_hash)
}

pub fn aggregate_hash_by_coin_with_checkin_bonus(
    entries: &[CheckinHashEntry],
    bonus_hps: f64,
    nft_room_ids: &HashSet<String>,
    asic_room_ids: Option<&HashSet<String>>,
) -> HashMap<String, f64> {
    let total_non_nft_rig_hash =
        sum_non_nft_room_rig_hash_hps(entries, nft_room_ids, asic_room_ids);
    let mut out = HashMap::new();
    for entry in entries {
        let effective = effective_hash_with_checkin_bonus(
            entry.base_hps,
            &entry.coin_id,
            entry.room_id.as_deref(),
            bonus_hps,
            total_non_nft_rig_hash,
            nft_room_ids,
            asic_room_ids,
            Some(entry.counts_toward_general_power),
        );
        if !effective.is_finite() || effective <= 0.0 {
            continue;
        }
        *out.entry(entry.coin_id.clone()).or_insert(0.0) += effective;
    }
    out
}
