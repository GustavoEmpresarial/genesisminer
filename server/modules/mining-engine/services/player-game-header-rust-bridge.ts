/**
 * Opt-in Rust bridge for player-game header hash aggregation
 * (`hashByCoinId` + `totalHash` com `countsTowardGeneralPower`).
 * Fallback TS espelha `genesis-core::header`.
 */
import {
  genesisHeaderRustEnabled,
  loadGenesisNative
} from '../../../shared/rust/genesis-native.js';

export type HeaderHashAggEntry = {
  coinId: string;
  effectiveHps: number;
  countsTowardGeneralPower: boolean;
};

export type HeaderHashAggResult = {
  hashByCoinId: Record<string, number>;
  totalHash: number;
};

function nativeHeader() {
  if (!genesisHeaderRustEnabled()) return null;
  return loadGenesisNative();
}

/** Fallback puro TS — mesma regra que `aggregate_header_hash` em Rust. */
export function tsAggregateHeaderHash(entries: HeaderHashAggEntry[]): HeaderHashAggResult {
  const hashByCoinId: Record<string, number> = {};
  let totalHash = 0;
  for (const e of entries) {
    const hps = Number(e.effectiveHps);
    if (!Number.isFinite(hps) || hps <= 0) continue;
    hashByCoinId[e.coinId] = (hashByCoinId[e.coinId] || 0) + hps;
    if (e.countsTowardGeneralPower === true) {
      totalHash += hps;
    }
  }
  return { hashByCoinId, totalHash };
}

export function aggregateHeaderHash(entries: HeaderHashAggEntry[]): HeaderHashAggResult {
  const native = nativeHeader();
  const fn = native?.headerAggregateHashJson;
  if (fn) {
    try {
      const parsed = JSON.parse(fn(JSON.stringify(entries))) as {
        hashByCoinId?: Record<string, number>;
        totalHash?: number;
      };
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.hashByCoinId &&
        typeof parsed.hashByCoinId === 'object' &&
        typeof parsed.totalHash === 'number' &&
        Number.isFinite(parsed.totalHash)
      ) {
        return { hashByCoinId: parsed.hashByCoinId, totalHash: parsed.totalHash };
      }
    } catch (e) {
      console.warn('[header/rust] aggregateHeaderHash fallback', e instanceof Error ? e.message : e);
    }
  }
  return tsAggregateHeaderHash(entries);
}
