/**
 * Estado partilhado entre o tick de yield e o ranking/admin, sem dependência circular.
 *
 * Migrado de legacy/backend/cron/miningGlobalStatsStore.ts, verbatim.
 */
export type GlobalNetworkStatsState = {
  hashrates: Record<string, number>;
  activeMiners: number;
  activeMinersByCoin: Record<string, number>;
  ranking: Array<{
    user_id: number;
    username: unknown;
    coins: Record<string, number>;
    /** Ranking geral: H/s fora da Sala NFT. */
    generalPower?: number;
    totalPower: number;
  }>;
};

let globalNetworkStats: GlobalNetworkStatsState = {
  hashrates: {},
  activeMiners: 0,
  activeMinersByCoin: {},
  ranking: []
};

export function getGlobalNetworkStats(): GlobalNetworkStatsState {
  return globalNetworkStats;
}

export function setGlobalNetworkStats(next: GlobalNetworkStatsState): void {
  globalNetworkStats = next;
}
