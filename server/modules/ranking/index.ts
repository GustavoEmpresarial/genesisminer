/**
 * Módulo `ranking`: ranking público de mineração (poder H/s por moeda) +
 * variante admin (`coin_balances`) + "minha posição" (`GET /api/ranking/me`).
 *
 * Leituras HTTP ao `genesis-mining-worker`. O loop Node
 * (`startPublicMiningRankingRefreshLoop`) é sempre no-op — o worker owns o snapshot.
 */
export { registerRankingModuleRoutes } from './controllers/ranking.controller.js';
export type { RankingModuleDeps } from './controllers/ranking.controller.js';

export {
  getAdminMiningRankingPayload,
  getMyGlobalMiningRank,
  getPublicMiningRankingPayload,
  RANKING_REFRESH_INTERVAL_MS,
  refreshPublicMiningRankingSnapshot,
  resetMyGlobalMiningRankCacheForTests,
  resetPublicMiningRankingCacheForTests,
  startPublicMiningRankingRefreshLoop,
  sumGeneralRankingPower
} from './services/mining-ranking.js';
export type { AdminMiningRankingPayload, AdminRankingUser, CoinLite, MyGlobalMiningRank, PublicMiningRankingPayload, PublicRankingUser } from './services/mining-ranking.js';
