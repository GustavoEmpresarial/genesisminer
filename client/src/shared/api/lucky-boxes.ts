/**
 * Caixas da Sorte — player API.
 * Routes: GET /api/lucky-boxes/state, POST purchase/open/discard/promocodes/redeem
 */
import { apiFetch } from './http';

const base = '/api';

/** Alinhar com nginx 300s em /api/lucky-boxes/ */
const LUCKY_BOX_OPEN_FETCH_MS = 300_000;

export type LuckyBoxRewardSlotPublic = {
  kind: string;
  /** id do upgrade/caixa no catálogo (para arte da loja). */
  itemId?: string;
  label: string;
  rangeText: string;
  chanceText?: string;
  /** URL/caminho da imagem real do prémio (`upgrades.image`). */
  icon?: string;
};

export type LuckyBoxShopEntryV1 = {
  id: string;
  name: string;
  description: string;
  icon: string;
  priceUsdc: number;
  currency: 'USDC';
  trigger: string;
  maxPerOrder: number;
  stockRemaining: number | null;
  rewardSummary: { slotCount: number; slots: LuckyBoxRewardSlotPublic[] };
};

export type LuckyBoxInventoryEntryV1 = {
  boxId: string;
  qty: number;
  name: string;
  description: string;
  icon: string;
  trigger: string;
  openableHere: boolean;
  rewardSummary: { slotCount: number; slots: LuckyBoxRewardSlotPublic[] };
};

export type LuckyBoxOpeningReward = {
  type: string;
  id: string;
  qty: number;
};

export type LuckyBoxesStateV1Ok = {
  ok: true;
  version: 1;
  usdc: number;
  banner: { text: string; variant: 'info' | 'warning' } | null;
  promoHelp: string;
  roulettePromoNote: string;
  shop: LuckyBoxShopEntryV1[];
  shopEmptyMessage: string;
  inventory: LuckyBoxInventoryEntryV1[];
};

export function newLuckyBoxIdempotencyKey(prefix = 'lb'): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function parseRewardSlot(raw: unknown): LuckyBoxRewardSlotPublic | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label : '';
  if (!label) return null;
  return {
    kind: typeof r.kind === 'string' ? r.kind : '',
    itemId: typeof r.itemId === 'string' && r.itemId.trim() ? r.itemId.trim() : undefined,
    label,
    rangeText: typeof r.rangeText === 'string' ? r.rangeText : '',
    chanceText: typeof r.chanceText === 'string' && r.chanceText.trim() ? r.chanceText.trim() : undefined,
    icon: typeof r.icon === 'string' && r.icon.trim() ? r.icon.trim() : undefined
  };
}

function parseRewardSummary(raw: unknown): { slotCount: number; slots: LuckyBoxRewardSlotPublic[] } {
  if (!raw || typeof raw !== 'object') return { slotCount: 0, slots: [] };
  const r = raw as Record<string, unknown>;
  const slots: LuckyBoxRewardSlotPublic[] = [];
  if (Array.isArray(r.slots)) {
    for (const s of r.slots) {
      const slot = parseRewardSlot(s);
      if (slot) slots.push(slot);
    }
  }
  const slotCount = Number.isFinite(Number(r.slotCount)) ? Math.max(0, Math.floor(Number(r.slotCount))) : slots.length;
  return { slotCount, slots };
}

function parseShopEntry(raw: unknown): LuckyBoxShopEntryV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  const priceUsdc = Number(r.priceUsdc);
  return {
    id,
    name: typeof r.name === 'string' ? r.name : id,
    description: typeof r.description === 'string' ? r.description : '',
    icon: typeof r.icon === 'string' ? r.icon : '',
    priceUsdc: Number.isFinite(priceUsdc) ? priceUsdc : 0,
    currency: 'USDC',
    trigger: typeof r.trigger === 'string' ? r.trigger : '',
    maxPerOrder: Number.isFinite(Number(r.maxPerOrder)) ? Math.max(1, Math.floor(Number(r.maxPerOrder))) : 1,
    stockRemaining:
      r.stockRemaining == null
        ? null
        : Number.isFinite(Number(r.stockRemaining))
          ? Math.max(0, Math.floor(Number(r.stockRemaining)))
          : null,
    rewardSummary: parseRewardSummary(r.rewardSummary)
  };
}

function parseInventoryEntry(raw: unknown): LuckyBoxInventoryEntryV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const boxId = typeof r.boxId === 'string' ? r.boxId.trim() : '';
  if (!boxId) return null;
  const qty = Math.floor(Number(r.qty));
  if (!Number.isInteger(qty) || qty <= 0) return null;
  return {
    boxId,
    qty,
    name: typeof r.name === 'string' ? r.name : boxId,
    description: typeof r.description === 'string' ? r.description : '',
    icon: typeof r.icon === 'string' ? r.icon : '',
    trigger: typeof r.trigger === 'string' ? r.trigger : '',
    openableHere: r.openableHere !== false,
    rewardSummary: parseRewardSummary(r.rewardSummary)
  };
}

export function parseLuckyBoxesStateV1Body(body: Record<string, unknown>): LuckyBoxesStateV1Ok | null {
  // Aceitar version ausente se shop/inventory presentes (proxies/cache)
  if (body.version != null && body.version !== 1) return null;
  const usdcRaw = Number(body.usdc);
  const usdc = Number.isFinite(usdcRaw) && usdcRaw >= 0 ? usdcRaw : 0;

  const shop: LuckyBoxShopEntryV1[] = [];
  if (Array.isArray(body.shop)) {
    for (const row of body.shop) {
      const e = parseShopEntry(row);
      if (e) shop.push(e);
    }
  }

  const inventory: LuckyBoxInventoryEntryV1[] = [];
  if (Array.isArray(body.inventory)) {
    for (const row of body.inventory) {
      const e = parseInventoryEntry(row);
      if (e) inventory.push(e);
    }
  }

  let banner: LuckyBoxesStateV1Ok['banner'] = null;
  if (body.banner && typeof body.banner === 'object' && !Array.isArray(body.banner)) {
    const b = body.banner as Record<string, unknown>;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text) {
      banner = {
        text,
        variant: b.variant === 'warning' ? 'warning' : 'info'
      };
    }
  }

  return {
    ok: true,
    version: 1,
    usdc,
    banner,
    promoHelp: typeof body.promoHelp === 'string' ? body.promoHelp : '',
    roulettePromoNote: typeof body.roulettePromoNote === 'string' ? body.roulettePromoNote : '',
    shop,
    shopEmptyMessage: typeof body.shopEmptyMessage === 'string' ? body.shopEmptyMessage : '',
    inventory
  };
}

function parseOpenRewards(raw: unknown): LuckyBoxOpeningReward[] {
  if (!Array.isArray(raw)) return [];
  const out: LuckyBoxOpeningReward[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type : 'item';
    const id = typeof r.id === 'string' ? r.id : String(r.id ?? '');
    const qty = Number(r.qty);
    out.push({ type, id, qty: Number.isFinite(qty) ? qty : 0 });
  }
  return out;
}

export async function getLuckyBoxesState(): Promise<
  LuckyBoxesStateV1Ok | { ok: false; status: number; error?: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/lucky-boxes/state?t=${Date.now()}`);
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: 'Demasiados pedidos. Aguarda um minuto.',
        code: 'RATE_LIMIT'
      };
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
      return { ok: false, status: 502, error: 'Resposta inválida.' };
    }
    const parsed = parseLuckyBoxesStateV1Body(body);
    if (!parsed) return { ok: false, status: 502, error: 'Resposta inválida.' };
    return parsed;
  } catch (e) {
    console.error('[lucky-boxes] getLuckyBoxesState failed', e);
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function postLuckyBoxPurchase(body: {
  boxId: string;
  email?: string;
  quantity?: number;
  idempotencyKey?: string;
}): Promise<{
  ok: boolean;
  newUsdc?: number;
  qtyPurchased?: number;
  boxId?: string;
  inventory?: LuckyBoxInventoryEntryV1[];
  error?: string;
  missing?: number;
}> {
  try {
    const payload: Record<string, unknown> = { boxId: body.boxId };
    if (body.email?.trim()) payload.email = body.email.trim();
    if (body.quantity != null && Number.isFinite(body.quantity) && body.quantity >= 1) {
      payload.quantity = Math.floor(body.quantity);
    }
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      newUsdc?: number;
      qtyPurchased?: number;
      missing?: number;
      boxId?: string;
      inventory?: unknown;
    };
    if (!res.ok) {
      const missing =
        typeof data.missing === 'number' && Number.isFinite(data.missing) && data.missing > 0
          ? data.missing
          : undefined;
      return { ok: false, error: data.error || `Erro HTTP ${res.status}`, missing };
    }
    const newUsdc = typeof data.newUsdc === 'number' && Number.isFinite(data.newUsdc) ? data.newUsdc : undefined;
    const inventory: LuckyBoxInventoryEntryV1[] = [];
    if (Array.isArray(data.inventory)) {
      for (const row of data.inventory) {
        const e = parseInventoryEntry(row);
        if (e) inventory.push(e);
      }
    }
    return {
      ok: !!data.ok,
      newUsdc,
      qtyPurchased: data.qtyPurchased,
      boxId: typeof data.boxId === 'string' ? data.boxId : body.boxId,
      inventory: inventory.length > 0 ? inventory : undefined
    };
  } catch (e) {
    console.error('[lucky-boxes] postLuckyBoxPurchase failed', e);
    return { ok: false, error: 'Erro de rede.' };
  }
}

/** Fallback leve quando GET /state falha após compra/abertura. */
export async function getLuckyBoxesInventory(): Promise<
  { ok: true; inventory: LuckyBoxInventoryEntryV1[] } | { ok: false; error?: string }
> {
  try {
    const res = await apiFetch(`${base}/lucky-boxes/inventory?t=${Date.now()}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { inventory?: unknown };
    const inventory: LuckyBoxInventoryEntryV1[] = [];
    if (Array.isArray(body.inventory)) {
      for (const row of body.inventory) {
        const e = parseInventoryEntry(row);
        if (e) inventory.push(e);
      }
    }
    return { ok: true, inventory };
  } catch (e) {
    console.error('[lucky-boxes] getLuckyBoxesInventory failed', e);
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postLuckyBoxOpen(body: {
  boxId: string;
  email?: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; rewards?: LuckyBoxOpeningReward[]; openingId?: string; error?: string }> {
  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), LUCKY_BOX_OPEN_FETCH_MS);
  try {
    const payload: Record<string, unknown> = { boxId: body.boxId };
    if (body.email?.trim()) payload.email = body.email.trim();
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      rewards?: unknown;
      openingId?: string;
      error?: string;
    };
    if (!res.ok) {
      if (res.status === 524 || res.status === 504) {
        return {
          ok: false,
          error:
            'Timeout ao abrir a caixa. Recarrega e verifica o inventário antes de repetir — a abertura pode ter ficado registada (idempotência).'
        };
      }
      return { ok: false, error: data.error || `Erro HTTP ${res.status}` };
    }
    return {
      ok: !!data.ok,
      rewards: parseOpenRewards(data.rewards),
      openingId: typeof data.openingId === 'string' ? data.openingId : undefined
    };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error:
          'Sem resposta do servidor após vários minutos. Recarrega e verifica o inventário — a abertura pode ter ficado registada (idempotência).'
      };
    }
    console.error('[lucky-boxes] postLuckyBoxOpen failed', e);
    return { ok: false, error: 'Erro de rede.' };
  } finally {
    clearTimeout(kill);
  }
}

export async function postLuckyBoxDiscard(body: {
  boxId: string;
  email?: string;
  qty?: number;
}): Promise<{ ok: boolean; error?: string; discardedQty?: number; remainingQty?: number }> {
  try {
    const payload: Record<string, unknown> = { boxId: body.boxId };
    if (body.email?.trim()) payload.email = body.email.trim();
    if (body.qty != null && Number.isFinite(body.qty) && body.qty > 0) payload.qty = Math.floor(body.qty);
    const res = await apiFetch(`${base}/lucky-boxes/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      discardedQty?: number;
      remainingQty?: number;
    };
    if (!res.ok) return { ok: false, error: data.error || 'Erro ao descartar.' };
    return {
      ok: !!data.ok,
      discardedQty: data.discardedQty,
      remainingQty: data.remainingQty
    };
  } catch (e) {
    console.error('[lucky-boxes] postLuckyBoxDiscard failed', e);
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function redeemLuckyBoxPromoCode(body: {
  code: string;
  idempotencyKey?: string;
}): Promise<{
  ok: boolean;
  type?: 'roleta' | 'standard';
  code?: string;
  unopenedBoxes?: Record<string, number>;
  stock?: Record<string, number>;
  lootBoxId?: string | null;
  error?: string;
}> {
  try {
    const payload: Record<string, unknown> = { code: body.code.trim() };
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/promocodes/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Erro HTTP ${res.status}`
      };
    }
    if (data.type === 'roleta') {
      return { ok: true, type: 'roleta', code: typeof data.code === 'string' ? data.code : undefined };
    }
    return {
      ok: true,
      type: 'standard',
      unopenedBoxes: data.unopenedBoxes as Record<string, number> | undefined,
      stock: data.stock as Record<string, number> | undefined,
      lootBoxId: (data.lootBoxId as string | null | undefined) ?? null
    };
  } catch (e) {
    console.error('[lucky-boxes] redeemLuckyBoxPromoCode failed', e);
    return { ok: false, error: 'Erro de rede.' };
  }
}
