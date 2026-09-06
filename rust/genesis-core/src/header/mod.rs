//! Player-game header hash aggregation (navbar totalHash vs hashByCoinId).
//!
//! Mirrors the final aggregation in
//! `server/modules/mining-engine/services/player-game-header-snapshot.ts`:
//! every entry contributes to `hash_by_coin_id`; only credits with
//! `counts_toward_general_power` feed `total_hash`.

mod aggregate;

pub use aggregate::{aggregate_header_hash, HeaderHashAggregate, HeaderHashEntry};
