/**
 * Opt-in Rust bridge for black-market page/tax/reserve helpers.
 * TS fallback mirrors `genesis-core::market`.
 */
import { MS_PER_MINUTE } from '../../../shared/utils/time.js';
import {
  genesisMarketRustEnabled,
  loadGenesisNative
} from '../../../shared/rust/genesis-native.js';

export const MARKET_RESERVE_MINUTES = 3;
export const MARKET_RESERVE_MS = MARKET_RESERVE_MINUTES * MS_PER_MINUTE;

export const BLACK_MARKET_MAX_PAGE = 100;
export const BLACK_MARKET_DEFAULT_LIMIT = 60;
export const BLACK_MARKET_MAX_OFFSET = 50_000;

export const TAX_PERCENT_MIN = 0;
export const TAX_PERCENT_MAX = 100;

function nativeMarket() {
  if (!genesisMarketRustEnabled()) return null;
  return loadGenesisNative();
}

export function tsClampBlackMarketLimit(n: number | undefined): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return BLACK_MARKET_DEFAULT_LIMIT;
  return Math.min(BLACK_MARKET_MAX_PAGE, v);
}

export function tsClampBlackMarketOffset(n: number | undefined): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(BLACK_MARKET_MAX_OFFSET, v);
}

export function tsClampTaxPercent(raw: number): number {
  if (!Number.isFinite(raw)) return TAX_PERCENT_MIN;
  return Math.min(TAX_PERCENT_MAX, Math.max(TAX_PERCENT_MIN, raw));
}

export function tsIsReservationActive(reservedUntilMs: number | null | undefined, nowMs: number): boolean {
  if (reservedUntilMs == null || !Number.isFinite(reservedUntilMs)) return false;
  return reservedUntilMs > nowMs;
}

export function tsComputeReservedUntil(nowMs: number): number {
  return nowMs + MARKET_RESERVE_MS;
}

export function tsComputeP2PBandReferenceUsd(baseCost: number, bookFallbackAsk: number | null): number {
  const b = Number(baseCost);
  if (Number.isFinite(b) && b > 0) return b;
  const m =
    bookFallbackAsk != null && Number.isFinite(bookFallbackAsk) && bookFallbackAsk > 0
      ? bookFallbackAsk
      : null;
  return m ?? 0;
}

export function clampBlackMarketLimit(n: number | undefined): number {
  const native = nativeMarket();
  const fn = native?.marketClampPageJson;
  if (!fn) return tsClampBlackMarketLimit(n);
  try {
    const limArg = n === undefined ? undefined : Number(n);
    const parsed = JSON.parse(fn(limArg, undefined)) as { limit?: number };
    if (typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)) return parsed.limit;
  } catch (e) {
    console.warn('[black-market/rust] clampLimit fallback', e instanceof Error ? e.message : e);
  }
  return tsClampBlackMarketLimit(n);
}

export function clampBlackMarketOffset(n: number | undefined): number {
  const native = nativeMarket();
  const fn = native?.marketClampPageJson;
  if (!fn) return tsClampBlackMarketOffset(n);
  try {
    const offArg = n === undefined ? undefined : Number(n);
    const parsed = JSON.parse(fn(undefined, offArg)) as { offset?: number };
    if (typeof parsed.offset === 'number' && Number.isFinite(parsed.offset)) return parsed.offset;
  } catch (e) {
    console.warn('[black-market/rust] clampOffset fallback', e instanceof Error ? e.message : e);
  }
  return tsClampBlackMarketOffset(n);
}

export function clampMarketTaxPercent(raw: number): number {
  const native = nativeMarket();
  const fn = native?.marketClampTaxPercent;
  if (!fn) return tsClampTaxPercent(raw);
  try {
    const out = fn(raw);
    if (typeof out === 'number' && Number.isFinite(out)) return out;
  } catch (e) {
    console.warn('[black-market/rust] clampTax fallback', e instanceof Error ? e.message : e);
  }
  return tsClampTaxPercent(raw);
}

export function computeReservedUntil(nowMs: number): number {
  const native = nativeMarket();
  const fn = native?.marketReservedUntil;
  if (!fn) return tsComputeReservedUntil(nowMs);
  try {
    const out = fn(nowMs);
    if (typeof out === 'number' && Number.isFinite(out)) return out;
  } catch (e) {
    console.warn('[black-market/rust] reservedUntil fallback', e instanceof Error ? e.message : e);
  }
  return tsComputeReservedUntil(nowMs);
}

export function isReservationActive(reservedUntilMs: number | null | undefined, nowMs: number): boolean {
  const native = nativeMarket();
  const fn = native?.marketReservationActive;
  if (!fn) return tsIsReservationActive(reservedUntilMs, nowMs);
  try {
    const arg =
      reservedUntilMs == null || !Number.isFinite(reservedUntilMs) ? undefined : reservedUntilMs;
    return Boolean(fn(arg, nowMs));
  } catch (e) {
    console.warn('[black-market/rust] reservationActive fallback', e instanceof Error ? e.message : e);
  }
  return tsIsReservationActive(reservedUntilMs, nowMs);
}

export function computeP2PBandReferenceUsd(baseCost: number, bookFallbackAsk: number | null): number {
  const native = nativeMarket();
  const fn = native?.marketBandReferenceUsd;
  if (!fn) return tsComputeP2PBandReferenceUsd(baseCost, bookFallbackAsk);
  try {
    const fb =
      bookFallbackAsk != null && Number.isFinite(bookFallbackAsk) ? bookFallbackAsk : undefined;
    const out = fn(Number(baseCost), fb);
    if (typeof out === 'number' && Number.isFinite(out)) return out;
  } catch (e) {
    console.warn('[black-market/rust] bandReference fallback', e instanceof Error ? e.message : e);
  }
  return tsComputeP2PBandReferenceUsd(baseCost, bookFallbackAsk);
}
