/**
 * Keep in sync with server/modules/mining-engine/services/network-hashrate.ts
 * (client não importa código do servidor — duplicação mínima intencional).
 */
export const NETWORK_FLOOR_SINGLE_MINER_DOMINANCE_WARN_PCT = 50;
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

function formatHps(hps: number): string {
  return Number.isFinite(hps) ? Math.round(hps).toLocaleString('pt-BR') : '0';
}

function formatPct(pct: number): string {
  return Number.isFinite(pct) ? pct.toFixed(1) : '0';
}

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
