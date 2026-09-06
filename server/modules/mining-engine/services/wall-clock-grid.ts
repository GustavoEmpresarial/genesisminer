/**
 * Grelha global de "blocos" de 10 minutos: início de cada dia UTC em 00:00, depois
 * 00:10, 00:20, … (= 144 janelas/dia). Usado para tecto de crédito de mineração e
 * para alinhar ticks de yield em BD.
 *
 * Desligar (comportamento antigo, tempo contínuo até `Date.now()`): MINING_WALL_CLOCK_TEN_MIN_GRID=0
 *
 * Math opt-in Rust: `GENESIS_MINING_RUST=1`.
 */
import { MS_PER_MINUTE } from '../../../shared/utils/time.js';
import {
  rustLastCompletedTenMinuteUtcGrid,
  rustListCreditHistoryWindows,
  rustListPendingTenMinuteBoundaries,
  rustMiningCreditCapNowMs,
  rustUtcMidnightMs
} from './mining-rust-bridge.js';

/** Minutos por slot da grelha canónica UTC. */
const GRID_BOUNDARY_MINUTES = 10;

/** Duração da grelha canónica UTC (≠ `mining_coins.block_time`, que é só económico). */
export const TEN_MIN_MS = GRID_BOUNDARY_MINUTES * MS_PER_MINUTE;

export function utcMidnightMs(ts: number): number {
  const rust = rustUtcMidnightMs(ts);
  if (rust != null && Number.isFinite(rust)) return rust;
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

/** Maior instante T ≤ ts tal que T = meia-noite UTC do dia de `ts` + n·10 min (n inteiro ≥ 0). */
export function lastCompletedTenMinuteUtcGrid(ts: number): number {
  const rust = rustLastCompletedTenMinuteUtcGrid(ts);
  if (rust != null && Number.isFinite(rust)) return rust;
  const day0 = utcMidnightMs(ts);
  const rel = ts - day0;
  if (rel < 0) return day0;
  return day0 + Math.floor(rel / TEN_MIN_MS) * TEN_MIN_MS;
}

/** `true` por defeito; só `0` ou `false` desliga. */
export function miningTenMinuteGridEnabled(): boolean {
  const v = String(process.env.MINING_WALL_CLOCK_TEN_MIN_GRID ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

/** Instant até onde se pode creditar mineração (ou `now` se grelha desligada). */
export function miningCreditCapNowMs(nowMs: number): number {
  const enabled = miningTenMinuteGridEnabled();
  const rust = rustMiningCreditCapNowMs(nowMs, enabled);
  if (rust != null && Number.isFinite(rust)) return rust;
  if (!enabled) return nowMs;
  return lastCompletedTenMinuteUtcGrid(nowMs);
}

/**
 * Boundaries de yield ainda não persistidos, em ordem crescente.
 *
 * - `checkpointMs <= 0` (primeiro boot / histórico vazio): só o `capMs` actual —
 *   não reconstruir meses desde a epoch.
 * - Caso contrário: `(checkpoint, cap]` em passos de `TEN_MIN_MS`.
 */
export function listPendingTenMinuteBoundaries(checkpointMs: number, capMs: number): number[] {
  const rust = rustListPendingTenMinuteBoundaries(checkpointMs, capMs);
  if (rust != null) return rust;

  if (!Number.isFinite(capMs) || capMs <= 0) return [];
  const cap = lastCompletedTenMinuteUtcGrid(capMs);
  if (!(cap > 0)) return [];

  if (!Number.isFinite(checkpointMs) || checkpointMs <= 0) {
    return [cap];
  }

  const checkpoint = lastCompletedTenMinuteUtcGrid(checkpointMs);
  if (!(cap > checkpoint)) return [];

  const out: number[] = [];
  for (let b = checkpoint + TEN_MIN_MS; b <= cap; b += TEN_MIN_MS) {
    out.push(b);
  }
  return out;
}

export type CreditHistoryWindow = { startMs: number; endMs: number };

/**
 * Particiona `[startMs, endMs)` em segmentos alinhados à grelha UTC de 10 min.
 *
 * - Se `start`/`end` estão na grelha: janelas exactas de `TEN_MIN_MS`.
 * - Se `start` está off-grid (ex.: `start_time` legado, grelha desligada):
 *   a primeira (e/ou última) janela pode ser parcial — preservada, não inventada.
 */
export function listCreditHistoryWindows(startMs: number, endMs: number): CreditHistoryWindow[] {
  const rust = rustListCreditHistoryWindows(startMs, endMs);
  if (rust != null) return rust;

  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || !(endMs > startMs)) return [];

  const out: CreditHistoryWindow[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const day0 = utcMidnightMs(cursor);
    const steps = Math.ceil((cursor - day0) / TEN_MIN_MS);
    let nextBoundary = day0 + steps * TEN_MIN_MS;
    if (nextBoundary <= cursor) {
      nextBoundary = cursor + TEN_MIN_MS;
    }
    const segmentEnd = Math.min(nextBoundary, endMs);
    if (!(segmentEnd > cursor)) break;
    out.push({ startMs: cursor, endMs: segmentEnd });
    cursor = segmentEnd;
  }
  return out;
}
