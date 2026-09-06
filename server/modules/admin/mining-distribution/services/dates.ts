/**
 * Helpers de data UTC pros relatórios de distribuição de mineração — dias UTC
 * (não fuso local), consistentes com `window_end_ms` em `mining_block_history`.
 *
 * Migrado de legacy/backend/services/adminMiningDistribution.service.ts
 * (parte pura, sem I/O — separada aqui do resto do serviço).
 */
import { MS_PER_DAY } from '../../../../shared/utils/time.js';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDistributionDateMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (YMD_RE.test(s)) {
    return Date.parse(`${s}T00:00:00.000Z`);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Início do dia UTC (ms) para timestamp arbitrário. */
export function utcDayStartMsFromTs(tsMs: number): number {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

export function utcDayEndMsFromTs(tsMs: number): number {
  return utcDayStartMsFromTs(tsMs) + MS_PER_DAY - 1;
}

export function ymdFromUtcMs(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function daysBetweenUtc(fromMs: number, toMs: number): number {
  const a = utcDayStartMsFromTs(fromMs);
  const b = utcDayStartMsFromTs(toMs);
  return Math.max(1, Math.round((b - a) / MS_PER_DAY) + 1);
}
