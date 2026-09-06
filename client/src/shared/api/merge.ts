/**
 * Merge Station — player API.
 * Routes: GET /api/merge/config|inventory|history, POST /api/merge/execute
 */
import { apiFetch } from './http';

const base = '/api';

export type MergeInventoryItem = {
  itemId: string;
  qty: number;
  name: string;
  type: 'machine' | 'multiplier' | 'infrastructure';
  rarity: string;
  resultRarity: string | null;
  baseCost: number;
  baseProduction: number;
  powerConsumption: number | null;
  multiplier: number | null;
  image: string | null;
  icon: string;
  feeUsdc: number;
  maxMerges?: number;
  canMerge: boolean;
  blockReason: string | null;
  preview: {
    resultRarity: string;
    name: string;
    baseCost: number;
    baseProduction: number;
    powerConsumption: number | null;
    multiplier: number | null;
    feeUsdc: number;
    costPct: number;
    gainPercent: number;
  } | null;
};

export type MergePublicConfig = {
  enabled: boolean;
  enabledByType: {
    machine: boolean;
    multiplier: boolean;
    infrastructure: boolean;
  };
  allowedTypes: Array<'machine' | 'multiplier' | 'infrastructure'>;
};

export type MergeHistorySummaryRow = {
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  mergeCount: number;
  feeTotalUsdc: number;
  lastAt: number;
};

export type MergeHistoryEntry = {
  id: string;
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  feeUsdc: number;
  createdAt: number;
};

export async function getMergeConfig(): Promise<{ ok: boolean; config?: MergePublicConfig; error?: string }> {
  try {
    const res = await apiFetch(`${base}/merge/config`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    const rawByType = (data.enabledByType as Record<string, unknown> | undefined) || {};
    const allowedRaw = Array.isArray(data.allowedTypes) ? data.allowedTypes : [];
    const allowedTypes = allowedRaw.filter(
      (t): t is 'machine' | 'multiplier' | 'infrastructure' =>
        t === 'machine' || t === 'multiplier' || t === 'infrastructure'
    );
    return {
      ok: true,
      config: {
        enabled: data.enabled !== false,
        enabledByType: {
          machine: rawByType.machine !== false,
          multiplier: rawByType.multiplier !== false,
          infrastructure: rawByType.infrastructure !== false
        },
        allowedTypes
      }
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getMergeInventory(): Promise<{ ok: boolean; items?: MergeInventoryItem[]; error?: string }> {
  try {
    const res = await apiFetch(`${base}/merge/inventory`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      items?: MergeInventoryItem[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getMergeHistory(limit = 40): Promise<{
  ok: boolean;
  totalMerges?: number;
  feeTotalUsdc?: number;
  summary?: MergeHistorySummaryRow[];
  recent?: MergeHistoryEntry[];
  error?: string;
}> {
  try {
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
    const res = await apiFetch(`${base}/merge/history?limit=${n}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      };
    }
    return {
      ok: true,
      totalMerges: typeof data.totalMerges === 'number' ? data.totalMerges : 0,
      feeTotalUsdc: typeof data.feeTotalUsdc === 'number' ? data.feeTotalUsdc : 0,
      summary: Array.isArray(data.summary) ? (data.summary as MergeHistorySummaryRow[]) : [],
      recent: Array.isArray(data.recent) ? (data.recent as MergeHistoryEntry[]) : []
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function postMergeExecute(
  itemId: string,
  count: number = 1
): Promise<{
  ok: boolean;
  error?: string;
  feeUsdc?: number;
  feeUnitUsdc?: number;
  count?: number;
  newUsdc?: number;
  resultItemId?: string;
  result?: { id: string; name: string; resultRarity: string };
}> {
  try {
    const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
    const res = await apiFetch(`${base}/merge/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, count: n })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      };
    }
    return {
      ok: true,
      feeUsdc: typeof data.feeUsdc === 'number' ? data.feeUsdc : undefined,
      feeUnitUsdc: typeof data.feeUnitUsdc === 'number' ? data.feeUnitUsdc : undefined,
      count: typeof data.count === 'number' ? data.count : n,
      newUsdc: typeof data.newUsdc === 'number' ? data.newUsdc : undefined,
      resultItemId: typeof data.resultItemId === 'string' ? data.resultItemId : undefined,
      result: data.result as { id: string; name: string; resultRarity: string } | undefined
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
