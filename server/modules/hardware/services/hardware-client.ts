/**
 * Thin HTTP client for `genesis-hardware` (stock / racks persist + intent I/O).
 *
 * When `GENESIS_HARDWARE_URL` is unset, most callers keep the TS path (unit tests).
 * Racks-power / shop checkout / merge execute / wheel paid-spin / lucky-box buy+open /
 * room purchase-slot / upgrade package purchase / catalog upgrades replace always call the worker — unset URL returns / throws
 * `GENESIS_HARDWARE_URL unset` (no TS fallback).
 * Compose always sets the URL — fail-closed: do not fall back to TS if the worker fails.
 * Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN` (same as mining worker).
 *
 * Napi (`GENESIS_HARDWARE_RUST`) is not wired this phase — HTTP worker is the cutover path.
 */

import {
  MINING_WORKER_AUTH_HEADER,
  MINING_WORKER_PROGRESS_TIMEOUT_MS,
  miningWorkerAuthToken
} from '../../mining-engine/services/mining-worker-client.js';

const HARDWARE_PERSIST_PATH = '/v1/hardware/persist';
const HARDWARE_INTENT_PATH = '/v1/hardware/intent';
const HARDWARE_CREDIT_PATH = '/v1/hardware/credit';
const HARDWARE_ADJUST_PATH = '/v1/hardware/adjust';
const HARDWARE_FOLD_WAREHOUSE_PATH = '/v1/hardware/fold-warehouse';
const HARDWARE_RACKS_POWER_PATH = '/v1/hardware/racks-power';
const HARDWARE_RECALL_ALL_PATH = '/v1/hardware/recall-all';
const HARDWARE_WIPE_USER_PATH = '/v1/hardware/wipe-user';
const MARKET_SELL_PATH = '/v1/market/sell';
const MARKET_CANCEL_PATH = '/v1/market/cancel';
const MARKET_RESERVE_PATH = '/v1/market/reserve';
const MARKET_CANCEL_RESERVE_PATH = '/v1/market/cancel-reserve';
const MARKET_BUY_PATH = '/v1/market/buy';
const MARKET_BUY_CACHED_PATH = '/v1/market/buy-cached';
const MARKET_CLAIM_PROCEEDS_PATH = '/v1/market/claim-proceeds';
const MARKET_CLAIM_ALL_PATH = '/v1/market/claim-all';
const MARKET_CLAIM_ITEM_PATH = '/v1/market/claim-item';
const MARKET_RECLAIM_PATH = '/v1/market/reclaim';
const MARKET_LISTINGS_PATH = '/v1/market/listings';
const MARKET_MY_LISTINGS_PATH = '/v1/market/my-listings';
const MARKET_CUSTODY_PATH = '/v1/market/custody';
const MARKET_SELLABLE_STOCK_PATH = '/v1/market/sellable-stock';
const MARKET_HISTORY_PATH = '/v1/market/history';
const MARKET_STATE_PATH = '/v1/market/state';
const SHOP_CHECKOUT_PATH = '/v1/shop/checkout';
const MERGE_EXECUTE_PATH = '/v1/merge/execute';
const WHEEL_PAID_SPIN_PATH = '/v1/wheel/paid-spin';
const ROOM_PURCHASE_SLOT_PATH = '/v1/rooms/purchase-slot';
const UPGRADE_PACKAGE_PURCHASE_PATH = '/v1/upgrades/purchase';
const CATALOG_UPGRADES_REPLACE_PATH = '/v1/catalog/upgrades/replace';
const INVENTORY_STATE_PATH = '/v1/inventory/state';
const INVENTORY_ME_PATH = '/v1/inventory/me';
const SHOP_STATE_PATH = '/v1/shop/state';
const SHOP_PRODUCTS_PATH = '/v1/shop/products';
const SHOP_CART_SET_PATH = '/v1/shop/cart/set';
const SHOP_CART_SET_LINE_PATH = '/v1/shop/cart/set-line';
const SHOP_CART_DELETE_LINE_PATH = '/v1/shop/cart/delete-line';
const SHOP_CART_CLEAR_PATH = '/v1/shop/cart/clear';
const CATALOG_UPGRADES_PATH = '/v1/catalog/upgrades';
const CATALOG_MINING_COINS_PATH = '/v1/catalog/mining-coins';
const CATALOG_ACCESS_LEVELS_PATH = '/v1/catalog/access-levels';
const SERVERS_STATE_PATH = '/v1/servers/state';
const GAME_STATE_ME_PATH = '/v1/game-state/me';
const WHEEL_STATE_PATH = '/v1/wheel/state';
const WHEEL_HISTORY_PATH = '/v1/wheel/history';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE_ENTITY = 422;

export type HardwareStockMode = 'snapshot' | 'partial' | 'merge';

export type HardwarePersistPayload = {
  userId: number;
  stock?: Record<string, number>;
  stockMode?: HardwareStockMode;
  storedBatteries?: Array<{ id: string; itemId: string; displayName?: string | null; imageUrl?: string | null }>;
  placedRacks?: unknown[];
};

export type HardwareIntentPayload = {
  userId: number;
  kind: 'place' | 'remove' | 'miner_equip' | 'miner_unequip' | 'aux_equip' | 'aux_unequip';
  rackId?: string;
  catalogItemId?: string;
  roomId?: string;
  slotIndex?: number;
  storedBatteryId?: string;
  batteryMode?: 'from_stock' | 'from_warehouse';
  multiplierSlotIndex?: number;
  auxKind?: 'battery' | 'wiring' | 'multiplier';
  scope: string;
  idempotencyKey: string;
  requestFingerprint?: string;
};

export type HardwareCreditPayload = {
  userId: number;
  itemId: string;
  qty: number;
  durationAmount?: number;
  durationUnit?: string;
};

export type HardwareRacksPowerRack = {
  id?: unknown;
  isOn?: unknown;
  selectedCoinId?: unknown;
  roomId?: unknown;
};

export type HardwareRacksPowerPayload = {
  userId: number;
  racks?: HardwareRacksPowerRack[];
  roomId?: string;
  coinId?: string | null;
};

export type HardwareAdjustLine = { itemId: string; qty: number };

export type HardwareAdjustPayload = {
  userId: number;
  debit: HardwareAdjustLine[];
  credit: HardwareAdjustLine[];
};

export type HardwareFoldWarehousePayload = { userId: number; batteryIds: string[] };

export type HardwareWipeUserPayload = { userId: number };

export type HardwareWorkerResult = {
  ok: boolean;
  error?: string;
  stock?: Record<string, number>;
  storedBatteries?: unknown[];
  placedRacks?: unknown[];
  itemsMoved?: number;
  racksProcessed?: number;
  instanceIds?: string[];
  codes?: string[];
};

/** Trimmed base URL or `null` when the worker is not configured (TS fallback). */
export function hardwareWorkerBaseUrl(): string | null {
  const raw = String(process.env.GENESIS_HARDWARE_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

async function postHardware(path: string, body: unknown): Promise<HardwareWorkerResult> {
  const base = hardwareWorkerBaseUrl();
  if (!base) {
    return { ok: false, error: 'GENESIS_HARDWARE_URL unset' };
  }
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_PROGRESS_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: `hardware worker non-JSON (${res.status})` };
      }
    }
    if (!res.ok) {
      return { ok: false, error: readWorkerError(parsed, res.status) };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'hardware worker empty body' };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      ok: obj.ok === true,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      stock: readNumberMap(obj.stock),
      storedBatteries: Array.isArray(obj.storedBatteries) ? obj.storedBatteries : undefined,
      placedRacks: Array.isArray(obj.placedRacks) ? obj.placedRacks : undefined,
      itemsMoved: readOptionalFiniteNumber(obj.itemsMoved),
      racksProcessed: readOptionalFiniteNumber(obj.racksProcessed),
      instanceIds: readStringArray(obj.instanceIds),
      codes: readStringArray(obj.codes)
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `hardware worker unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function readWorkerError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && body !== null && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return `hardware worker HTTP ${status}`;
}

function readOptionalFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return undefined;
}

function readStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

function readNumberMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** Fail-closed persist. Throws when URL is set and the worker does not return ok. */
export async function callHardwarePersist(payload: HardwarePersistPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_PERSIST_PATH, payload);
  if (!result.ok) {
    throw new Error(result.error || 'hardware persist failed');
  }
  return result;
}

/**
 * Fail-closed intent: never falls back to TS when URL is set.
 * Domain errors (`ok: false`) are returned for the controller to map to 400.
 * Unreachable / non-JSON throws so Express does not apply the TS path.
 */
export async function callHardwareIntent(payload: HardwareIntentPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_INTENT_PATH, payload);
  if (!result.ok && isHardwareTransportError(result.error)) {
    throw new Error(result.error || 'hardware intent failed');
  }
  return result;
}

function isHardwareTransportError(error: string | undefined): boolean {
  if (!error) return false;
  return error.startsWith('hardware worker unreachable') || error.startsWith('hardware worker non-JSON');
}

/** Fail-closed credit (stock UPSERT). Throws when URL is set and the worker does not return ok. */
export async function callHardwareCredit(payload: HardwareCreditPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_CREDIT_PATH, payload);
  if (!result.ok) {
    throw new Error(result.error || 'hardware credit failed');
  }
  return result;
}

/** Fail-closed adjust (debit+credit in one worker TX). Throws when URL is set and the worker does not return ok. */
export async function callHardwareAdjust(payload: HardwareAdjustPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_ADJUST_PATH, payload);
  if (!result.ok) {
    throw new Error(result.error || 'hardware adjust failed');
  }
  return result;
}

/** Fail-closed warehouse→stock fold (credit+delete one TX). Throws when URL is set and the worker does not return ok. */
export async function callHardwareFoldWarehouse(payload: HardwareFoldWarehousePayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_FOLD_WAREHOUSE_PATH, payload);
  if (!result.ok) {
    throw new Error(result.error || 'hardware fold-warehouse failed');
  }
  return result;
}

/** Fail-closed global recall (credit + delete racks one TX). Throws when URL is set and the worker does not return ok. */
export async function callHardwareRecallAll(): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_RECALL_ALL_PATH, {});
  if (!result.ok) {
    throw new Error(result.error || 'hardware recall-all failed');
  }
  return result;
}

/** Fail-closed user item-table wipe. Throws when URL is set and the worker does not return ok. */
export async function callHardwareWipeUser(payload: HardwareWipeUserPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_WIPE_USER_PATH, payload);
  if (!result.ok) {
    throw new Error(result.error || 'hardware wipe-user failed');
  }
  return result;
}

/**
 * Fail-closed racks power/coin. Domain `ok: false` is returned for the controller
 * to map to 400. Unreachable / non-JSON throws so Express does not apply the TS path.
 */
export async function callHardwareRacksPower(payload: HardwareRacksPowerPayload): Promise<HardwareWorkerResult> {
  const result = await postHardware(HARDWARE_RACKS_POWER_PATH, payload);
  if (!result.ok && isHardwareTransportError(result.error)) {
    throw new Error(result.error || 'hardware racks-power failed');
  }
  return result;
}

/** Domain `ok:false` from `/v1/market/*` — mutations map to `HttpControlledError`. */
export class HardwareMarketError extends Error {
  readonly statusCode: number;
  readonly jsonBody: Record<string, unknown>;

  constructor(statusCode: number, jsonBody: Record<string, unknown>) {
    const message = typeof jsonBody.error === 'string' ? jsonBody.error : 'Market request failed';
    super(message);
    this.name = 'HardwareMarketError';
    this.statusCode = statusCode;
    this.jsonBody = jsonBody;
  }
}

export function isHardwareMarketError(e: unknown): e is HardwareMarketError {
  return e instanceof HardwareMarketError;
}

function isMarketDomainStatus(status: number): boolean {
  return (
    status === HTTP_BAD_REQUEST ||
    status === HTTP_UNAUTHORIZED ||
    status === HTTP_FORBIDDEN ||
    status === HTTP_NOT_FOUND ||
    status === HTTP_CONFLICT ||
    status === HTTP_UNPROCESSABLE_ENTITY
  );
}

type MarketRaw = {
  status: number;
  body: Record<string, unknown>;
};

async function postMarketRaw(path: string, payload: unknown): Promise<MarketRaw> {
  const base = hardwareWorkerBaseUrl();
  if (!base) {
    throw new Error('GENESIS_HARDWARE_URL unset');
  }
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_PROGRESS_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`hardware worker non-JSON (${res.status})`);
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      if (isMarketDomainStatus(res.status)) {
        throw new HardwareMarketError(res.status, { error: `hardware worker HTTP ${res.status}` });
      }
      throw new Error(res.ok ? 'hardware worker empty body' : `hardware worker HTTP ${res.status}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (!res.ok) {
      if (isMarketDomainStatus(res.status)) {
        const error = typeof obj.error === 'string' && obj.error.trim() ? obj.error : `hardware worker HTTP ${res.status}`;
        const jsonBody: Record<string, unknown> = { error };
        if (typeof obj.code === 'string' && obj.code.trim()) jsonBody.code = obj.code;
        if (typeof obj.missing === 'number' && Number.isFinite(obj.missing)) jsonBody.missing = obj.missing;
        if (obj.forceReload === true) jsonBody.forceReload = true;
        if (typeof obj.catalogRevision === 'number' && Number.isFinite(obj.catalogRevision)) {
          jsonBody.catalogRevision = obj.catalogRevision;
        }
        if (
          typeof obj.expectedCatalogRevision === 'number' &&
          Number.isFinite(obj.expectedCatalogRevision)
        ) {
          jsonBody.expectedCatalogRevision = obj.expectedCatalogRevision;
        }
        if (typeof obj.previousId === 'string' && obj.previousId.trim()) {
          jsonBody.previousId = obj.previousId;
        }
        if (typeof obj.attemptedId === 'string' && obj.attemptedId.trim()) {
          jsonBody.attemptedId = obj.attemptedId;
        }
        throw new HardwareMarketError(res.status, jsonBody);
      }
      throw new Error(readWorkerError(parsed, res.status));
    }
    return { status: res.status, body: obj };
  } catch (e) {
    if (e instanceof HardwareMarketError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('hardware worker non-JSON') || msg.startsWith('hardware worker HTTP') || msg.startsWith('hardware worker empty')) {
      throw e instanceof Error ? e : new Error(msg);
    }
    throw new Error(`hardware worker unreachable: ${msg}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

function requireMarketOk(body: Record<string, unknown>, label: string): Record<string, unknown> {
  if (body.ok !== true) {
    throw new Error(typeof body.error === 'string' ? body.error : `${label} failed`);
  }
  return body;
}

function readRequiredString(body: Record<string, unknown>, key: string, label: string): string {
  const v = body[key];
  if (typeof v === 'string' && v.trim()) return v;
  throw new Error(`${label} missing ${key}`);
}

function readRequiredNumber(body: Record<string, unknown>, key: string, label: string): number {
  const v = body[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`${label} missing ${key}`);
}

export async function callMarketSell(payload: {
  userId: number;
  itemId: string;
  price: number;
  qty: number;
}): Promise<{ listingId: string }> {
  const { body } = await postMarketRaw(MARKET_SELL_PATH, payload);
  requireMarketOk(body, 'market sell');
  return { listingId: readRequiredString(body, 'listingId', 'market sell') };
}

export async function callMarketCancel(payload: {
  userId: number;
  listingId: string;
}): Promise<{ itemId: string; qty: number; price: number }> {
  const { body } = await postMarketRaw(MARKET_CANCEL_PATH, payload);
  requireMarketOk(body, 'market cancel');
  return {
    itemId: readRequiredString(body, 'itemId', 'market cancel'),
    qty: readRequiredNumber(body, 'qty', 'market cancel'),
    price: readRequiredNumber(body, 'price', 'market cancel')
  };
}

export async function callMarketReserve(payload: {
  userId: number;
  listingId: string;
}): Promise<number> {
  const { body } = await postMarketRaw(MARKET_RESERVE_PATH, payload);
  requireMarketOk(body, 'market reserve');
  return readRequiredNumber(body, 'reservedUntil', 'market reserve');
}

export async function callMarketCancelReserve(payload: {
  userId: number;
  listingId: string;
}): Promise<boolean> {
  const { body } = await postMarketRaw(MARKET_CANCEL_RESERVE_PATH, payload);
  requireMarketOk(body, 'market cancel-reserve');
  return body.cancelled === true;
}

export type MarketBuyResult = {
  buyQty: number;
  totalPrice: number;
  unitPrice: number;
  sellerId: number;
  itemId: string;
  listingId: string;
  cached?: boolean;
  message?: string;
  purchasedQty?: number;
  totalUsdc?: number;
};

export async function callMarketBuy(payload: {
  buyerId: number;
  listingId: string;
  qty?: unknown;
  idempotencyKey: string;
}): Promise<MarketBuyResult> {
  const { body } = await postMarketRaw(MARKET_BUY_PATH, payload);
  requireMarketOk(body, 'market buy');
  return {
    buyQty: readRequiredNumber(body, 'buyQty', 'market buy'),
    totalPrice: readRequiredNumber(body, 'totalPrice', 'market buy'),
    unitPrice: readRequiredNumber(body, 'unitPrice', 'market buy'),
    sellerId: readRequiredNumber(body, 'sellerId', 'market buy'),
    itemId: typeof body.itemId === 'string' ? body.itemId : '',
    listingId: readRequiredString(body, 'listingId', 'market buy'),
    cached: body.cached === true,
    message: typeof body.message === 'string' ? body.message : undefined,
    purchasedQty: typeof body.purchasedQty === 'number' ? body.purchasedQty : undefined,
    totalUsdc: typeof body.totalUsdc === 'number' ? body.totalUsdc : undefined
  };
}

export async function callMarketBuyCached(payload: {
  buyerId: number;
  idempotencyKey: string;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const { body } = await postMarketRaw(MARKET_BUY_CACHED_PATH, payload);
  requireMarketOk(body, 'market buy-cached');
  if (body.cached !== true) return null;
  const status = typeof body.httpStatus === 'number' && Number.isFinite(body.httpStatus) ? body.httpStatus : HTTP_OK;
  const cachedBody =
    body.body && typeof body.body === 'object' && !Array.isArray(body.body)
      ? (body.body as Record<string, unknown>)
      : { ok: true };
  return { status, body: cachedBody };
}

export async function callMarketClaimProceeds(payload: { userId: number }): Promise<number> {
  const { body } = await postMarketRaw(MARKET_CLAIM_PROCEEDS_PATH, payload);
  requireMarketOk(body, 'market claim-proceeds');
  return readRequiredNumber(body, 'moved', 'market claim-proceeds');
}

export async function callMarketClaimAll(payload: { userId: number }): Promise<string[]> {
  const { body } = await postMarketRaw(MARKET_CLAIM_ALL_PATH, payload);
  requireMarketOk(body, 'market claim-all');
  const ids = readStringArray(body.claimedIds);
  if (!ids) throw new Error('market claim-all missing claimedIds');
  return ids;
}

export async function callMarketClaimItem(payload: {
  userId: number;
  listingId: string;
}): Promise<{ itemId: string; qty: number }> {
  const { body } = await postMarketRaw(MARKET_CLAIM_ITEM_PATH, payload);
  requireMarketOk(body, 'market claim-item');
  return {
    itemId: readRequiredString(body, 'itemId', 'market claim-item'),
    qty: readRequiredNumber(body, 'qty', 'market claim-item')
  };
}

export async function callMarketReclaim(payload?: {
  nowMs?: number;
  batchSize?: number;
  maxRounds?: number;
}): Promise<number> {
  const { body } = await postMarketRaw(MARKET_RECLAIM_PATH, payload ?? {});
  requireMarketOk(body, 'market reclaim');
  return readRequiredNumber(body, 'reclaimed', 'market reclaim');
}

export async function callMarketListings(payload: {
  excludeSellerId?: number | null;
  search?: string;
  category?: string;
  type?: string;
  sortPrice?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): Promise<{ items: unknown[]; total: number }> {
  const { body } = await postMarketRaw(MARKET_LISTINGS_PATH, payload);
  requireMarketOk(body, 'market listings');
  const items = Array.isArray(body.items) ? body.items : [];
  return { items, total: readRequiredNumber(body, 'total', 'market listings') };
}

export async function callMarketMyListings(payload: { userId: number }): Promise<unknown[]> {
  const { body } = await postMarketRaw(MARKET_MY_LISTINGS_PATH, payload);
  requireMarketOk(body, 'market my-listings');
  return Array.isArray(body.items) ? body.items : [];
}

export async function callMarketCustody(payload: { userId: number }): Promise<unknown[]> {
  const { body } = await postMarketRaw(MARKET_CUSTODY_PATH, payload);
  requireMarketOk(body, 'market custody');
  return Array.isArray(body.items) ? body.items : [];
}

export async function callMarketSellableStock(payload: { userId: number }): Promise<unknown[]> {
  const { body } = await postMarketRaw(MARKET_SELLABLE_STOCK_PATH, payload);
  requireMarketOk(body, 'market sellable-stock');
  return Array.isArray(body.items) ? body.items : [];
}

export async function callMarketHistory(payload: {
  userId: number;
  limit: number;
}): Promise<{ purchases: unknown[]; sales: unknown[] }> {
  const { body } = await postMarketRaw(MARKET_HISTORY_PATH, payload);
  requireMarketOk(body, 'market history');
  return {
    purchases: Array.isArray(body.purchases) ? body.purchases : [],
    sales: Array.isArray(body.sales) ? body.sales : []
  };
}

export async function callMarketState(payload: { userId: number }): Promise<Record<string, unknown>> {
  const { body } = await postMarketRaw(MARKET_STATE_PATH, payload);
  requireMarketOk(body, 'market state');
  if (body.state && typeof body.state === 'object' && !Array.isArray(body.state)) {
    return body.state as Record<string, unknown>;
  }
  throw new Error('market state missing state');
}

export type ShopCheckoutResult = {
  ok: true;
  newUsdc: number;
  totalCost: number;
  cached?: boolean;
};

/** Fail-closed shop checkout (USDC + credit + limited + cart + idem one TX). */
export async function callShopCheckout(payload: {
  userId: number;
  cart: Record<string, number>;
  idempotencyKey: string;
  clearCartId?: string;
  requestFingerprint?: string;
}): Promise<ShopCheckoutResult> {
  const { body } = await postMarketRaw(SHOP_CHECKOUT_PATH, payload);
  requireMarketOk(body, 'shop checkout');
  return {
    ok: true,
    newUsdc: readRequiredNumber(body, 'newUsdc', 'shop checkout'),
    totalCost: readRequiredNumber(body, 'totalCost', 'shop checkout'),
    cached: body.cached === true
  };
}

export type MergeExecuteResult = {
  ok: true;
  newUsdc: number;
  stock?: Record<string, number>;
  resultQty?: number;
};

/** Fail-closed merge execute (USDC fee + adjust + merge_history one TX). */
export async function callMergeExecute(payload: {
  userId: number;
  sourceItemId: string;
  resultItemId: string;
  sourceRarity: string;
  resultRarity: string;
  feeUnitUsdc: number;
  count: number;
  debit: HardwareAdjustLine[];
  credit: HardwareAdjustLine[];
  historyTimestamps?: number[];
}): Promise<MergeExecuteResult> {
  const { body } = await postMarketRaw(MERGE_EXECUTE_PATH, payload);
  requireMarketOk(body, 'merge execute');
  return {
    ok: true,
    newUsdc: readRequiredNumber(body, 'newUsdc', 'merge execute'),
    stock: readNumberMap(body.stock),
    resultQty: readOptionalFiniteNumber(body.resultQty)
  };
}

export type WheelPaidSpinResult = {
  ok: true;
  spinId: string;
  wonItemId: string;
  item: Record<string, unknown> | null;
  newUsdc: number;
  chargedUsdc: number;
  boxId: string;
  boxName: string;
  idempotentReplay: boolean;
};

/** Fail-closed paid wheel spin (USDC + roll + box + idem one TX). */
export async function callWheelPaidSpin(payload: {
  userId: number;
  idempotencyKey: string;
  serverNowMs?: number;
}): Promise<WheelPaidSpinResult> {
  const { body } = await postMarketRaw(WHEEL_PAID_SPIN_PATH, payload);
  requireMarketOk(body, 'wheel paid-spin');
  const item =
    body.item && typeof body.item === 'object' && !Array.isArray(body.item)
      ? (body.item as Record<string, unknown>)
      : null;
  return {
    ok: true,
    spinId: readRequiredString(body, 'spinId', 'wheel paid-spin'),
    wonItemId: readRequiredString(body, 'wonItemId', 'wheel paid-spin'),
    item,
    newUsdc: readRequiredNumber(body, 'newUsdc', 'wheel paid-spin'),
    chargedUsdc: readRequiredNumber(body, 'chargedUsdc', 'wheel paid-spin'),
    boxId: typeof body.boxId === 'string' ? body.boxId : '',
    boxName: typeof body.boxName === 'string' ? body.boxName : '',
    idempotentReplay: body.idempotentReplay === true
  };
}

export type RoomPurchaseSlotResult = {
  ok: true;
  roomId: string;
  slotsPurchased: number;
  totalPrice: number;
  newUsdc: number;
  cached?: boolean;
};

/** Fail-closed room slot purchase (USDC + unlock + idem one TX). */
export async function callRoomPurchaseSlot(payload: {
  userId: number;
  roomId: string;
  quantity: number;
  idempotencyKey: string;
  serverNowMs?: number;
}): Promise<RoomPurchaseSlotResult> {
  const { body } = await postMarketRaw(ROOM_PURCHASE_SLOT_PATH, payload);
  requireMarketOk(body, 'room purchase-slot');
  return {
    ok: true,
    roomId: readRequiredString(body, 'roomId', 'room purchase-slot'),
    slotsPurchased: readRequiredNumber(body, 'slotsPurchased', 'room purchase-slot'),
    totalPrice: readRequiredNumber(body, 'totalPrice', 'room purchase-slot'),
    newUsdc: readRequiredNumber(body, 'newUsdc', 'room purchase-slot'),
    cached: body.cached === true
  };
}

export type UpgradePackagePurchaseResult = {
  ok: true;
  newUsdc: number;
  idempotentReplay: boolean;
  packageVersion: number;
  box?: { id: string; name: string; quantity: number };
};

/** Fail-closed upgrade package purchase (USDC + loot materialize + idem one TX). */
export async function callUpgradePackagePurchase(payload: {
  userId: number;
  packageId: string;
  idempotencyKey: string | null;
  clientPackageVersion?: number | null;
  serverNowMs?: number;
}): Promise<UpgradePackagePurchaseResult> {
  const { body } = await postMarketRaw(UPGRADE_PACKAGE_PURCHASE_PATH, payload);
  requireMarketOk(body, 'upgrade package purchase');
  const result: UpgradePackagePurchaseResult = {
    ok: true,
    newUsdc: readRequiredNumber(body, 'newUsdc', 'upgrade package purchase'),
    idempotentReplay: body.idempotentReplay === true,
    packageVersion: readRequiredNumber(body, 'packageVersion', 'upgrade package purchase')
  };
  const rawBox = body.box;
  if (rawBox && typeof rawBox === 'object' && !Array.isArray(rawBox)) {
    const b = rawBox as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id : '';
    const name = typeof b.name === 'string' ? b.name : '';
    const quantity =
      typeof b.quantity === 'number' && Number.isFinite(b.quantity) ? b.quantity : Number(b.quantity);
    if (id && Number.isFinite(quantity)) {
      result.box = { id, name, quantity };
    }
  }
  return result;
}

export type CatalogUpgradesReplaceResult = {
  ok: true;
  catalogRevision: number;
};

/** Fail-closed admin catalog replace (OCC lock/assert/UPSERT/soft-retire/bump one TX). */
export async function callCatalogUpgradesReplace(payload: {
  upgrades: unknown[];
  expectedCatalogRevision: number;
}): Promise<CatalogUpgradesReplaceResult> {
  const { body } = await postMarketRaw(CATALOG_UPGRADES_REPLACE_PATH, payload);
  requireMarketOk(body, 'catalog upgrades replace');
  return {
    ok: true,
    catalogRevision: readRequiredNumber(body, 'catalogRevision', 'catalog upgrades replace')
  };
}

function requireReadOk(body: Record<string, unknown>, status: number, label: string): Record<string, unknown> {
  if (status === HTTP_OK && body.ok === true) return body;
  if (isMarketDomainStatus(status)) {
    throw new HardwareMarketError(status, body);
  }
  throw new Error(typeof body.error === 'string' ? body.error : `hardware ${label} failed`);
}

async function callHardwareRead(path: string, payload: unknown, label: string): Promise<Record<string, unknown>> {
  const { status, body } = await postMarketRaw(path, payload);
  return requireReadOk(body, status, label);
}

export async function callInventoryState(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(INVENTORY_STATE_PATH, payload, 'inventory state');
}

export async function callInventoryMe(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(INVENTORY_ME_PATH, payload, 'inventory me');
}

export async function callShopState(payload: { userId: number; isAdmin?: boolean }): Promise<Record<string, unknown>> {
  return callHardwareRead(SHOP_STATE_PATH, payload, 'shop state');
}

export async function callShopProducts(payload: { userId: number; isAdmin?: boolean }): Promise<unknown[]> {
  const body = await callHardwareRead(SHOP_PRODUCTS_PATH, payload, 'shop products');
  return Array.isArray(body.products) ? body.products : [];
}

export async function callShopCartSet(payload: {
  userId: number;
  productId: string;
  qty: number;
}): Promise<Record<string, unknown>> {
  return callHardwareRead(SHOP_CART_SET_PATH, payload, 'shop cart set');
}

export async function callShopCartSetLine(payload: {
  userId: number;
  lineId: string;
  qty: number;
}): Promise<Record<string, unknown>> {
  return callHardwareRead(SHOP_CART_SET_LINE_PATH, payload, 'shop cart set-line');
}

export async function callShopCartDeleteLine(payload: {
  userId: number;
  lineId: string;
}): Promise<Record<string, unknown>> {
  return callHardwareRead(SHOP_CART_DELETE_LINE_PATH, payload, 'shop cart delete-line');
}

export async function callShopCartClear(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(SHOP_CART_CLEAR_PATH, payload, 'shop cart clear');
}

export async function callCatalogUpgrades(payload: { userId?: number } = {}): Promise<Record<string, unknown>> {
  return callHardwareRead(CATALOG_UPGRADES_PATH, payload, 'catalog upgrades');
}

export async function callCatalogMiningCoins(): Promise<unknown[]> {
  const body = await callHardwareRead(CATALOG_MINING_COINS_PATH, {}, 'catalog mining-coins');
  return Array.isArray(body.items) ? body.items : [];
}

export async function callCatalogAccessLevels(): Promise<unknown[]> {
  const body = await callHardwareRead(CATALOG_ACCESS_LEVELS_PATH, {}, 'catalog access-levels');
  return Array.isArray(body.items) ? body.items : [];
}

export async function callServersState(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(SERVERS_STATE_PATH, payload, 'servers state');
}

export async function callGameStateMe(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(GAME_STATE_ME_PATH, payload, 'game-state me');
}

export async function callWheelState(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callHardwareRead(WHEEL_STATE_PATH, payload, 'wheel state');
}

export async function callWheelHistory(payload: {
  userId: number;
  limit?: number;
}): Promise<Record<string, unknown>> {
  return callHardwareRead(WHEEL_HISTORY_PATH, payload, 'wheel history');
}
