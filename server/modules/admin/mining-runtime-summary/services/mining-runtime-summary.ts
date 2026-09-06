/**
 * GET /api/admin/mining-runtime-summary — snapshot em memória do último tick de yield.
 *
 * Migrado de `legacy/backend/server.ts` (`Object.fromEntries(miningRuntimeStats…)`).
 * Só lê `miningRuntimeStats`. Não chama o cron, não grava yield, não altera racks.
 *
 * Em processo sem cron Node (`SCHEDULER_ENABLED=0` / worker URL set) os Maps
 * ficam vazios até `hydrateMiningRuntimeStatsFromAppCache` — o controller hidrata.
 */
import { miningRuntimeStats } from '../../../mining-engine/services/runtime-stats.js';

export type MiningRuntimeStatsSource = {
  globalNetworkHashrates: Map<string, number>;
  globalActiveMiners: number;
  globalActiveMinersByCoin: Map<string, number>;
};

export type MiningRuntimeSummaryDto = {
  realActiveMiners: number;
  realNetworkHashrates: Record<string, number>;
  activeMinersByCoin: Record<string, number>;
};

export function getMiningRuntimeSummary(stats: MiningRuntimeStatsSource = miningRuntimeStats): MiningRuntimeSummaryDto {
  return {
    realActiveMiners: stats.globalActiveMiners,
    realNetworkHashrates: Object.fromEntries(stats.globalNetworkHashrates),
    activeMinersByCoin: Object.fromEntries(stats.globalActiveMinersByCoin)
  };
}
