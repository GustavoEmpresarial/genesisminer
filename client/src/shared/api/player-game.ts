/**
 * Header do jogo (Tokens / USDC / Hash) — fetch sob pedido (sem poll / WS).
 */
import { apiFetch } from './http';

const base = '/api';

export type PlayerGameMiningCoin = {
  id: string;
  name: string;
};

export type PlayerGameHeaderPayload = {
  ok: true;
  coinBalances: Record<string, number>;
  usdc: number;
  hashByCoinId: Record<string, number>;
  totalHash: number;
  serverUpdatedAt: number;
  miningCoins: PlayerGameMiningCoin[];
  estCoinsPerSecByCoinId: Record<string, number>;
  liveAccrualAnchorMs: number;
  headerHighlightCoinId: string;
};

function asFiniteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asNumberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    const n = asFiniteNumber(v, NaN);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export async function getPlayerGameHeader(): Promise<PlayerGameHeaderPayload | null> {
  try {
    const res = await apiFetch(`${base}/player-game/header`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true) return null;
    const miningCoinsRaw = Array.isArray(data.miningCoins) ? data.miningCoins : [];
    const miningCoins: PlayerGameMiningCoin[] = [];
    for (const row of miningCoinsRaw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id.trim() : String(r.id ?? '').trim();
      if (!id) continue;
      const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
      miningCoins.push({ id, name });
    }
    return {
      ok: true,
      coinBalances: asNumberMap(data.coinBalances),
      usdc: asFiniteNumber(data.usdc),
      hashByCoinId: asNumberMap(data.hashByCoinId),
      totalHash: Math.max(0, asFiniteNumber(data.totalHash)),
      serverUpdatedAt: asFiniteNumber(data.serverUpdatedAt, Date.now()),
      miningCoins,
      estCoinsPerSecByCoinId: asNumberMap(data.estCoinsPerSecByCoinId),
      liveAccrualAnchorMs: asFiniteNumber(data.liveAccrualAnchorMs),
      headerHighlightCoinId: typeof data.headerHighlightCoinId === 'string' ? data.headerHighlightCoinId : ''
    };
  } catch {
    return null;
  }
}

export type PlayerGameNavItemDto = {
  key: string;
  section: string;
  accent: string;
};

export type PlayerGameNavPayload = {
  ok: true;
  sectionOrder: string[];
  items: PlayerGameNavItemDto[];
};

/** Estrutura do menu lateral — `GET /api/player-game/nav` (Rust/TS no server). */
export async function getPlayerGameNav(opts?: { managing?: boolean }): Promise<PlayerGameNavPayload | null> {
  try {
    const q = opts?.managing ? '?managing=1' : '';
    const res = await apiFetch(`${base}/player-game/nav${q}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true || !Array.isArray(data.items)) return null;
    const sectionOrder = Array.isArray(data.sectionOrder)
      ? data.sectionOrder.filter((s): s is string => typeof s === 'string')
      : [];
    const items: PlayerGameNavItemDto[] = [];
    for (const row of data.items) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const key = typeof r.key === 'string' ? r.key.trim() : '';
      const section = typeof r.section === 'string' ? r.section.trim() : '';
      const accent = typeof r.accent === 'string' ? r.accent.trim() : '';
      if (!key || !section || !accent) continue;
      items.push({ key, section, accent });
    }
    return { ok: true, sectionOrder, items };
  } catch {
    return null;
  }
}

export async function patchHeaderHighlightCoin(coinId: string): Promise<void> {
  try {
    await apiFetch(`${base}/player-game/header/highlight`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coinId })
    });
  } catch {
    /* ignore */
  }
}
