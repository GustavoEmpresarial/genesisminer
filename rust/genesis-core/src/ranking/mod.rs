//! Public / admin mining ranking domain (pure math, no I/O).
//!
//! Mirrors `server/modules/ranking/services/mining-ranking.ts` power helpers.

mod power;

pub use power::{
    accumulate_admin_ranking_power_from_racks, accumulate_ranking_power_from_racks,
    filter_admin_ranking_users, my_global_mining_rank_from_payload, sum_general_ranking_power,
    AdminMiningRankingPayload, AdminRankingUser, CoinLite, MyGlobalMiningRank,
    PublicMiningRankingPayload, PublicRankingUser, RankingRackInput, RANK_HASH_ROUND_FACTOR,
};
