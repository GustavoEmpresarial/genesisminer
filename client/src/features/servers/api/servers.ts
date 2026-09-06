import type { AsicLeaseDetail, MiningCoin, PlacedRack, RigRoom, StoredBattery, Upgrade } from '../types';
import { apiFetch } from '../../../shared/api/http';

const base = '/api';

function parseJsonArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

let globalLastLoadTime = 0;
let globalInventoryVersion = 0;

/** Revisão do servidor usada em saves e mutações autoritárias (ex.: oficina). */
export function getGlobalLastLoadTime(): number {
  return globalLastLoadTime;
}

export function setGlobalLastLoadTime(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) globalLastLoadTime = ms;
}

export function getGlobalInventoryVersion(): number {
  return globalInventoryVersion;
}

export function setGlobalInventoryVersion(n: number): void {
  if (Number.isFinite(n) && n >= 0) globalInventoryVersion = Math.floor(n);
}

/** Chave idempotência para mutações de intenção na área Servidores (8–128 chars seguros). */
export function newServerIntentIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `srv_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

/** Estado consolidado da área Servidores (fonte de verdade no backend). */
export type ServersStatePayload = {
  version: 1;
  usdc: number;
  serverUpdatedAt: number;
  /** Igual a `serverUpdatedAt` — controlo de versão para mutações autoritativas. */
  stateVersion?: number;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  placedRacks: PlacedRack[];
  rigRooms: RigRoom[];
  miningCoins: MiningCoin[];
  upgrades: Upgrade[];
  nftAsicMinedUsdTotal?: number;
  asicRoomMinedUsdTotal?: number;
  asicLeaseDetails?: AsicLeaseDetail[];
};

export async function getServersState(): Promise<ServersStatePayload | null> {
  try {
    const res = await apiFetch(`${base}/servers/state`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<ServersStatePayload>;
    if (j.version !== 1 || !Array.isArray(j.rigRooms)) return null;
    const serverUpdatedAt =
      typeof j.serverUpdatedAt === 'number' && Number.isFinite(j.serverUpdatedAt) ? j.serverUpdatedAt : 0;
    const stateVersion =
      typeof j.stateVersion === 'number' && Number.isFinite(j.stateVersion) ? j.stateVersion : serverUpdatedAt;
    const nftAsic =
      typeof j.nftAsicMinedUsdTotal === 'number' && Number.isFinite(j.nftAsicMinedUsdTotal)
        ? j.nftAsicMinedUsdTotal
        : 0;
    return {
      version: 1,
      usdc: typeof j.usdc === 'number' && Number.isFinite(j.usdc) ? j.usdc : 0,
      serverUpdatedAt,
      stateVersion,
      stock: j.stock && typeof j.stock === 'object' && !Array.isArray(j.stock) ? (j.stock as Record<string, number>) : {},
      storedBatteries: Array.isArray(j.storedBatteries) ? (j.storedBatteries as StoredBattery[]) : [],
      placedRacks: Array.isArray(j.placedRacks) ? (j.placedRacks as PlacedRack[]) : [],
      rigRooms: j.rigRooms as RigRoom[],
      miningCoins: Array.isArray(j.miningCoins) ? (j.miningCoins as MiningCoin[]) : [],
      upgrades: Array.isArray(j.upgrades) ? (j.upgrades as Upgrade[]) : [],
      nftAsicMinedUsdTotal: nftAsic,
      asicRoomMinedUsdTotal: nftAsic,
      asicLeaseDetails: Array.isArray(j.asicLeaseDetails) ? (j.asicLeaseDetails as AsicLeaseDetail[]) : []
    };
  } catch {
    return null;
  }
}

export async function getMyRigRooms(email: string): Promise<RigRoom[]> {
  try {
    const res = await apiFetch(`${base}/my-rig-rooms/${encodeURIComponent(email)}`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<RigRoom>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function purchaseRoomSlot(
  email: string,
  roomId: string,
  quantity = 1,
  idempotencyKey?: string
): Promise<{
  ok: boolean;
  newUsdc?: number;
  slotsPurchased?: number;
  totalPaid?: number;
  error?: string;
  code?: string;
  missing?: number;
  cached?: boolean;
}> {
  void email;
  try {
    const idem =
      idempotencyKey && idempotencyKey.trim().length >= 8
        ? idempotencyKey.trim().slice(0, 128)
        : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `room_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const res = await apiFetch(`${base}/rig-rooms/purchase-slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, quantity, idempotencyKey: idem })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      newUsdc?: number;
      slotsPurchased?: number;
      totalPrice?: number;
      error?: string;
      code?: string;
      missing?: number;
      cached?: boolean;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || 'Purchase failed',
        code: data.code,
        missing: data.missing
      };
    }
    return {
      ok: data.ok !== false,
      newUsdc: data.newUsdc,
      slotsPurchased: data.slotsPurchased,
      totalPaid: data.totalPrice,
      error: data.error,
      code: data.code,
      missing: data.missing,
      cached: data.cached
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type ServersRackAuxIntentOk = {
  ok: true;
  serverUpdatedAt: number;
  stateVersion: number;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  placedRacks: PlacedRack[];
};

function parseServersRackAuxIntentOk(raw: Record<string, unknown>): ServersRackAuxIntentOk | null {
  const hasState =
    raw.stock &&
    typeof raw.stock === 'object' &&
    !Array.isArray(raw.stock) &&
    Array.isArray(raw.storedBatteries) &&
    Array.isArray(raw.placedRacks);
  if (raw.ok !== true && !hasState) return null;
  const su = Number(raw.serverUpdatedAt);
  return {
    ok: true,
    serverUpdatedAt: Number.isFinite(su) ? su : 0,
    stateVersion: Number(raw.stateVersion) || su || 0,
    stock:
      raw.stock && typeof raw.stock === 'object' && !Array.isArray(raw.stock)
        ? (raw.stock as Record<string, number>)
        : {},
    storedBatteries: Array.isArray(raw.storedBatteries) ? (raw.storedBatteries as StoredBattery[]) : [],
    placedRacks: Array.isArray(raw.placedRacks) ? (raw.placedRacks as PlacedRack[]) : []
  };
}

type ServersIntentErr = { ok: false; status: number; error: string; code?: string; forceReload?: boolean };

/** Colocar nova rig a partir do stock (mutação autoritativa). */
export async function postServersPlaceRack(body: {
  catalogItemId: string;
  roomId: string;
  slotIndex: number;
  idempotencyKey: string;
  clientStateVersion: number;
  inventoryVersion?: number;
}): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  try {
    const res = await apiFetch(`${base}/servers/racks/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Desmontar rig a partir do servidor, devolvendo componentes válidos ao estoque. */
export async function postServersRemoveRack(rackId: string): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: idem, clientStateVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Equipar GPU/minerador em slot da rig via servidor. */
export async function postServersRackMinerEquip(
  rackId: string,
  slotIndex: number,
  catalogItemId: string
): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/miners/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotIndex, catalogItemId, idempotencyKey: idem, clientStateVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Remover GPU/minerador de slot da rig via servidor. */
export async function postServersRackMinerUnequip(
  rackId: string,
  slotIndex: number
): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/miners/unequip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotIndex, idempotencyKey: idem, clientStateVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Equipar auxiliar na rig (bateria / cablagem / multiplicador) — mutação autoritativa. */
export async function postServersRackAuxEquip(
  rackId: string,
  body: {
    kind: 'battery' | 'wiring' | 'multiplier';
    storedBatteryId?: string;
    catalogItemId?: string;
    multiplierSlotIndex?: number;
  }
): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/aux/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, idempotencyKey: idem, clientStateVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Desequipar auxiliar na rig. */
export async function postServersRackAuxUnequip(
  rackId: string,
  body: { kind: 'battery' | 'wiring' | 'multiplier'; multiplierSlotIndex?: number }
): Promise<ServersRackAuxIntentOk | ServersIntentErr> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/aux/unequip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, idempotencyKey: idem, clientStateVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    const su = Number(raw.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Moeda em todas as rigs da sala (Servidores) — servidor valida e persiste. */
export async function postServerRoomRoomCoins(
  roomId: string,
  coinId: string
): Promise<{ ok: true; serverUpdatedAt: number; placedRacks: PlacedRack[] } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(`${base}/server-room/room-coins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, coinId })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      return { ok: false, error: err };
    }
    const su = Number(data.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
    return {
      ok: true,
      serverUpdatedAt: su,
      placedRacks: Array.isArray(data.placedRacks) ? (data.placedRacks as PlacedRack[]) : []
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type SaveServersStateResult = {
  ok: boolean;
  forceReload?: boolean;
  error?: string;
  serverUpdatedAt?: number;
  nftAutoSanitized?: boolean;
  placedRacks?: PlacedRack[];
  stock?: Record<string, number>;
  storedBatteries?: StoredBattery[];
};

/** Gravação parcial da área Servidores (`POST /game/save-servers`). */
export async function saveServersState(state: {
  placedRacks: PlacedRack[];
  stock?: Record<string, number>;
  storedBatteries?: StoredBattery[];
}): Promise<SaveServersStateResult> {
  const payload: Record<string, unknown> = {
    lastLoadTime: globalLastLoadTime,
    placedRacks: state.placedRacks
  };
  if (state.stock != null) payload.stock = state.stock;
  if (state.storedBatteries != null) payload.storedBatteries = state.storedBatteries;
  try {
    const res = await apiFetch(`${base}/game/save-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        return { ok: false, ...(errBody as object) };
      } catch {
        return { ok: false, error: `HTTP ${res.status}` };
      }
    }
    try {
      const data = (await res.json()) as SaveServersStateResult;
      if (data && data.serverUpdatedAt) {
        globalLastLoadTime = data.serverUpdatedAt;
      }
      return data;
    } catch {
      return { ok: false, error: 'Resposta inválida ao guardar. Recarregue (F5).' };
    }
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
