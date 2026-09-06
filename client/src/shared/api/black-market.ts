/**
 * Mercado Negro P2P — player API (`/api/black-market/*`).
 */
import { apiFetch } from './http';

const base = '/api';

export type BlackMarketListing = {
  id: string;
  sellerId?: number;
  sellerName: string;
  itemId: string;
  price: number;
  qty: number;
  lineTotal?: number;
  buyerPaidUsdc?: number;
  expiresAt: number;
  reservedBy?: string;
  reservedUntil?: number;
  status?: 'active' | 'sold';
};

export type BlackMarketHistoryEntry = {
  at: number;
  itemId: string;
  qty: number;
  unitPrice: number;
  buyerPaidUsdc: number;
  sellerReceivedUsdc: number;
  taxUsdc: number;
  counterpartName: string;
};

export type BlackMarketStateV1Ok = {
  ok: true;
  version: 1;
  enabled: boolean;
  usdc: number;
  blackMarketBalance: number;
  priceBandPercent: number;
  listings: { items: BlackMarketListing[]; total: number; limit: number; offset: number };
  myActiveListings: BlackMarketListing[];
  custody: BlackMarketListing[];
  sellableStock: Array<{ itemId: string; qty: number; baseCost?: number }>;
  buyFilterCategories: string[];
  history: { purchases: BlackMarketHistoryEntry[]; sales: BlackMarketHistoryEntry[]; limit: number };
};

function parseMarketListingRow(raw: unknown): BlackMarketListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const sellerName = typeof r.sellerName === 'string' ? r.sellerName.trim() : '';
  const sellerIdRaw = r.sellerId ?? r.seller_id;
  const sellerId =
    typeof sellerIdRaw === 'number' && Number.isFinite(sellerIdRaw) && sellerIdRaw > 0
      ? Math.floor(sellerIdRaw)
      : typeof sellerIdRaw === 'string' && /^\d+$/.test(sellerIdRaw.trim())
        ? parseInt(sellerIdRaw.trim(), 10)
        : undefined;
  const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : '';
  if (!id || !itemId) return null;
  const price = Number(r.price);
  const qty = Math.max(1, Math.floor(Number(r.qty)) || 1);
  const lineTotal =
    r.lineTotal != null && Number.isFinite(Number(r.lineTotal)) ? Number(r.lineTotal) : price * qty;
  return {
    id,
    sellerId,
    sellerName,
    itemId,
    price: Number.isFinite(price) ? price : 0,
    qty,
    lineTotal,
    buyerPaidUsdc: r.buyerPaidUsdc != null ? Number(r.buyerPaidUsdc) : undefined,
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : parseInt(String(r.expiresAt ?? '0'), 10) || 0,
    reservedBy: typeof r.reservedBy === 'string' ? r.reservedBy : undefined,
    reservedUntil:
      typeof r.reservedUntil === 'number' ? r.reservedUntil : r.reservedUntil != null ? Number(r.reservedUntil) : undefined,
    status: r.status === 'active' || r.status === 'sold' ? r.status : undefined
  };
}

function parseHistoryRow(raw: unknown): BlackMarketHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const itemId = typeof r.itemId === 'string' ? r.itemId : '';
  if (!itemId) return null;
  return {
    at: typeof r.at === 'number' ? r.at : parseInt(String(r.at ?? '0'), 10) || 0,
    itemId,
    qty: Math.max(1, parseInt(String(r.qty ?? 1), 10) || 1),
    unitPrice: Number(r.unitPrice) || 0,
    buyerPaidUsdc: Number(r.buyerPaidUsdc) || 0,
    sellerReceivedUsdc: Number(r.sellerReceivedUsdc) || 0,
    taxUsdc: Number(r.taxUsdc) || 0,
    counterpartName: typeof r.counterpartName === 'string' ? r.counterpartName : '—'
  };
}

function parseBlackMarketStateBody(raw: Record<string, unknown>): BlackMarketStateV1Ok | null {
  if (raw.version !== 1) return null;
  const listingsRaw = raw.listings;
  if (!listingsRaw || typeof listingsRaw !== 'object' || Array.isArray(listingsRaw)) return null;
  const lr = listingsRaw as Record<string, unknown>;
  const arr = Array.isArray(lr.items) ? lr.items : [];
  const items: BlackMarketListing[] = [];
  for (const x of arr) {
    const m = parseMarketListingRow(x);
    if (m) items.push(m);
  }
  const myRaw = Array.isArray(raw.myActiveListings) ? raw.myActiveListings : [];
  const myActiveListings = myRaw.map(parseMarketListingRow).filter((x): x is BlackMarketListing => x != null);
  const custRaw = Array.isArray(raw.custody) ? raw.custody : [];
  const custody = custRaw.map(parseMarketListingRow).filter((x): x is BlackMarketListing => x != null);
  const sellRaw = Array.isArray(raw.sellableStock) ? raw.sellableStock : [];
  const sellableStock: Array<{ itemId: string; qty: number; baseCost?: number }> = [];
  for (const s of sellRaw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId : '';
    const qty = Math.floor(Number(o.qty));
    if (!itemId || !Number.isFinite(qty)) continue;
    const bc = Number(o.baseCost);
    sellableStock.push({
      itemId,
      qty,
      baseCost: Number.isFinite(bc) && bc > 0 ? bc : undefined
    });
  }
  const catRaw = Array.isArray(raw.buyFilterCategories) ? raw.buyFilterCategories : [];
  const buyFilterCategories = catRaw
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());
  const histRaw = raw.history;
  const histPurch: BlackMarketHistoryEntry[] = [];
  const histSales: BlackMarketHistoryEntry[] = [];
  if (histRaw && typeof histRaw === 'object' && !Array.isArray(histRaw)) {
    const h = histRaw as Record<string, unknown>;
    if (Array.isArray(h.purchases)) {
      for (const x of h.purchases) {
        const p = parseHistoryRow(x);
        if (p) histPurch.push(p);
      }
    }
    if (Array.isArray(h.sales)) {
      for (const x of h.sales) {
        const p = parseHistoryRow(x);
        if (p) histSales.push(p);
      }
    }
  }
  return {
    ok: true,
    version: 1,
    enabled: raw.enabled !== false,
    usdc: Number(raw.usdc) || 0,
    blackMarketBalance: Number(raw.blackMarketBalance) || 0,
    priceBandPercent: Number(raw.priceBandPercent) || 20,
    listings: {
      items,
      total: Number.isFinite(Number(lr.total)) ? Number(lr.total) : items.length,
      limit: Number.isFinite(Number(lr.limit)) ? Number(lr.limit) : 60,
      offset: Number.isFinite(Number(lr.offset)) ? Number(lr.offset) : 0
    },
    myActiveListings,
    custody,
    sellableStock,
    buyFilterCategories,
    history: {
      purchases: histPurch,
      sales: histSales,
      limit:
        typeof (histRaw as Record<string, unknown> | undefined)?.limit === 'number'
          ? ((histRaw as { limit: number }).limit as number)
          : 80
    }
  };
}

export async function getBlackMarketState(): Promise<
  BlackMarketStateV1Ok | { ok: false; status: number; error?: string }
> {
  try {
    const res = await apiFetch(`${base}/black-market/state?t=${Date.now()}`);
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j?.error === 'string') error = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const parsed = parseBlackMarketStateBody(raw);
    if (!parsed) return { ok: false, status: 502, error: 'Resposta inválida.' };
    return parsed;
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export type BlackMarketListingsPageOk = {
  ok: true;
  items: BlackMarketListing[];
  total: number;
  limit: number;
  offset: number;
};

export async function getBlackMarketListingsPage(params: {
  search?: string;
  category?: string;
  type?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): Promise<BlackMarketListingsPageOk | { ok: false; status: number; error?: string }> {
  const sp = new URLSearchParams();
  if (params.search?.trim()) sp.set('q', params.search.trim());
  if (params.category?.trim()) sp.set('category', params.category.trim());
  if (params.type?.trim()) sp.set('type', params.type.trim());
  if (params.sort) sp.set('sort', params.sort);
  if (params.limit != null) sp.set('limit', String(params.limit));
  if (params.offset != null) sp.set('offset', String(params.offset));
  try {
    const res = await apiFetch(`${base}/black-market/listings?${sp.toString()}&t=${Date.now()}`);
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j?.error === 'string') error = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    if (raw.version !== 1) return { ok: false, status: 502, error: 'Resposta inválida.' };
    const arr = Array.isArray(raw.items) ? raw.items : [];
    const items = arr.map(parseMarketListingRow).filter((x): x is BlackMarketListing => x != null);
    return {
      ok: true,
      items,
      total: Number(raw.total) || 0,
      limit: Number(raw.limit) || 60,
      offset: Number(raw.offset) || 0
    };
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function getBlackMarketEscrow(): Promise<BlackMarketListing[]> {
  try {
    const res = await apiFetch(`${base}/black-market/escrow?t=${Date.now()}`);
    if (!res.ok) return [];
    const raw = (await res.json()) as Record<string, unknown>;
    const arr = Array.isArray(raw.items) ? raw.items : [];
    return arr.map(parseMarketListingRow).filter((x): x is BlackMarketListing => x != null);
  } catch {
    return [];
  }
}

export async function getBlackMarketHistory(limit = 80): Promise<{
  purchases: BlackMarketHistoryEntry[];
  sales: BlackMarketHistoryEntry[];
}> {
  try {
    const res = await apiFetch(`${base}/black-market/history?limit=${limit}&t=${Date.now()}`);
    if (!res.ok) return { purchases: [], sales: [] };
    const raw = (await res.json()) as Record<string, unknown>;
    const purchases = Array.isArray(raw.purchases)
      ? raw.purchases.map(parseHistoryRow).filter((x): x is BlackMarketHistoryEntry => x != null)
      : [];
    const sales = Array.isArray(raw.sales)
      ? raw.sales.map(parseHistoryRow).filter((x): x is BlackMarketHistoryEntry => x != null)
      : [];
    return { purchases, sales };
  } catch {
    return { purchases: [], sales: [] };
  }
}

export async function postBlackMarketSell(
  itemId: string,
  price: number,
  qty: number
): Promise<{ ok: boolean; listingId?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/black-market/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, price, qty })
    });
    if (!res.ok) {
      try {
        return (await res.json()) as { ok: boolean; error?: string };
      } catch {
        return { ok: false, error: 'Erro ao publicar oferta.' };
      }
    }
    try {
      return (await res.json()) as { ok: boolean; listingId?: string; error?: string };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postBlackMarketCancel(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/black-market/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId })
    });
    if (!res.ok) {
      try {
        return (await res.json()) as { ok: boolean; error?: string };
      } catch {
        return { ok: false, error: 'Erro ao cancelar.' };
      }
    }
    try {
      return (await res.json()) as { ok: boolean; error?: string };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postBlackMarketReserve(
  listingId: string
): Promise<{ ok: boolean; error?: string; reservedUntil?: number }> {
  try {
    const res = await apiFetch(`${base}/black-market/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId })
    });
    try {
      return (await res.json()) as { ok: boolean; error?: string; reservedUntil?: number };
    } catch {
      return { ok: false, error: 'Reserva falhou.' };
    }
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postBlackMarketCancelReserve(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/black-market/cancel-reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId })
    });
    try {
      return (await res.json()) as { ok: boolean; error?: string };
    } catch {
      return { ok: false, error: 'Erro ao cancelar reserva.' };
    }
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export type BlackMarketBuyResult = {
  ok: boolean;
  error?: string;
  missing?: number;
  message?: string;
  purchasedQty?: number;
  totalUsdc?: number;
  unitPrice?: number;
};

const MARKET_BUY_FETCH_MS = 300_000;

export async function postBlackMarketBuy(
  listingId: string,
  qty?: number,
  opts?: { idempotencyKey?: string }
): Promise<BlackMarketBuyResult> {
  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), MARKET_BUY_FETCH_MS);
  try {
    const body: Record<string, unknown> = { listingId };
    if (qty != null) {
      const q = Math.floor(Number(qty));
      if (Number.isFinite(q) && q >= 1) {
        body.qty = q;
        body.quantity = q;
      }
    }
    const ik = opts?.idempotencyKey?.trim();
    if (ik) body.idempotencyKey = ik.slice(0, 128);
    const res = await apiFetch(`${base}/black-market/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      if (res.status === 524 || res.status === 504) {
        return {
          ok: false,
          error:
            'Timeout (Cloudflare ou servidor). Recarrega e verifica o saldo antes de repetir.'
        };
      }
      try {
        return (await res.json()) as BlackMarketBuyResult;
      } catch {
        return { ok: false, error: `Erro HTTP ${res.status}` };
      }
    }
    try {
      return (await res.json()) as BlackMarketBuyResult;
    } catch {
      return { ok: true };
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error:
          'Pedido cancelado após vários minutos sem resposta. Recarrega antes de tentar outra vez.'
      };
    }
    return { ok: false, error: 'Erro de rede.' };
  } finally {
    clearTimeout(kill);
  }
}

export async function postBlackMarketClaim(): Promise<{
  ok: boolean;
  claimed?: number;
  error?: string;
}> {
  try {
    const res = await apiFetch(`${base}/black-market/claim`, { method: 'POST' });
    if (!res.ok) {
      try {
        return (await res.json()) as { ok: boolean; claimed?: number; error?: string };
      } catch {
        return { ok: false, error: 'Erro ao liquidar proventos.' };
      }
    }
    return (await res.json()) as { ok: boolean; claimed?: number; error?: string };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postBlackMarketClaimAll(): Promise<{
  ok: boolean;
  claimed?: number;
  message?: string;
  error?: string;
}> {
  try {
    const res = await apiFetch(`${base}/black-market/claim-all`, { method: 'POST' });
    if (!res.ok) {
      try {
        return (await res.json()) as { ok: boolean; claimed?: number; message?: string; error?: string };
      } catch {
        return { ok: false, error: 'Erro ao resgatar.' };
      }
    }
    return (await res.json()) as { ok: boolean; claimed?: number; message?: string; error?: string };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postBlackMarketClaimItem(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/black-market/claim-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId })
    });
    if (!res.ok) {
      try {
        return (await res.json()) as { ok: boolean; error?: string };
      } catch {
        return { ok: false, error: 'Erro ao resgatar item.' };
      }
    }
    try {
      return (await res.json()) as { ok: boolean; error?: string };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}
