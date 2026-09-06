use super::constants::{
    NFT_EXCLUSIVE_ID_KEYS, NFT_EXCLUSIVE_SYMBOLS, NFT_ROOM_EXCLUDED_MACHINE_IDS,
    NFT_ROOM_NON_EXCLUSIVE_IDS, NFT_ROOM_NON_EXCLUSIVE_SYMBOLS, NFT_STABLE_USD_SYMBOLS,
};
use super::room_id::normalize_placed_rack_room_id;
use super::types::{CalculatorUpgradeLite, MiningCoinInput};
use std::collections::HashSet;

pub fn normalize_mining_coin_symbol_key(symbol: &str) -> String {
    symbol.trim().to_uppercase()
}

fn is_nft_room_non_exclusive_mining_coin_id(id: &str) -> bool {
    let low = id.trim().to_lowercase();
    !low.is_empty() && NFT_ROOM_NON_EXCLUSIVE_IDS.contains(&low.as_str())
}

fn is_nft_room_non_exclusive_mining_coin_symbol(symbol: &str) -> bool {
    let sym = normalize_mining_coin_symbol_key(symbol);
    !sym.is_empty() && NFT_ROOM_NON_EXCLUSIVE_SYMBOLS.contains(&sym.as_str())
}

pub fn is_nft_room_exclusive_mining_coin_symbol(symbol: &str) -> bool {
    let sym = normalize_mining_coin_symbol_key(symbol);
    if sym.is_empty() || is_nft_room_non_exclusive_mining_coin_symbol(&sym) {
        return false;
    }
    if NFT_EXCLUSIVE_SYMBOLS.contains(&sym.as_str()) {
        return true;
    }
    sym.starts_with("NFT_")
}

pub fn is_nft_room_exclusive_mining_coin_id(id: &str) -> bool {
    let low = id.trim().to_lowercase();
    if low.is_empty() || is_nft_room_non_exclusive_mining_coin_id(&low) {
        return false;
    }
    NFT_EXCLUSIVE_ID_KEYS
        .iter()
        .any(|k| low == *k || low.ends_with(&format!("_{k}")) || low.starts_with(&format!("{k}_")))
}

pub fn is_nft_room_exclusive_mining_coin_ref(coin: &MiningCoinInput) -> bool {
    if is_nft_room_non_exclusive_mining_coin_id(&coin.id)
        || is_nft_room_non_exclusive_mining_coin_symbol(&coin.symbol)
    {
        return false;
    }
    if coin.nft_room_only {
        return true;
    }
    if is_nft_room_exclusive_mining_coin_symbol(&coin.symbol) {
        return true;
    }
    is_nft_room_exclusive_mining_coin_id(&coin.id)
}

pub fn is_nft_room_exclusive_mining_coin_ref_str(ref_id: &str) -> bool {
    if is_nft_room_non_exclusive_mining_coin_id(ref_id)
        || is_nft_room_non_exclusive_mining_coin_symbol(ref_id)
    {
        return false;
    }
    if is_nft_room_exclusive_mining_coin_symbol(ref_id) {
        return true;
    }
    is_nft_room_exclusive_mining_coin_id(ref_id)
}

/// Pool independente: rede = só piso admin (`max(floor, MIN)`; ignora live/implied).
pub fn is_independent_network_pool_mining_coin_ref(coin: &MiningCoinInput) -> bool {
    if is_nft_room_non_exclusive_mining_coin_id(&coin.id)
        || is_nft_room_non_exclusive_mining_coin_symbol(&coin.symbol)
    {
        return true;
    }
    is_nft_room_exclusive_mining_coin_ref(coin)
}

pub fn is_independent_network_pool_mining_coin_ref_str(ref_id: &str) -> bool {
    if is_nft_room_non_exclusive_mining_coin_id(ref_id)
        || is_nft_room_non_exclusive_mining_coin_symbol(ref_id)
    {
        return true;
    }
    is_nft_room_exclusive_mining_coin_ref_str(ref_id)
}

pub fn is_nft_mining_room_id(room_id: Option<&str>, nft_room_ids: &HashSet<String>) -> bool {
    let id = normalize_placed_rack_room_id(room_id.unwrap_or(""));
    nft_room_ids.contains(&id)
}

pub fn is_nft_auto_room_id(room_id: Option<&str>) -> bool {
    use super::constants::NFT_AUTO_ROOM_ID;
    normalize_placed_rack_room_id(room_id.unwrap_or("")) == NFT_AUTO_ROOM_ID
}

pub fn is_asic_room_for_mining_credits(
    room_id: Option<&str>,
    asic_room_ids: Option<&HashSet<String>>,
) -> bool {
    use super::constants::ASIC_ROOM_ID;
    let id = normalize_placed_rack_room_id(room_id.unwrap_or(""));
    if id.is_empty() {
        return false;
    }
    if let Some(ids) = asic_room_ids {
        if ids.contains(&id) {
            return true;
        }
    }
    id == normalize_placed_rack_room_id(ASIC_ROOM_ID)
}

fn coin_usd_number(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

pub fn resolve_mining_coin_usd_rate(coin: &MiningCoinInput) -> f64 {
    let usdc = coin_usd_number(coin.usdc_rate);
    if usdc > 0.0 {
        return usdc;
    }
    let px = coin_usd_number(coin.price_usd);
    if px > 0.0 {
        return px;
    }
    if !is_nft_room_exclusive_mining_coin_ref(coin) {
        return 0.0;
    }
    let sym = normalize_mining_coin_symbol_key(&coin.symbol);
    if NFT_STABLE_USD_SYMBOLS.contains(&sym.as_str()) {
        return 1.0;
    }
    0.0
}

pub fn is_asic_machine_upgrade(up_type: &str, up_id: &str, category: Option<&str>) -> bool {
    if up_type != "machine" {
        return false;
    }
    let id = up_id.trim().to_lowercase();
    if id.starts_with("asic_") {
        return true;
    }
    category
        .map(|c| c.trim().to_lowercase())
        .map(|c| c.contains("asic"))
        .unwrap_or(false)
}

pub fn is_nft_collectible_machine(up_type: &str, up_id: &str, category: Option<&str>) -> bool {
    if up_type != "machine" {
        return false;
    }
    let id = up_id.trim().to_lowercase();
    if NFT_ROOM_EXCLUDED_MACHINE_IDS.contains(&id.as_str()) {
        return false;
    }
    if is_asic_machine_upgrade(up_type, up_id, category) {
        return false;
    }
    if id.starts_with("nft_") {
        return true;
    }
    category
        .map(|c| c.trim().to_lowercase())
        .map(|c| c.contains("nft"))
        .unwrap_or(false)
}

fn slot_counts_toward_general_power(up: &CalculatorUpgradeLite) -> bool {
    !(is_nft_room_catalog_machine(up)
        || is_asic_machine_upgrade(&up.upgrade_type, &up.id, up.category.as_deref()))
}

pub fn is_nft_room_catalog_machine(up: &CalculatorUpgradeLite) -> bool {
    is_asic_machine_upgrade(&up.upgrade_type, &up.id, up.category.as_deref())
        || is_nft_collectible_machine(&up.upgrade_type, &up.id, up.category.as_deref())
}

pub fn credit_counts_toward_general_power(counts: bool) -> bool {
    counts
}

pub fn slot_counts_toward_general_power_for_upgrade(up: &CalculatorUpgradeLite) -> bool {
    slot_counts_toward_general_power(up)
}
