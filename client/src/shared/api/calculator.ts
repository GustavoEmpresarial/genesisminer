/**
 * Player mining calculator — GET `/api/calculator/me?scope=...`
 * POST `/api/calculator/ai-analyze` — análise IA (OpenCode Go no servidor).
 * Routes: `current/server/modules/player-calculator/`
 */
import { apiFetch } from './http';

const base = '/api';

export type PlayerCalculatorCoinComparison = {
  id: string;
  symbol: string;
  name: string;
  priceUSD: number;
  isActivelyMining: boolean;
  dailyCoins: number;
  dailyUsd: number;
  projection30Usd: number;
  rows: Array<{ label: string; coins: number; usd: number }>;
};

export type PlayerCalculatorMeOk = {
  ok: true;
  scope: string;
  scopesUi: { id: string; name: string }[];
  generalPowerHps: number;
  coinComparisons: PlayerCalculatorCoinComparison[];
  coins: Array<{
    id: string;
    symbol: string;
    name: string;
    priceUSD: number;
    networkHashrate: number;
    blockReward: number;
    blockTime: number;
    userPowerHps: number;
    dailyCoins: number;
    dailyUsd: number;
    projection30Usd: number;
    nftRoomOnly: boolean;
    independentPool: boolean;
    rows: Array<{ label: string; coins: number; usd: number }>;
    blockHistory: Array<{
      id: string;
      roomId: string | null;
      windowStartMs: number;
      windowEndMs: number;
      creditedBlocks: number;
      amountCoins: number;
      amountUsd: number;
      userHashHps: number;
      networkHashrate: number;
      blockReward: number;
      blockTime: number;
    }>;
  }>;
};

function parsePlayerCalculatorRows(raw: unknown): { label: string; coins: number; usd: number }[] {
  const rows: { label: string; coins: number; usd: number }[] = [];
  if (!Array.isArray(raw)) return rows;
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label : '';
    const coinsN = Number(row.coins);
    const usdN = Number(row.usd);
    if (label && Number.isFinite(coinsN) && Number.isFinite(usdN)) rows.push({ label, coins: coinsN, usd: usdN });
  }
  return rows;
}

function parsePlayerCalculatorMeBody(body: Record<string, unknown>): PlayerCalculatorMeOk | null {
  if (body.ok !== true) return null;
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'total';
  const scopesRaw = body.scopesUi;
  const scopesUi: { id: string; name: string }[] = [];
  if (Array.isArray(scopesRaw)) {
    for (const x of scopesRaw) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (id && name) scopesUi.push({ id, name });
    }
  }
  const generalPowerHps = Number(body.generalPowerHps);
  const coinComparisons: PlayerCalculatorCoinComparison[] = [];
  if (Array.isArray(body.coinComparisons)) {
    for (const x of body.coinComparisons) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      coinComparisons.push({
        id,
        symbol: typeof o.symbol === 'string' ? o.symbol : id,
        name: typeof o.name === 'string' ? o.name : id,
        priceUSD: Number(o.priceUSD),
        isActivelyMining: Boolean(o.isActivelyMining),
        dailyCoins: Number(o.dailyCoins),
        dailyUsd: Number(o.dailyUsd),
        projection30Usd: Number(o.projection30Usd),
        rows: parsePlayerCalculatorRows(o.rows)
      });
    }
  }
  const coinsRaw = body.coins;
  const coins: PlayerCalculatorMeOk['coins'] = [];
  if (Array.isArray(coinsRaw)) {
    for (const x of coinsRaw) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      const rows = parsePlayerCalculatorRows(o.rows);
      const blockHistory: PlayerCalculatorMeOk['coins'][number]['blockHistory'] = [];
      if (Array.isArray(o.blockHistory)) {
        for (const h of o.blockHistory) {
          if (!h || typeof h !== 'object') continue;
          const item = h as Record<string, unknown>;
          const idRaw = item.id;
          const entryId = typeof idRaw === 'string' ? idRaw : String(idRaw ?? '').trim();
          if (!entryId) continue;
          blockHistory.push({
            id: entryId,
            roomId:
              typeof item.roomId === 'string' && item.roomId.trim()
                ? item.roomId.trim()
                : null,
            windowStartMs: Number(item.windowStartMs),
            windowEndMs: Number(item.windowEndMs),
            creditedBlocks: Number(item.creditedBlocks),
            amountCoins: Number(item.amountCoins),
            amountUsd: Number(item.amountUsd),
            userHashHps: Number(item.userHashHps),
            networkHashrate: Number(item.networkHashrate),
            blockReward: Number(item.blockReward),
            blockTime: Number(item.blockTime)
          });
        }
      }
      coins.push({
        id,
        symbol: typeof o.symbol === 'string' ? o.symbol : id,
        name: typeof o.name === 'string' ? o.name : id,
        priceUSD: Number(o.priceUSD),
        networkHashrate: Number(o.networkHashrate),
        blockReward: Number(o.blockReward),
        blockTime: Number(o.blockTime),
        userPowerHps: Number(o.userPowerHps),
        dailyCoins: Number(o.dailyCoins),
        dailyUsd: Number(o.dailyUsd),
        projection30Usd: Number(o.projection30Usd),
        nftRoomOnly: o.nftRoomOnly === true,
        independentPool: o.independentPool === true,
        rows,
        blockHistory
      });
    }
  }
  return {
    ok: true,
    scope,
    scopesUi,
    generalPowerHps: Number.isFinite(generalPowerHps) ? generalPowerHps : 0,
    coinComparisons,
    coins
  };
}

/**
 * Calculadora de mineração (servidor): hashrate efectivo por moeda, ganhos e tabela de projeções.
 * `scope`: `total` ou id de sala pertencente ao jogador.
 */
export async function getPlayerCalculatorMe(
  scope: string,
  signal?: AbortSignal
): Promise<PlayerCalculatorMeOk | { ok: false; status: number; error?: string; code?: string }> {
  const s = !scope || String(scope).trim() === '' ? 'total' : String(scope).trim();
  const params = new URLSearchParams({ scope: s });
  try {
    const res = await apiFetch(
      `${base}/calculator/me?${params.toString()}&t=${Date.now()}`,
      { headers: { 'Content-Type': 'application/json' }, signal },
      true
    );
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Demasiados pedidos. Aguarda um minuto.', code: 'RATE_LIMIT' };
    }
    if (!res.ok) {
      let error: string | undefined;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j?.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error, code };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const parsed = parsePlayerCalculatorMeBody(body);
    if (!parsed) return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    return parsed;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, status: 0, error: 'aborted', code: 'ABORTED' };
    }
    console.error('[calculator] getPlayerCalculatorMe failed', e);
    return { ok: false, status: 500, error: 'Erro de rede ao carregar a calculadora.' };
  }
}

export type PlayerCalculatorAiAnalyzeOk = {
  ok: true;
  analysisMarkdown: string;
  model: string;
  scope: string;
};

/**
 * Análise IA sobre o snapshot do servidor (só envia `scope`; o Node remonta os números).
 */
export async function postPlayerCalculatorAiAnalyze(
  scope: string,
  signal?: AbortSignal
): Promise<PlayerCalculatorAiAnalyzeOk | { ok: false; status: number; error?: string; code?: string }> {
  const s = !scope || String(scope).trim() === '' ? 'total' : String(scope).trim();
  try {
    const res = await apiFetch(
      `${base}/calculator/ai-analyze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: s }),
        signal
      },
      true
    );
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Demasiados pedidos de IA. Aguarda um minuto.', code: 'RATE_LIMIT' };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    if (!res.ok) {
      const baseError =
        typeof body.error === 'string' && body.error.trim() ? body.error.trim() : undefined;
      const detail =
        typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim() : undefined;
      const error =
        baseError && detail ? `${baseError} (${detail})` : baseError ?? (detail || undefined);
      const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : undefined;
      return { ok: false, status: res.status, error, code };
    }
    if (body.ok !== true) return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    const analysisMarkdown =
      typeof body.analysisMarkdown === 'string' ? body.analysisMarkdown.trim() : '';
    if (!analysisMarkdown) return { ok: false, status: 502, error: 'Análise vazia.' };
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'unknown';
    const scopeOut = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : s;
    return { ok: true, analysisMarkdown, model, scope: scopeOut };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, status: 0, error: 'aborted', code: 'ABORTED' };
    }
    console.error('[calculator] postPlayerCalculatorAiAnalyze failed', e);
    return { ok: false, status: 500, error: 'Erro de rede na análise IA.' };
  }
}
