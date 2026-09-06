/**
 * Admin mining-coin catalog + economy apply/sync endpoints.
 * Extracted from admin-legacy (AdminEconomy / AdminReports / coin editor).
 */
import { apiFetch } from './http';
import { MINING_COINS_WRITE_PATH, inactivateMiningCoin } from '../../features/admin/lib/miningCoinWrite';

const base = '/api';

function parseJsonArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export async function getMiningCoins(): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${base}/mining-coins`);
    if (!res.ok) return [];
    try {
      const raw = await res.json();
      if (Array.isArray(raw)) return parseJsonArray(raw);
      if (raw && typeof raw === 'object' && Array.isArray((raw as { coins?: unknown[] }).coins)) {
        return parseJsonArray((raw as { coins: unknown[] }).coins);
      }
      return [];
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/** Aceita vírgula decimal (ex.: 0,11) e evita NaN ao guardar moedas no admin. */
function parseLocaleNumber(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (input === null || input === undefined) return fallback;
  const str = String(input).trim().replace(/\s/g, '');
  if (!str) return fallback;
  let s = str;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && (!hasDot || s.lastIndexOf(',') > s.lastIndexOf('.'))) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

/** Normaliza payload antes de POST /api/mining-coins (evita blockReward=1 por NaN e preço errado). */
/** Tempo de bloco fixo na economia do simulador (10 minutos). */
export const MINING_BLOCK_TIME_SECONDS = 600;

function roundMiningFieldTo8Decimals(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e8) / 1e8;
}

export function normalizeMiningCoinPayload(coin: Record<string, unknown>): Record<string, unknown> {
  const networkHashrateRaw = parseLocaleNumber(coin.networkHashrate, NaN);
  const networkHashrate =
    Number.isFinite(networkHashrateRaw) && networkHashrateRaw > 0
      ? roundMiningFieldTo8Decimals(networkHashrateRaw)
      : NaN;
  const blockReward = roundMiningFieldTo8Decimals(Math.max(0, parseLocaleNumber(coin.blockReward, 0)));
  const blockTimeRaw = parseLocaleNumber(coin.blockTime, MINING_BLOCK_TIME_SECONDS);
  const blockTime = Math.min(86400, Math.max(1, Math.round(blockTimeRaw)));
  const usdcRaw = parseLocaleNumber(coin.usdcRate ?? coin.usdc_rate, NaN);
  const usdcRate = roundMiningFieldTo8Decimals(Number.isFinite(usdcRaw) && usdcRaw >= 0 ? usdcRaw : NaN);
  const priceUSDRaw = parseLocaleNumber(coin.priceUSD, NaN);
  const priceUSDFromLegacy = Number.isFinite(priceUSDRaw) && priceUSDRaw >= 0 ? priceUSDRaw : NaN;
  const canonicalRate = Number.isFinite(usdcRate) && usdcRate > 0 ? usdcRate : priceUSDFromLegacy;
  const multiplier = roundMiningFieldTo8Decimals(Math.max(1, parseLocaleNumber(coin.multiplier, 1)));
  const minProportion = roundMiningFieldTo8Decimals(Math.max(0, parseLocaleNumber(coin.minProportion, 0)));
  const targetDailyUSD = roundMiningFieldTo8Decimals(Math.max(0, parseLocaleNumber(coin.targetDailyUSD, 0)));
  const difficulty = roundMiningFieldTo8Decimals(Math.max(1, parseLocaleNumber(coin.difficulty, 1)));
  return {
    ...coin,
    networkHashrate,
    blockReward,
    blockTime,
    usdcRate: canonicalRate,
    priceUSD: canonicalRate,
    multiplier: multiplier > 0 ? multiplier : 1,
    minProportion: Math.max(0, minProportion),
    difficulty: difficulty > 0 ? difficulty : 1,
    targetDailyUSD: Math.max(0, targetDailyUSD)
  };
}

export async function saveMiningCoin(coin: unknown): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const rawCoin =
      coin && typeof coin === 'object' && !Array.isArray(coin)
        ? (coin as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const payload = normalizeMiningCoinPayload(rawCoin);
    const res = await apiFetch(MINING_COINS_WRITE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Save failed' }; }
    }
    let data: { ok?: boolean; id?: string; error?: string } = { ok: true };
    try { data = await res.json(); } catch { /* body vazio: { ok: true } do backend */ }
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    return { ok: data.ok !== false, id: data.id || id, error: data.error };
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function deleteMiningCoin(id: string): Promise<{ ok: boolean; error?: string }> {
  return inactivateMiningCoin(id, {
    loadCoins: loadMiningCoinsForWrite,
    saveCoin: (coin) => saveMiningCoin(coin)
  });
}

async function loadMiningCoinsForWrite(): Promise<Array<{ id?: string } & Record<string, unknown>>> {
  const res = await apiFetch(`${base}/mining-coins`);
  if (!res.ok) throw new Error(`Erro de API (${res.status})`);
  const raw = await res.json();
  if (Array.isArray(raw)) return parseJsonArray(raw);
  if (raw && typeof raw === 'object' && Array.isArray((raw as { coins?: unknown[] }).coins)) {
    return parseJsonArray((raw as { coins: unknown[] }).coins);
  }
  throw new Error('Erro de API ao ler moedas.');
}

export async function getEconomyStats(): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${base}/admin/economy-stats`);
    if (!res.ok) throw new Error('Failed to fetch');
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('economy-stats: resposta não é lista');
    return raw;
  } catch {
    throw new Error('Network Error');
  }
}

/** GET /api/admin/mining-runtime-summary — hashrates / miners ao vivo (workers). */
export type MiningRuntimeSummary = {
  realActiveMiners: number;
  realNetworkHashrates: Record<string, number>;
  activeMinersByCoin: Record<string, number>;
};

function coerceNumberRecord(o: unknown): Record<string, number> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export async function getMiningRuntimeSummary(): Promise<MiningRuntimeSummary | null> {
  try {
    const res = await apiFetch(`${base}/admin/mining-runtime-summary`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<MiningRuntimeSummary>;
    const n = Number(j.realActiveMiners);
    return {
      realActiveMiners: Number.isFinite(n) ? n : 0,
      realNetworkHashrates: coerceNumberRecord(j.realNetworkHashrates),
      activeMinersByCoin: coerceNumberRecord(j.activeMinersByCoin)
    };
  } catch {
    return null;
  }
}

export async function updateEconomySettings(coinId: string, networkHashrate: number, blockReward: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/economy-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coinId, networkHashrate, blockReward })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, error: data.error };
  } catch {
    return { ok: false, error: 'Network Error' };
  }
}

export async function syncMiningCoinLivePricesNow(): Promise<{ ok: boolean; updated?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/mining-coins/sync-live-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; updated?: number; error?: string };
    if (!res.ok) return { ok: false, updated: data.updated, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, updated: data.updated, error: data.error };
  } catch {
    return { ok: false, error: 'Network Error' };
  }
}

