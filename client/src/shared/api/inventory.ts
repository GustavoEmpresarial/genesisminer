/**
 * Player inventory API — DECISIONS #104.
 * `GET /api/inventory/state`
 */
import { apiFetch } from './http';

const base = '/api';

export type InventoryBatteryInstance = {
  id: string;
  itemId: string;
  displayName: string | null;
  imageUrl: string | null;
  publicRef: string;
};

export type InventoryStackableRow = {
  stockKey: string;
  catalogItemId: string;
  displayQuantity: number;
  availableQuantity: number;
  name: string;
  description: string;
  category: string;
  type: string;
  image: string | null;
  icon: string;
  baseProduction: number;
  powerConsumption: number;
  powerCapacity: number;
  slotsCapacity: number;
  aiSlotsCapacity: number;
  isNft: boolean;
};

export type InventoryStackableCategory = {
  category: string;
  items: InventoryStackableRow[];
};

export type InventoryStatePayload = {
  version: 1;
  serverUpdatedAt: number;
  stateVersion: number;
  stock: Record<string, number>;
  storedBatteries: InventoryBatteryInstance[];
  stackableCategories: InventoryStackableCategory[];
};

function parseBattery(raw: unknown): InventoryBatteryInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : '';
  if (!id || !itemId) return null;
  const publicRef =
    typeof r.publicRef === 'string' && r.publicRef.trim()
      ? r.publicRef.trim()
      : id.slice(0, 6);
  return {
    id,
    itemId,
    displayName: typeof r.displayName === 'string' ? r.displayName : null,
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : null,
    publicRef
  };
}

function parseStackableRow(raw: unknown): InventoryStackableRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stockKey = typeof r.stockKey === 'string' ? r.stockKey.trim() : '';
  if (!stockKey) return null;
  return {
    stockKey,
    catalogItemId: typeof r.catalogItemId === 'string' ? r.catalogItemId : stockKey,
    displayQuantity: Number(r.displayQuantity) || 0,
    availableQuantity: Number(r.availableQuantity) || 0,
    name: typeof r.name === 'string' ? r.name : stockKey,
    description: typeof r.description === 'string' ? r.description : '',
    category: typeof r.category === 'string' ? r.category : 'Outros',
    type: typeof r.type === 'string' ? r.type : 'other',
    image: typeof r.image === 'string' ? r.image : null,
    icon: typeof r.icon === 'string' ? r.icon : '',
    baseProduction: Number(r.baseProduction) || 0,
    powerConsumption: Number(r.powerConsumption) || 0,
    powerCapacity: Number(r.powerCapacity) || 0,
    slotsCapacity: Number(r.slotsCapacity) || 0,
    aiSlotsCapacity: Number(r.aiSlotsCapacity) || 0,
    isNft: Boolean(r.isNft)
  };
}

function parseStackableCategories(raw: unknown): InventoryStackableCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: InventoryStackableCategory[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const category = typeof b.category === 'string' ? b.category : 'Outros';
    const items = Array.isArray(b.items)
      ? b.items.map(parseStackableRow).filter((x): x is InventoryStackableRow => x != null)
      : [];
    if (items.length > 0) out.push({ category, items });
  }
  return out;
}

export async function getInventoryState(): Promise<
  { ok: true; data: InventoryStatePayload } | { ok: false; error: string; status?: number }
> {
  try {
    const res = await apiFetch(`${base}/inventory/state?t=${Date.now()}`);
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err =
        typeof (raw as { error?: unknown }).error === 'string'
          ? (raw as { error: string }).error
          : `HTTP ${res.status}`;
      return { ok: false, error: err, status: res.status };
    }
    const body = raw as Record<string, unknown>;
    if (body.version !== 1) {
      return { ok: false, error: 'INVALID_RESPONSE', status: 502 };
    }
    const stockRaw = body.stock;
    const stock: Record<string, number> =
      stockRaw && typeof stockRaw === 'object' && !Array.isArray(stockRaw)
        ? (Object.fromEntries(
            Object.entries(stockRaw as Record<string, unknown>).filter(
              ([k, v]) =>
                typeof k === 'string' &&
                k.trim() &&
                typeof v === 'number' &&
                Number.isFinite(v) &&
                v > 0
            )
          ) as Record<string, number>)
        : {};
    const storedBatteries: InventoryBatteryInstance[] = [];
    if (Array.isArray(body.storedBatteries)) {
      for (const x of body.storedBatteries) {
        const b = parseBattery(x);
        if (b) storedBatteries.push(b);
      }
    }
    const su = Number(body.serverUpdatedAt);
    const serverUpdatedAt = Number.isFinite(su) ? su : 0;
    const sv = Number(body.stateVersion);
    const stateVersion = Number.isFinite(sv) ? sv : serverUpdatedAt;
    return {
      ok: true,
      data: {
        version: 1,
        serverUpdatedAt,
        stateVersion,
        stock,
        storedBatteries,
        stackableCategories: parseStackableCategories(body.stackableCategories)
      }
    };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
