import { normalizePlacedRackRoomId, type GameState, type PlacedRack, type StoredBattery, type Upgrade } from '../types';
import { isCompatibleWithRack } from '../lib/upgradeRackCompat';

const newStoredId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `sb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export type BatteryRigSortMode = 'slot_asc' | 'hashrate_desc';

export type BulkRoomBatteryApplyOptions = {
  /** Ordenação das rigs ao distribuir unidades (modo tipo único ou inteligente). */
  rigSort?: BatteryRigSortMode;
};

/** Unidades disponíveis = qty em `stock` (+ UUIDs soltos legado em `storedBatteries` durante migração). */
export function totalBatteryInstances(
  batteryItemId: string,
  stock: Record<string, number>,
  storedBatteries: StoredBattery[]
): number {
  if (!batteryItemId || typeof batteryItemId !== 'string') return 0;
  const s = Math.max(0, Math.floor(Number(stock[batteryItemId]) || 0));
  const inStorage = (storedBatteries || []).filter((b) => b && b.itemId === batteryItemId).length;
  return s + inStorage;
}

/** Hash teórico (GPUs × multiplicadores) para ordenar rigs — sem exigir bateria/fiação ligadas. */
export function rackTheoreticalHash(placedRacks: PlacedRack[], rackIndex: number, upgrades: Upgrade[]): number {
  const rack = placedRacks[rackIndex];
  if (!rack) return 0;
  let base = 0;
  for (const sid of rack.slots || []) {
    if (!sid) continue;
    base += upgrades.find((u) => u.id === sid)?.baseProduction || 0;
  }
  let mult = 1;
  for (const sid of rack.multiplierSlots || []) {
    if (!sid) continue;
    const m = upgrades.find((u) => u.id === sid);
    if (m?.multiplier) mult += m.multiplier;
  }
  return base * mult;
}

function sortRackIndicesForAllocation(
  indices: number[],
  placedRacks: PlacedRack[],
  upgrades: Upgrade[],
  rigSort: BatteryRigSortMode
): number[] {
  const arr = [...indices];
  arr.sort((ai, bi) => {
    if (rigSort === 'hashrate_desc') {
      const ha = rackTheoreticalHash(placedRacks, ai, upgrades);
      const hb = rackTheoreticalHash(placedRacks, bi, upgrades);
      if (hb !== ha) return hb - ha;
    }
    const a = placedRacks[ai];
    const b = placedRacks[bi];
    const sa = a?.slotIndex ?? ai;
    const sb = b?.slotIndex ?? bi;
    if (sa !== sb) return sa - sb;
    return ai - bi;
  });
  return arr;
}

/** Índices em `placedRacks` das rigs da sala compatíveis com a bateria. */
export function compatibleRackIndicesForBattery(
  placedRacks: PlacedRack[],
  roomId: string,
  batDef: Upgrade
): number[] {
  if (!roomId || !batDef || batDef.type !== 'battery') return [];
  const roomNorm = normalizePlacedRackRoomId(roomId);
  const inRoom = placedRacks
    .map((r, i) => (normalizePlacedRackRoomId(r.roomId) === roomNorm ? i : -1))
    .filter((i): i is number => i >= 0);
  return inRoom.filter((i) => {
    const rack = placedRacks[i];
    if (!rack) return false;
    if (!batDef.compatibleRacks?.length) return true;
    return isCompatibleWithRack(batDef.compatibleRacks, rack.itemId);
  });
}

/**
 * Devolve a bateria UUID infinita equipada na rig ao stock (sem dividir entre cheia/parcial).
 */
function unloadRackBatteryToInventory(
  rack: PlacedRack,
  ns: Record<string, number>,
  nb: StoredBattery[],
  _upgrades: Upgrade[]
): void {
  if (!rack.batteryId) return;
  const id = String(rack.batteryId).trim();
  if (!id) return;
  const idx = nb.findIndex((b) => b && String(b.id).trim() === id);
  let catalogId = '';
  if (idx >= 0) {
    catalogId = String(nb[idx]!.itemId || '').trim();
    nb.splice(idx, 1);
  } else {
    catalogId = String(rack.batteryCatalogItemId || '').trim() || id;
  }
  if (!catalogId) return;
  ns[catalogId] = (ns[catalogId] || 0) + 1;
}

/** Retira uma unidade do stock. Tudo é infinito → não há carga residual. */
function takeOneBatteryUnit(
  batteryItemId: string,
  ns: Record<string, number>,
  nb: StoredBattery[]
): { instanceId: string } | null {
  if ((ns[batteryItemId] || 0) > 0) {
    ns[batteryItemId]--;
    return { instanceId: newStoredId() };
  }
  const idx = nb.findIndex((b) => b && b.itemId === batteryItemId);
  if (idx >= 0) {
    const [taken] = nb.splice(idx, 1);
    return { instanceId: taken.id };
  }
  return null;
}

export type BulkRoomBatteryResult =
  | { ok: true; next: GameState; appliedRigs: number; compatibleRigs: number; smartFill?: boolean }
  | { ok: false; message: string };

export function bulkBatteryWillApplyCount(
  compatibleRackCount: number,
  batteryItemId: string,
  stock: Record<string, number>,
  storedBatteries: StoredBattery[]
): number {
  const avail = totalBatteryInstances(batteryItemId, stock, storedBatteries);
  return Math.max(0, Math.min(compatibleRackCount, avail));
}

export function batteryTierScore(def: Upgrade | undefined): number {
  if (!def || def.type !== 'battery') return 0;
  const c = def.powerCapacity;
  if (c === -1) return Number.MAX_SAFE_INTEGER - 1;
  return Math.max(0, Number(c) || 0);
}

/**
 * Smart fill: agora que toda bateria é infinita por design, basta retirar baterias antigas das rigs
 * e equipar tipos compatíveis disponíveis (stock UUID), respeitando a ordem das rigs.
 */
export function applyBulkRoomBatterySmartFill(
  prev: GameState,
  roomId: string,
  upgrades: Upgrade[],
  rigSort: BatteryRigSortMode
): BulkRoomBatteryResult {
  const room = normalizePlacedRackRoomId(roomId);
  if (!room) return { ok: false, message: 'Sala inválida.' };

  const racksInRoomIdx = prev.placedRacks
    .map((r, i) => (normalizePlacedRackRoomId(r.roomId) === room ? i : -1))
    .filter((i) => i >= 0);
  if (racksInRoomIdx.length === 0) {
    return { ok: false, message: 'Nenhuma rig nesta sala.' };
  }

  let ns = { ...prev.stock };
  let nb = [...(prev.storedBatteries || [])];
  const out = [...prev.placedRacks];

  for (const i of racksInRoomIdx) {
    const rack = out[i];
    if (!rack?.batteryId) continue;
    unloadRackBatteryToInventory(rack, ns, nb, upgrades);
    out[i] = { ...rack, batteryId: null, isOn: false };
  }

  type PoolEntry = { itemId: string; storageId?: string };
  const pool: PoolEntry[] = [];

  for (const u of upgrades) {
    if (u.type !== 'battery') continue;
    const qtyStock = Math.max(0, Math.floor(Number(ns[u.id]) || 0));
    const storedList = nb.filter((b) => b && b.itemId === u.id);
    if (storedList.length === 0 && qtyStock === 0) continue;

    const usableOnAnyRack = racksInRoomIdx.some((ri) => {
      const ch = out[ri]?.itemId;
      if (!ch) return false;
      return !u.compatibleRacks?.length || isCompatibleWithRack(u.compatibleRacks, ch);
    });
    if (!usableOnAnyRack) continue;

    for (const s of storedList) {
      pool.push({ itemId: u.id, storageId: s.id });
    }
    for (let q = 0; q < qtyStock; q++) {
      pool.push({ itemId: u.id });
    }
  }

  if (pool.length === 0) {
    return { ok: false, message: 'Não há baterias no stock compatíveis com as rigs desta sala.' };
  }

  pool.sort((a, b) => {
    const da = upgrades.find((x) => x.id === a.itemId);
    const db = upgrades.find((x) => x.id === b.itemId);
    const ta = batteryTierScore(da);
    const tb = batteryTierScore(db);
    if (tb !== ta) return tb - ta;
    return 0;
  });

  const sortedRacks = sortRackIndicesForAllocation(racksInRoomIdx, out, upgrades, rigSort);
  let applied = 0;

  for (const ri of sortedRacks) {
    const rack = out[ri];
    const ch = rack.itemId;
    const idx = pool.findIndex((p) => {
      const def = upgrades.find((x) => x.id === p.itemId);
      if (!def || def.type !== 'battery') return false;
      return !def.compatibleRacks?.length || isCompatibleWithRack(def.compatibleRacks, ch);
    });
    if (idx === -1) continue;
    const picked = pool[idx]!;
    pool.splice(idx, 1);

    if (picked.storageId) {
      const sbi = nb.findIndex((x) => x.id === picked.storageId);
      if (sbi < 0) continue;
      nb.splice(sbi, 1);
    } else {
      if ((ns[picked.itemId] || 0) < 1) continue;
      ns[picked.itemId]--;
    }

    const rackBattId =
      picked.storageId != null && String(picked.storageId).trim() !== ''
        ? String(picked.storageId).trim()
        : newStoredId();
    out[ri] = {
      ...rack,
      batteryId: rackBattId,
      isOn: true
    };
    applied++;
  }

  return {
    ok: true,
    next: { ...prev, stock: ns, storedBatteries: nb, placedRacks: out },
    appliedRigs: applied,
    compatibleRigs: racksInRoomIdx.length,
    smartFill: true
  };
}

/**
 * Remove todas as baterias das rigs da sala (`batteryUpgradeId` vazio) ou equipa o mesmo tipo
 * em até N rigs compatíveis (N = min(rigs compatíveis, unidades em stock)).
 */
export function applyBulkRoomBatteryChange(
  prev: GameState,
  roomId: string,
  batteryUpgradeId: string,
  upgrades: Upgrade[],
  opts?: BulkRoomBatteryApplyOptions
): BulkRoomBatteryResult {
  const room = normalizePlacedRackRoomId(roomId);
  if (!room) return { ok: false, message: 'Sala inválida.' };

  const racksInRoomIdx = prev.placedRacks
    .map((r, i) => (normalizePlacedRackRoomId(r.roomId) === room ? i : -1))
    .filter((i) => i >= 0);

  if (!batteryUpgradeId) {
    let ns = { ...prev.stock };
    const nb = [...(prev.storedBatteries || [])];
    const out = [...prev.placedRacks];
    for (const i of racksInRoomIdx) {
      const rack = out[i];
      if (!rack?.batteryId) continue;
      unloadRackBatteryToInventory(rack, ns, nb, upgrades);
      out[i] = { ...rack, batteryId: null, isOn: false };
    }
    return {
      ok: true,
      next: { ...prev, stock: ns, storedBatteries: nb, placedRacks: out },
      appliedRigs: 0,
      compatibleRigs: 0
    };
  }

  const batDef = upgrades.find((u) => u.id === batteryUpgradeId && u.type === 'battery');
  if (!batDef) return { ok: false, message: 'Bateria inválida.' };

  let compatibleIdx = compatibleRackIndicesForBattery(prev.placedRacks, room, batDef);
  if (compatibleIdx.length === 0) {
    return { ok: false, message: 'Nenhuma rig nesta sala é compatível com este tipo de bateria.' };
  }

  const rigSort: BatteryRigSortMode = opts?.rigSort === 'hashrate_desc' ? 'hashrate_desc' : 'slot_asc';
  compatibleIdx = sortRackIndicesForAllocation(compatibleIdx, prev.placedRacks, upgrades, rigSort);

  const totalAvail = totalBatteryInstances(batteryUpgradeId, prev.stock, prev.storedBatteries || []);
  if (totalAvail <= 0) {
    return { ok: false, message: `Não há unidades de "${batDef.name}" no stock.` };
  }

  const nApply = Math.min(compatibleIdx.length, totalAvail);
  let ns = { ...prev.stock };
  const nb = [...(prev.storedBatteries || [])];
  const out = [...prev.placedRacks];

  for (let k = 0; k < nApply; k++) {
    const i = compatibleIdx[k]!;
    const rack = { ...out[i] };
    if (rack.batteryId) unloadRackBatteryToInventory(rack, ns, nb, upgrades);
    const taken = takeOneBatteryUnit(batteryUpgradeId, ns, nb);
    if (!taken || !taken.instanceId) {
      return { ok: false, message: 'Falha ao retirar unidade do stock. Tente novamente.' };
    }
    out[i] = {
      ...rack,
      batteryId: taken.instanceId,
      isOn: true
    };
  }

  return {
    ok: true,
    next: { ...prev, stock: ns, storedBatteries: nb, placedRacks: out },
    appliedRigs: nApply,
    compatibleRigs: compatibleIdx.length
  };
}
