/**
 * Opt-in Rust bridge — mining domain math (rede, grelha, accrual, yield boundary).
 * TX / Redis / Kafka / cron I/O ficam em Node.
 */
import {
  genesisMiningRustEnabled,
  loadGenesisNative
} from '../../../shared/rust/genesis-native.js';
import { isIndependentNetworkPoolMiningCoinRef } from './nft-room-mining.js';

/** Shape alinhada a `MiningBlockHistoryInsertRow` (evita ciclo com progress-computer). */
export type MiningHistoryRowBridge = {
  coinId: string;
  roomId: string | null;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
};

function nativeMining() {
  if (!genesisMiningRustEnabled()) return null;
  return loadGenesisNative();
}

function mapToJson(m: Map<string, number> | Record<string, number> | undefined): string {
  if (!m) return '{}';
  if (m instanceof Map) {
    const o: Record<string, number> = {};
    for (const [k, v] of m) o[k] = v;
    return JSON.stringify(o);
  }
  return JSON.stringify(m);
}

type YieldHistLike = { yield_per_hash: unknown; effective_at: unknown };

function histToJson(sorted: YieldHistLike[] | undefined): string {
  if (!sorted?.length) return '[]';
  return JSON.stringify(
    sorted.map((h) => ({
      yieldPerHash: Number(h.yield_per_hash) || 0,
      effectiveAt: Number(h.effective_at) || 0
    }))
  );
}

function rowFromRust(r: {
  coinId: string;
  roomId?: string | null;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
}): MiningHistoryRowBridge {
  return {
    coinId: r.coinId,
    roomId: r.roomId ?? null,
    windowStartMs: r.windowStartMs,
    windowEndMs: r.windowEndMs,
    creditBlocks: r.creditBlocks,
    amountCoins: r.amountCoins,
    amountUsd: r.amountUsd,
    userHashHps: r.userHashHps,
    networkHashrate: r.networkHashrate,
    blockReward: r.blockReward,
    blockTime: r.blockTime
  };
}

function rowToRust(r: MiningHistoryRowBridge) {
  return {
    coinId: r.coinId,
    roomId: r.roomId,
    windowStartMs: r.windowStartMs,
    windowEndMs: r.windowEndMs,
    creditBlocks: r.creditBlocks,
    amountCoins: r.amountCoins,
    amountUsd: r.amountUsd,
    userHashHps: r.userHashHps,
    networkHashrate: r.networkHashrate,
    blockReward: r.blockReward,
    blockTime: r.blockTime
  };
}

/** Espelha `effectiveNetworkHashrateForCoin` — null = usar TS. */
export function rustEffectiveNetworkHashrateForCoin(
  coinId: string,
  dbNetworkHashrate: number,
  runtimeByCoin: Map<string, number> | Record<string, number>,
  impliedFromYieldByCoin: Map<string, number> | Record<string, number> | undefined,
  independentPool: boolean
): number | null {
  const n = nativeMining();
  const fn = n?.miningEffectiveNetworkJson;
  if (!fn) return null;
  try {
    return fn(
      coinId,
      dbNetworkHashrate,
      mapToJson(runtimeByCoin),
      mapToJson(impliedFromYieldByCoin),
      independentPool
    );
  } catch (e) {
    console.warn('[mining/rust] effectiveNetwork fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustNetworkHashrateFromYieldPerHash(
  yieldPerHash: number,
  blockReward: number,
  blockTimeSec: number
): number | null {
  const n = nativeMining();
  const fn = n?.miningNetworkFromYieldPerHash;
  if (!fn) return null;
  try {
    return fn(yieldPerHash, blockReward, blockTimeSec);
  } catch (e) {
    console.warn('[mining/rust] yieldInvert fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustUtcMidnightMs(ts: number): number | null {
  const fn = nativeMining()?.miningUtcMidnightMs;
  if (!fn) return null;
  try {
    return fn(ts);
  } catch {
    return null;
  }
}

export function rustLastCompletedTenMinuteUtcGrid(ts: number): number | null {
  const fn = nativeMining()?.miningLastCompletedTenMinGrid;
  if (!fn) return null;
  try {
    return fn(ts);
  } catch {
    return null;
  }
}

export function rustMiningCreditCapNowMs(nowMs: number, gridEnabled: boolean): number | null {
  const fn = nativeMining()?.miningCreditCapNowMs;
  if (!fn) return null;
  try {
    return fn(nowMs, gridEnabled);
  } catch {
    return null;
  }
}

export function rustListPendingTenMinuteBoundaries(
  checkpointMs: number,
  capMs: number
): number[] | null {
  const fn = nativeMining()?.miningListPendingBoundariesJson;
  if (!fn) return null;
  try {
    const raw = JSON.parse(fn(checkpointMs, capMs)) as number[];
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rustListCreditHistoryWindows(
  startMs: number,
  endMs: number
): Array<{ startMs: number; endMs: number }> | null {
  const fn = nativeMining()?.miningListCreditWindowsJson;
  if (!fn) return null;
  try {
    const raw = JSON.parse(fn(startMs, endMs)) as Array<{ startMs: number; endMs: number }>;
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rustCalculateIntegratedYield(
  startTimeMs: number,
  endTimeMs: number,
  sortedCoinHistory: YieldHistLike[] | undefined
): number | null {
  const fn = nativeMining()?.miningCalculateIntegratedYieldJson;
  if (!fn) return null;
  try {
    return fn(startTimeMs, endTimeMs, histToJson(sortedCoinHistory));
  } catch (e) {
    console.warn('[mining/rust] integratedYield fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustBuildMiningBlockHistoryRowsForCredit(opts: {
  coinId: string;
  roomId: string | null;
  intervalStartMs: number;
  intervalEndMs: number;
  sortedCoinHistory: YieldHistLike[] | undefined;
  useHistoryIntegration: boolean;
  fallbackYieldPerHash: number;
  effectiveHash: number;
  usdRate: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
}): MiningHistoryRowBridge[] | null {
  const fn = nativeMining()?.miningBuildBlockHistoryRowsJson;
  if (!fn) return null;
  try {
    const raw = JSON.parse(
      fn(
        JSON.stringify({
          coinId: opts.coinId,
          roomId: opts.roomId,
          intervalStartMs: opts.intervalStartMs,
          intervalEndMs: opts.intervalEndMs,
          sortedCoinHistory: JSON.parse(histToJson(opts.sortedCoinHistory)),
          useHistoryIntegration: opts.useHistoryIntegration,
          fallbackYieldPerHash: opts.fallbackYieldPerHash,
          effectiveHash: opts.effectiveHash,
          usdRate: opts.usdRate,
          networkHashrate: opts.networkHashrate,
          blockReward: opts.blockReward,
          blockTime: opts.blockTime
        })
      )
    ) as Array<Parameters<typeof rowFromRust>[0]>;
    return Array.isArray(raw) ? raw.map(rowFromRust) : null;
  } catch (e) {
    console.warn('[mining/rust] buildHistory fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustConsolidateMiningBlockHistoryRows(
  rows: MiningHistoryRowBridge[]
): MiningHistoryRowBridge[] | null {
  const fn = nativeMining()?.miningConsolidateBlockHistoryJson;
  if (!fn) return null;
  try {
    const raw = JSON.parse(fn(JSON.stringify(rows.map(rowToRust)))) as Array<
      Parameters<typeof rowFromRust>[0]
    >;
    return Array.isArray(raw) ? raw.map(rowFromRust) : null;
  } catch (e) {
    console.warn('[mining/rust] consolidate fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

/** null = TS deve correr; true = ok; throw se mismatch (Rust lançou). */
export function rustAssertTickHistoryMatchesEconomy(
  totalGained: Map<string, number>,
  historyRows: MiningHistoryRowBridge[]
): boolean | null {
  const fn = nativeMining()?.miningAssertTickEconomyJson;
  if (!fn) return null;
  try {
    const o: Record<string, number> = {};
    for (const [k, v] of totalGained) o[k] = v;
    fn(JSON.stringify(o), JSON.stringify(historyRows.map(rowToRust)));
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.includes('[MiningEpsilon]')) {
      throw e;
    }
    console.warn('[mining/rust] assertTickEconomy fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustBuildYieldHistoryRowsForBoundary(
  coins: Array<{
    id: unknown;
    symbol?: unknown;
    nft_room_only?: unknown;
    nftRoomOnly?: unknown;
    block_reward: unknown;
    block_time: unknown;
    network_hashrate: unknown;
    independentPool?: boolean;
    independent_pool?: boolean;
  }>,
  realNetworkHashratesMap: Map<string, number>,
  effectiveAtMs: number
): {
  coinIds: string[];
  yields: number[];
  rewards: number[];
  netHashes: number[];
  effectives: number[];
} | null {
  const fn = nativeMining()?.miningBuildYieldBoundaryJson;
  if (!fn) return null;
  try {
    const coinsPayload = coins.map((c) => {
      const independentPool =
        c.independentPool === true ||
        c.independent_pool === true ||
        isIndependentNetworkPoolMiningCoinRef({
          id: c.id,
          symbol: c.symbol,
          nft_room_only: c.nft_room_only,
          nftRoomOnly: c.nftRoomOnly
        });
      return {
        id: String(c.id),
        blockReward: Number(c.block_reward) || 0,
        blockTime: Number(c.block_time) || 0,
        networkHashrate: Number(c.network_hashrate) || 0,
        independentPool
      };
    });
    const raw = JSON.parse(
      fn(JSON.stringify(coinsPayload), mapToJson(realNetworkHashratesMap), effectiveAtMs)
    ) as {
      coinIds: string[];
      yields: number[];
      rewards: number[];
      netHashes: number[];
      effectives: number[];
    };
    if (!raw?.coinIds) return null;
    return raw;
  } catch (e) {
    console.warn('[mining/rust] yieldBoundary fallback', e instanceof Error ? e.message : e);
    return null;
  }
}
