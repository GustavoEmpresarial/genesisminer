/**
 * Lojinha Miner (hardware store) — player API.
 * Routes: GET /api/shop/state, cart mutations, POST /api/shop/checkout
 */
import { apiFetch } from './http';

const base = '/api';

/** Produto da Lojinha Miner (`GET /api/shop/state`). */
export type ShopProductApi = {
  id: string;
  name: string;
  category: string;
  type: string;
  baseCost: number;
  baseProduction: number;
  powerConsumption?: number;
  powerCapacity?: number;
  multiplier?: number;
  slotsCapacity?: number;
  aiSlotsCapacity?: number;
  description: string;
  icon: string;
  status: string;
  isNft: boolean;
  maxGlobalStock?: number;
  totalSold: number;
  image?: string;
  compatibleRacks: string[];
  rewardWh: number;
  sellInHardwareMarket: boolean;
  isActive: boolean;
};

export type ShopCartLineApi = {
  lineId: string;
  productId: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
};

export type ShopStateV1Ok = {
  ok: true;
  version: 1;
  hardwareMarketEnabled: boolean;
  usdc: number;
  products: ShopProductApi[];
  cart: { cartId: string; lines: ShopCartLineApi[]; totalUsdc: number };
};

const SHOP_UPGRADE_TYPES = new Set(['machine', 'infrastructure', 'battery', 'wiring', 'multiplier']);
const MERGE_CATALOG_ID_PREFIX = 'merge_';

function parseShopProduct(raw: unknown): ShopProductApi | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  if (id.startsWith(MERGE_CATALOG_ID_PREFIX)) return null;
  const typeStr = typeof r.type === 'string' && SHOP_UPGRADE_TYPES.has(r.type) ? r.type : 'machine';
  const racksRaw = r.compatibleRacks;
  const compatibleRacks = Array.isArray(racksRaw)
    ? racksRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  return {
    id,
    name: typeof r.name === 'string' ? r.name : id,
    category: typeof r.category === 'string' ? r.category : '',
    type: typeStr,
    baseCost: Number(r.baseCost) || 0,
    baseProduction: Number(r.baseProduction) || 0,
    powerConsumption: r.powerConsumption != null ? Number(r.powerConsumption) : undefined,
    powerCapacity: r.powerCapacity != null ? Number(r.powerCapacity) : undefined,
    multiplier: r.multiplier != null ? Number(r.multiplier) : undefined,
    slotsCapacity: r.slotsCapacity != null ? Number(r.slotsCapacity) : undefined,
    aiSlotsCapacity: r.aiSlotsCapacity != null ? Number(r.aiSlotsCapacity) : undefined,
    description: typeof r.description === 'string' ? r.description : '',
    icon: typeof r.icon === 'string' ? r.icon : '📦',
    status: typeof r.status === 'string' ? r.status : 'normal',
    isNft: !!r.isNft,
    maxGlobalStock: r.maxGlobalStock != null ? Number(r.maxGlobalStock) : undefined,
    totalSold: Number(r.totalSold) || 0,
    image: typeof r.image === 'string' && r.image.trim() ? r.image.trim() : undefined,
    compatibleRacks,
    rewardWh: Number(r.rewardWh) || 0,
    sellInHardwareMarket: r.sellInHardwareMarket !== false,
    isActive: r.isActive !== false
  };
}

function parseShopCartLine(raw: unknown): ShopCartLineApi | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lineId = typeof r.lineId === 'string' ? r.lineId.trim() : '';
  const productId = typeof r.productId === 'string' ? r.productId.trim() : '';
  const qty = Math.floor(Number(r.qty));
  const unitPrice = Number(r.unitPrice);
  const lineTotal = Number(r.lineTotal);
  if (!lineId || !productId || !Number.isInteger(qty) || qty < 0) return null;
  if (!Number.isFinite(unitPrice) || !Number.isFinite(lineTotal)) return null;
  return { lineId, productId, qty, unitPrice, lineTotal };
}

export function parseShopStateV1Body(body: Record<string, unknown>): ShopStateV1Ok | null {
  if (body.version !== 1) return null;
  const productsRaw = body.products;
  const products: ShopProductApi[] = [];
  if (Array.isArray(productsRaw)) {
    for (const p of productsRaw) {
      const pr = parseShopProduct(p);
      if (pr) products.push(pr);
    }
  }
  const cartRaw = body.cart;
  if (!cartRaw || typeof cartRaw !== 'object' || Array.isArray(cartRaw)) return null;
  const co = cartRaw as Record<string, unknown>;
  const cartId = typeof co.cartId === 'string' ? co.cartId.trim() : '';
  const linesRaw = co.lines;
  const lines: ShopCartLineApi[] = [];
  if (Array.isArray(linesRaw)) {
    for (const ln of linesRaw) {
      const l = parseShopCartLine(ln);
      if (l && l.qty > 0) lines.push(l);
    }
  }
  const totalUsdc = Number(co.totalUsdc);
  if (!Number.isFinite(totalUsdc) || totalUsdc < 0) return null;
  const usdc = Number(body.usdc);
  if (!Number.isFinite(usdc) || usdc < 0) return null;
  return {
    ok: true,
    version: 1,
    hardwareMarketEnabled: body.hardwareMarketEnabled !== false,
    usdc,
    products,
    cart: { cartId, lines, totalUsdc }
  };
}

export async function getShopState(): Promise<
  ShopStateV1Ok | { ok: false; status: number; error?: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/shop/state?t=${Date.now()}`, {
      headers: { 'Content-Type': 'application/json' }
    });
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
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const parsed = parseShopStateV1Body(body);
    if (!parsed) return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    return parsed;
  } catch (e) {
    console.error('[shop] getShopState failed', e);
    return { ok: false, status: 500, error: 'Erro de rede ao carregar a loja.' };
  }
}

async function parseShopMutationResponse(res: Response): Promise<{
  ok: boolean;
  shop?: ShopStateV1Ok;
  error?: string;
  status: number;
}> {
  const status = res.status;
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = typeof body.error === 'string' ? body.error : `Erro HTTP ${status}`;
    return { ok: false, status, error: err };
  }
  const shopRaw = body.shop;
  if (shopRaw && typeof shopRaw === 'object' && !Array.isArray(shopRaw)) {
    const shop = parseShopStateV1Body(shopRaw as Record<string, unknown>);
    if (shop) return { ok: true, status, shop };
  }
  return { ok: true, status };
}

export async function postShopCartItem(
  productId: string,
  quantity: number
): Promise<{ ok: boolean; shop?: ShopStateV1Ok; error?: string; status: number }> {
  try {
    const res = await apiFetch(`${base}/shop/cart/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity })
    });
    return parseShopMutationResponse(res);
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function patchShopCartLine(
  lineId: string,
  quantity: number
): Promise<{ ok: boolean; shop?: ShopStateV1Ok; error?: string; status: number }> {
  try {
    const res = await apiFetch(`${base}/shop/cart/items/${encodeURIComponent(lineId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity })
    });
    return parseShopMutationResponse(res);
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function deleteShopCartLine(
  lineId: string
): Promise<{ ok: boolean; shop?: ShopStateV1Ok; error?: string; status: number }> {
  try {
    const res = await apiFetch(`${base}/shop/cart/items/${encodeURIComponent(lineId)}`, {
      method: 'DELETE'
    });
    return parseShopMutationResponse(res);
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function clearShopCart(): Promise<{
  ok: boolean;
  shop?: ShopStateV1Ok;
  error?: string;
  status: number;
}> {
  try {
    const res = await apiFetch(`${base}/shop/cart`, { method: 'DELETE' });
    return parseShopMutationResponse(res);
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export type ShopCheckoutApiResult =
  | {
      ok: true;
      newUsdc: number;
      totalPaid?: number;
      cached?: boolean;
      orderId?: string;
      shop?: ShopStateV1Ok;
    }
  | { ok: false; status: number; error?: string; missing?: number; code?: string };

export async function postShopCheckout(idempotencyKey?: string | null): Promise<ShopCheckoutApiResult> {
  try {
    const res = await apiFetch(`${base}/shop/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : undefined
      })
    });
    const status = res.status;
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      return {
        ok: false,
        status,
        error: typeof body.error === 'string' ? body.error : `Erro HTTP ${status}`,
        missing: body.missing != null ? Number(body.missing) : undefined,
        code: typeof body.code === 'string' ? body.code : undefined
      };
    }
    const newUsdc = Number(body.newUsdc);
    if (!Number.isFinite(newUsdc)) {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const shopRaw = body.shop;
    let shop: ShopStateV1Ok | undefined;
    if (shopRaw && typeof shopRaw === 'object' && !Array.isArray(shopRaw)) {
      const p = parseShopStateV1Body(shopRaw as Record<string, unknown>);
      if (p) shop = p;
    }
    return {
      ok: true,
      newUsdc,
      totalPaid: body.totalPaid != null ? Number(body.totalPaid) : undefined,
      cached: !!body.cached,
      orderId: typeof body.orderId === 'string' && body.orderId.trim() ? body.orderId.trim() : undefined,
      shop
    };
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}
