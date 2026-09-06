/**
 * Client twin of server period-ym helpers (month ledger for transparency portal).
 */
const PERIOD_YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const TRANSPARENCY_STANDING_KEY = 'geral';

export function isPeriodYm(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && PERIOD_YM_RE.test(raw);
}

export function normalizePeriodYm(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === TRANSPARENCY_STANDING_KEY || s === 'standing') return null;
  return PERIOD_YM_RE.test(s) ? s : null;
}

export function currentPeriodYmUtc(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function collectPeriodYmOptions(
  entries: ReadonlyArray<{ periodYm?: string | null }>,
  nowMs = Date.now()
): Array<string | null> {
  const set = new Set<string>();
  for (const e of entries) {
    const ym = normalizePeriodYm(e.periodYm ?? null);
    if (ym) set.add(ym);
  }
  set.add(currentPeriodYmUtc(nowMs));
  return [null, ...[...set].sort()];
}

export function formatPeriodYmLabel(periodYm: string | null, locale: string): string {
  if (!periodYm) {
    if (locale.startsWith('en')) return 'Standing / general';
    if (locale.startsWith('es')) return 'General / permanente';
    return 'Geral / permanente';
  }
  const [ys, ms] = periodYm.split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return periodYm;
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(y, m - 1, 1))
    );
  } catch {
    return periodYm;
  }
}

export type SheetTotals = {
  pool: number;
  trade: number;
  investment: number;
  expense: number;
  other: number;
  inUsdc: number;
  outUsdc: number;
  netUsdc: number;
};

export function sumTransparencySheet(
  entries: ReadonlyArray<{ category?: string; amountUsdc?: number | null }>
): SheetTotals {
  let pool = 0;
  let trade = 0;
  let investment = 0;
  let expense = 0;
  let other = 0;
  for (const e of entries) {
    const a = e.amountUsdc;
    if (a == null || !Number.isFinite(a)) continue;
    const c = String(e.category || '');
    if (c === 'pool') pool += a;
    else if (c === 'trade') trade += a;
    else if (c === 'investment') investment += a;
    else if (c === 'expense') expense += a;
    else other += a;
  }
  const inUsdc = pool + trade;
  const outUsdc = expense;
  return { pool, trade, investment, expense, other, inUsdc, outUsdc, netUsdc: inUsdc - outUsdc };
}

export function filterEntriesByPeriodYm<T extends { periodYm?: string | null }>(
  entries: readonly T[],
  periodYm: string | null
): T[] {
  const target = normalizePeriodYm(periodYm);
  return entries.filter((e) => normalizePeriodYm(e.periodYm ?? null) === target);
}
