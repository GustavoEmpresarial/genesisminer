/**
 * Estado em memória partilhado entre o cron de yield e o ranking/endpoints.
 *
 * Com `GENESIS_MINING_WORKER_URL` set, o tick Rust escreve `app_cache.network_stats`
 * e o Node hidrata estes Maps via `hydrateMiningRuntimeStatsFromAppCache`.
 */
import type { Pool } from 'pg';
import {
  setGlobalNetworkStats,
  type GlobalNetworkStatsState
} from './global-stats-store.js';
import { miningWorkerBaseUrl } from './mining-worker-client.js';

export const miningRuntimeStats = {
  globalNetworkHashrates: new Map<string, number>(),
  globalActiveMiners: 0,
  globalActiveMinersByCoin: new Map<string, number>()
};

/** `app_cache.key` written by yield tick (Node + Rust). */
const APP_CACHE_NETWORK_STATS_KEY = 'network_stats';

type Queryable = Pick<Pool, 'query'>;

/**
 * When the Rust mining worker owns the yield tick, Node Maps stay empty unless
 * hydrated from `app_cache.network_stats`. No-op when worker URL is unset.
 * @returns true if Maps were updated from a valid cache row.
 */
export async function hydrateMiningRuntimeStatsFromAppCache(pool: Queryable): Promise<boolean> {
  if (!miningWorkerBaseUrl()) return false;

  try {
    const res = await pool.query(`SELECT value FROM app_cache WHERE key = $1`, [
      APP_CACHE_NETWORK_STATS_KEY
    ]);
    const row = res.rows[0] as { value?: unknown } | undefined;
    const parsed = parseNetworkStatsValue(row?.value);
    if (!parsed) return false;

    miningRuntimeStats.globalNetworkHashrates.clear();
    for (const [cid, total] of Object.entries(parsed.hashrates)) {
      miningRuntimeStats.globalNetworkHashrates.set(cid, total);
    }
    miningRuntimeStats.globalActiveMiners = parsed.activeMiners;
    miningRuntimeStats.globalActiveMinersByCoin.clear();
    for (const [cid, n] of Object.entries(parsed.activeMinersByCoin)) {
      miningRuntimeStats.globalActiveMinersByCoin.set(cid, n);
    }
    setGlobalNetworkStats(parsed);
    return true;
  } catch {
    return false;
  }
}

function parseNetworkStatsValue(raw: unknown): GlobalNetworkStatsState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const hashrates: Record<string, number> = {};
  if (obj.hashrates && typeof obj.hashrates === 'object') {
    for (const [k, v] of Object.entries(obj.hashrates as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) hashrates[k] = n;
    }
  }

  const activeMinersByCoin: Record<string, number> = {};
  if (obj.activeMinersByCoin && typeof obj.activeMinersByCoin === 'object') {
    for (const [k, v] of Object.entries(obj.activeMinersByCoin as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) activeMinersByCoin[k] = n;
    }
  }

  const activeMinersRaw = obj.activeMiners;
  const activeMiners =
    typeof activeMinersRaw === 'number' && Number.isFinite(activeMinersRaw)
      ? activeMinersRaw
      : Number(activeMinersRaw) || 0;

  const ranking = Array.isArray(obj.ranking)
    ? (obj.ranking as GlobalNetworkStatsState['ranking'])
    : [];

  return { hashrates, activeMiners, activeMinersByCoin, ranking };
}
