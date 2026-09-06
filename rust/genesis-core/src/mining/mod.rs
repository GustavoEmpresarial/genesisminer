//! Motor de mineração — domínio puro (sem I/O).
//!
//! ## Dois modelos de distribuição de rede
//!
//! 1. **Competitivo** — `effective = max(floor, live, implied, MIN)`
//! 2. **Independente** (NFT / usdc_interno) — floor-only:
//!    `max(floor, MIN)` — ignora live e implied; não partilha rede
//!
//! Crédito: `coins ≈ user_hash * ∫ yield_per_hash(t) dt`
//! I/O (Postgres, Redis, Kafka) fica em Node — ver `rust/README.md` § Mining.

mod accrual;
mod epsilon;
mod network;
mod wall_clock;
mod yield_boundary;

pub use accrual::{
    assert_tick_history_matches_economy, build_mining_block_history_rows_for_credit,
    calculate_integrated_yield, consolidate_mining_block_history_rows, BuildHistoryRowsOpts,
    MiningBlockHistoryInsertRow, YieldHistPoint,
};
pub use epsilon::{
    amounts_almost_equal, assert_amounts_almost_equal, MINING_AMOUNT_ABS_EPSILON,
    MINING_AMOUNT_REL_EPSILON,
};
pub use network::{
    assess_network_floor_sanity, effective_network_hashrate_for_coin,
    network_hashrate_from_yield_per_hash, NetworkFloorSanityLevel, NetworkFloorSanityResult,
    MIN_NETWORK_HASHRATE, NETWORK_FLOOR_BELOW_LIVE_WARN_RATIO,
    NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT,
};
pub use wall_clock::{
    last_completed_ten_minute_utc_grid, list_credit_history_windows,
    list_pending_ten_minute_boundaries, mining_credit_cap_now_ms, utc_midnight_ms,
    CreditHistoryWindow, TEN_MIN_MS,
};
pub use yield_boundary::{
    build_yield_history_rows_for_boundary, CoinYieldInput, YieldHistoryBoundaryRows,
};
