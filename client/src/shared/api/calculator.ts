/**
 * Player mining calculator — GET `/api/calculator/me?scope=`
 */
import { apiFetch } from './http';

const base = '/api';

export type ProjectionPeriodId = 'hour' | 'day' | 'week' | 'month' | 'year';

export type ProjectionRow = {
  periodId: ProjectionPeriodId;
  coins: number;
  usd: number;
};

export type ProjectionBlockHistoryRow = {
  roomId: string;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
};

export type ProjectionCoin = {
  id: string;
  symbol: string;
  name: string;
  /** Admin upload path/URL; null when unset. */
  iconUrl: string | null;
  priceUsd: number;
  distributionMode: 'usd_month' | 'legacy' | string;
  distributionUsdMonth: number | null;
  nftRoomOnly: boolean;
  independentPool: boolean;
  userPowerHps: number;
  networkHps: number;
  yieldPerHash: number;
  sharePct: number;
  coinsPerSec: number;
  dailyCoins: number;
  dailyUsd: number;
  monthUsd: number;
  rows: ProjectionRow[];
  blockHistory: ProjectionBlockHistoryRow[];
};

export type ProjectionScopeUi = {
  id: string;
  name: string;
};

export type CalculatorProjectionPayload = {
  ok: boolean;
  scope: string;
  scopesUi: ProjectionScopeUi[];
  checkinFrozen: boolean;
  generalPowerHps: number;
  coins: ProjectionCoin[];
};

const PERIOD_IDS: readonly ProjectionPeriodId[] = ['hour', 'day', 'week', 'month', 'year'];

function asFiniteNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function parsePeriodId(raw: unknown): ProjectionPeriodId | null {
  if (typeof raw !== 'string') return null;
  return (PERIOD_IDS as readonly string[]).includes(raw) ? (raw as ProjectionPeriodId) : null;
}

function parseRow(raw: unknown): ProjectionRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const periodId = parsePeriodId(o.periodId);
  if (!periodId) return null;
  return {
    periodId,
    coins: asFiniteNumber(o.coins),
    usd: asFiniteNumber(o.usd)
  };
}

function parseHistory(raw: unknown): ProjectionBlockHistoryRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    roomId: asString(o.roomId),
    windowStartMs: asFiniteNumber(o.windowStartMs),
    windowEndMs: asFiniteNumber(o.windowEndMs),
    creditBlocks: asFiniteNumber(o.creditBlocks),
    amountCoins: asFiniteNumber(o.amountCoins),
    amountUsd: asFiniteNumber(o.amountUsd),
    userHashHps: asFiniteNumber(o.userHashHps),
    networkHashrate: asFiniteNumber(o.networkHashrate)
  };
}

function parseCoin(raw: unknown): ProjectionCoin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asString(o.id).trim();
  if (!id) return null;
  const rowsRaw = Array.isArray(o.rows) ? o.rows : [];
  const histRaw = Array.isArray(o.blockHistory) ? o.blockHistory : [];
  const distMonth =
    o.distributionUsdMonth == null
      ? null
      : asFiniteNumber(o.distributionUsdMonth);
  const iconRaw = typeof o.iconUrl === 'string' ? o.iconUrl.trim() : '';
  return {
    id,
    symbol: asString(o.symbol, id),
    name: asString(o.name, asString(o.symbol, id)),
    iconUrl: iconRaw || null,
    priceUsd: asFiniteNumber(o.priceUsd),
    distributionMode: asString(o.distributionMode, 'legacy'),
    distributionUsdMonth: distMonth,
    nftRoomOnly: asBool(o.nftRoomOnly),
    independentPool: asBool(o.independentPool),
    userPowerHps: asFiniteNumber(o.userPowerHps),
    networkHps: asFiniteNumber(o.networkHps),
    yieldPerHash: asFiniteNumber(o.yieldPerHash),
    sharePct: asFiniteNumber(o.sharePct),
    coinsPerSec: asFiniteNumber(o.coinsPerSec),
    dailyCoins: asFiniteNumber(o.dailyCoins),
    dailyUsd: asFiniteNumber(o.dailyUsd),
    monthUsd: asFiniteNumber(o.monthUsd),
    rows: rowsRaw.map(parseRow).filter((r): r is ProjectionRow => r != null),
    blockHistory: histRaw
      .map(parseHistory)
      .filter((r): r is ProjectionBlockHistoryRow => r != null)
  };
}

function parseScopeUi(raw: unknown): ProjectionScopeUi | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asString(o.id).trim();
  if (!id) return null;
  return { id, name: asString(o.name, id) };
}

/** Narrow unknown JSON into a typed calculator payload (no `any`). */
export function parseCalculatorProjection(raw: unknown): CalculatorProjectionPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid calculator payload');
  }
  const o = raw as Record<string, unknown>;
  if (o.ok === false) {
    const err = asString(o.error, 'Calculator unavailable');
    throw new Error(err);
  }
  const coinsRaw = Array.isArray(o.coins) ? o.coins : [];
  const scopesRaw = Array.isArray(o.scopesUi) ? o.scopesUi : [];
  return {
    ok: o.ok !== false,
    scope: asString(o.scope, 'total'),
    scopesUi: scopesRaw
      .map(parseScopeUi)
      .filter((s): s is ProjectionScopeUi => s != null),
    checkinFrozen: asBool(o.checkinFrozen),
    generalPowerHps: asFiniteNumber(o.generalPowerHps),
    coins: coinsRaw.map(parseCoin).filter((c): c is ProjectionCoin => c != null)
  };
}

export async function getCalculatorProjection(
  scope?: string,
  signal?: AbortSignal
): Promise<CalculatorProjectionPayload> {
  const q = new URLSearchParams();
  q.set('t', String(Date.now()));
  if (scope && scope.trim()) q.set('scope', scope.trim());
  const res = await apiFetch(`${base}/calculator/me?${q.toString()}`, { signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: unknown = await res.json();
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const err = (j as Record<string, unknown>).error;
        if (typeof err === 'string' && err.trim()) msg = err.trim();
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const body: unknown = await res.json();
  return parseCalculatorProjection(body);
}
