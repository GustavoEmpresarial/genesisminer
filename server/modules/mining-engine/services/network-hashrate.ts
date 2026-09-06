/**
 * Fonte única: hashrate de rede efectivo (floor / live / implied) e sanidade de piso admin.
 *
 * Dois modelos:
 *  - competitivo: max(floor, live, implied, MIN)
 *  - independente (NFT / usdc_interno): floor-only —
 *    `max(floor, MIN)` — ignora live e implied
 *
 * Math opt-in Rust: `GENESIS_MINING_RUST=1`.
 */
import { NETWORK_HASHRATE_SANITY_MIN_HPS } from './network-hashrate-floor.js';
import {
  rustEffectiveNetworkHashrateForCoin,
  rustNetworkHashrateFromYieldPerHash
} from './mining-rust-bridge.js';

export { NETWORK_HASHRATE_SANITY_MIN_HPS };

/**
 * Aviso quando um único rig ≥ este % do piso de rede (dominância de bloco).
 * Ex.: 50 → minerador com ≥50% do piso dispara warn.
 */
export const NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT = 50;

/**
 * Aviso quando `floor < live / ratio` — piso muito abaixo do live inflaciona yield.
 * Ex.: ratio 10 → floor < 10% do live dispara warn.
 */
export const NETWORK_FLOOR_BELOW_LIVE_WARN_RATIO = 10;

/** Percentagem → fração (50% → 0,5). */
const PERCENT_DENOMINATOR = 100;

const DOMINANCE_WARN_FRACTION = NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT / PERCENT_DENOMINATOR;
const PCT_MULTIPLIER = PERCENT_DENOMINATOR;

export type NetworkFloorSanityLevel = 'ok' | 'warn';

export type NetworkFloorSanityResult = {
  level: NetworkFloorSanityLevel;
  dominancePct?: number;
  message?: string;
};

/**
 * Hashrate de rede efectiva (≥1), alinhado ao yield-cron / progress-computer.
 *
 * Pool competitivo (GPU clássico): `max(floor, liveRuntime, impliedFromYield)`.
 * Pool independente (NFT / usdc_interno): floor-only —
 * `max(floor, MIN)` — ignora live e implied; não partilha rede.
 */
export function effectiveNetworkHashrateForCoin(
  coinId: string,
  dbNetworkHashrate: number,
  runtimeByCoin: Map<string, number>,
  /** Rede implícita do último `yield_per_hash` (quando o Map em memória está vazio). */
  impliedFromYieldByCoin?: Map<string, number>,
  opts?: { independentPool?: boolean }
): number {
  const independent = opts?.independentPool === true;
  const rust = rustEffectiveNetworkHashrateForCoin(
    coinId,
    dbNetworkHashrate,
    runtimeByCoin,
    impliedFromYieldByCoin,
    independent
  );
  if (rust != null && Number.isFinite(rust)) return rust;

  const floorRaw = Number(dbNetworkHashrate);
  const floor = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : NETWORK_HASHRATE_SANITY_MIN_HPS;
  if (independent) {
    return Math.max(floor, NETWORK_HASHRATE_SANITY_MIN_HPS);
  }
  const dyn = Number(runtimeByCoin.get(coinId) || 0);
  const live = Number.isFinite(dyn) && dyn > 0 ? dyn : 0;
  const impliedRaw = Number(impliedFromYieldByCoin?.get(coinId) || 0);
  const implied = Number.isFinite(impliedRaw) && impliedRaw > 0 ? impliedRaw : 0;
  return Math.max(floor, live, implied, NETWORK_HASHRATE_SANITY_MIN_HPS);
}

/**
 * Inverte `yield_per_hash = (block_reward/block_time) / net` → rede efectiva usada no crédito.
 */
export function networkHashrateFromYieldPerHash(
  yieldPerHash: number,
  blockReward: number,
  blockTimeSec: number
): number {
  const rust = rustNetworkHashrateFromYieldPerHash(yieldPerHash, blockReward, blockTimeSec);
  if (rust != null && Number.isFinite(rust)) return rust;

  const y = Number(yieldPerHash);
  const br = Number(blockReward);
  const bt = Number(blockTimeSec);
  if (!(y > 0) || !(bt > 0) || !(br > 0)) return 0;
  const rewardPerSec = br / bt;
  const net = rewardPerSec / y;
  return Number.isFinite(net) && net > 0 ? net : 0;
}

function formatHps(hps: number): string {
  return Number.isFinite(hps) ? Math.round(hps).toLocaleString('pt-BR') : '0';
}

function formatPct(pct: number): string {
  return Number.isFinite(pct) ? pct.toFixed(1) : '0';
}

/**
 * Validação de sanidade ao definir piso de rede no admin (dominância / inflação).
 */
export function assessNetworkFloorSanity(args: {
  floorHps: number;
  liveNetworkHps: number;
  largestMinerHps?: number;
}): NetworkFloorSanityResult {
  const floorHps = Number(args.floorHps);
  const liveNetworkHps = Number(args.liveNetworkHps);
  const largestMinerHps = args.largestMinerHps != null ? Number(args.largestMinerHps) : undefined;

  if (!(floorHps > 0)) {
    return { level: 'ok' };
  }

  if (largestMinerHps != null && Number.isFinite(largestMinerHps) && largestMinerHps > 0) {
    const dominanceRatio = largestMinerHps / floorHps;
    if (dominanceRatio >= DOMINANCE_WARN_FRACTION) {
      const dominancePct = dominanceRatio * PCT_MULTIPLIER;
      return {
        level: 'warn',
        dominancePct,
        message: `Este piso permite que um minerador com ${formatHps(largestMinerHps)} H/s leve ${formatPct(dominancePct)}% do bloco. Confirma?`
      };
    }
  }

  if (liveNetworkHps > 0 && floorHps < liveNetworkHps / NETWORK_FLOOR_BELOW_LIVE_WARN_RATIO) {
    return {
      level: 'warn',
      message:
        `O piso (${formatHps(floorHps)} H/s) está muito abaixo do hashrate live (${formatHps(liveNetworkHps)} H/s), o que pode inflacionar recompensas. Confirma?`
    };
  }

  return { level: 'ok' };
}
