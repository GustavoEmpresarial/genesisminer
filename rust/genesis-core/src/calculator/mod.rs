pub mod checkin_bonus;
pub mod constants;
pub mod nft;
pub mod projection;
pub mod room_id;
pub mod slot_credits;
pub mod snapshot;
pub mod types;

pub use projection::{
    compute_daily_earnings, compute_general_power_hps, compute_user_hash_by_coin_id,
    compute_user_hash_by_coin_id_with_checkin_bonus, effective_network_hashrate_for_coin,
    network_hashrate_from_yield_per_hash,
};
pub use snapshot::compute_snapshot;
pub use types::{CalculatorComputeInput, PlayerCalculatorSnapshot};
