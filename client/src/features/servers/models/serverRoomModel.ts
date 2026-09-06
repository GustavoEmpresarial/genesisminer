import type { PlacedRack, StoredBattery, Upgrade } from '../types';
import {
  isAsicMachineUpgrade,
  isChassisAllowedForRoomAffinity,
  isNftCollectibleMachine,
  resolveChassisRackRoomAffinity,
  resolveClientRoomKind
} from '../types';
import { batteryTierScore } from './roomBatteryModel';
import { isCompatibleWithRack } from '../lib/upgradeRackCompat';

/** UUID v4 de instância em `stored_batteries.id` / `placed_racks.battery_id` (alinhado ao servidor). */
const RACK_BATTERY_INSTANCE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRackBatteryInstanceUuid(batteryId: string | null | undefined): boolean {
  return RACK_BATTERY_INSTANCE_UUID_RE.test(String(batteryId ?? '').trim());
}

function isBatteryUpgrade(upgrade: Upgrade | undefined | null): upgrade is Upgrade {
  if (!upgrade) return false;
  return upgrade.type === 'battery' || String(upgrade.category || '').toLowerCase() === 'battery';
}

/** `rack.batteryId` deve ser UUID de instância; catálogo só em legado até migração.
 * `batteryInstanceCatalogHints`: mapa instância UUID → id de catálogo (bateria montada a partir de stock). */
export function resolvePlacedRackBatteryCatalogId(
  rack: PlacedRack,
  storedBatteries: StoredBattery[] | null | undefined,
  upgrades?: Upgrade[] | null,
  batteryInstanceCatalogHints?: Readonly<Record<string, string>> | null
): string | null {
  const bid = rack.batteryId != null ? String(rack.batteryId).trim() : '';
  if (!bid) return null;

  const snapCat =
    rack.batteryCatalogItemId != null ? String(rack.batteryCatalogItemId).trim() : '';
  if (snapCat && upgrades?.length) {
    const okSnap = upgrades.some((u) => u.id === snapCat && isBatteryUpgrade(u));
    if (okSnap) return snapCat;
  }

  const hintedRaw = batteryInstanceCatalogHints?.[bid];
  const hinted = hintedRaw != null ? String(hintedRaw).trim() : '';
  if (hinted && upgrades?.length) {
    const ok = upgrades.some((u) => u.id === hinted && isBatteryUpgrade(u));
    if (ok) return hinted;
  }

  const row = (storedBatteries || []).find((b) => String(b.id).trim() === bid);
  const catFromRow = row?.itemId != null ? String(row.itemId).trim() : '';

  if (upgrades && upgrades.length > 0) {
    if (catFromRow) {
      const fromCat = upgrades.find((u) => u.id === catFromRow && isBatteryUpgrade(u));
      if (fromCat) return catFromRow;
    }
    const direct = upgrades.find((u) => u.id === bid && isBatteryUpgrade(u));
    if (direct) return bid;
    return null;
  }
  if (catFromRow) return catFromRow;
  return bid;
}

export type ServerRoomSelectionType = 'machine' | 'battery' | 'wiring' | 'multiplier' | 'rack';

export interface ServerRoomSelectionContext {
  rackId: string | null;
  slotIndex: number | null;
  type: ServerRoomSelectionType;
  roomId?: string | null;
  roomName?: string | null;
  /** Vindo de `/api/my-rig-rooms` quando a sala está na política NFT H1-only. */
  nftAutoArmario1Only?: boolean;
  roomKind?: string;
  asicRoom?: boolean;
}

export type MachinePickerSortMode = 'default' | 'power_desc' | 'power_asc';
export const DEFAULT_MACHINE_PICKER_SORT: MachinePickerSortMode = 'default';

export function nextHorizontalScrollLeft(
  _scrollLeft: number,
  clientWidth: number,
  childOffset: number,
  childWidth: number
): number {
  const target = childOffset - (clientWidth - childWidth) / 2;
  return Math.max(0, target);
}

export function calculateRackConsumptionWatts(rack: PlacedRack, upgrades: Upgrade[]): number {
  const slotsWatts = (rack.slots || []).reduce((acc, sid) => {
    const m = upgrades.find((u) => u.id === sid);
    return acc + (m?.powerConsumption || 0);
  }, 0);
  const multWatts = (rack.multiplierSlots || []).reduce((acc, sid) => {
    const m = upgrades.find((u) => u.id === sid);
    return acc + (m?.powerConsumption || 0);
  }, 0);

  let total = slotsWatts + multWatts;
  if (rack.wiringId) {
    const wiring = upgrades.find((u) => u.id === rack.wiringId);
    if (wiring?.energyConsumptionReduction) {
      total *= 1 - wiring.energyConsumptionReduction;
    }
  }
  return total;
}

export function calculatePlacedRacksProductionHashrate(
  racks: PlacedRack[],
  upgrades: Upgrade[],
  _storedBatteries?: StoredBattery[] | null,
  _batteryInstanceCatalogHints?: Readonly<Record<string, string>> | null
): number {
  let total = 0;
  racks.forEach((rack) => {
    if (rack.isOn && rack.wiringId && rack.batteryId) {
      const baseProd = rack.slots.reduce((acc, sid) => {
        const m = upgrades.find((u) => u.id === sid);
        return acc + (m?.baseProduction || 0);
      }, 0);
      let mult = 1;
      if (rack.multiplierSlots) {
        rack.multiplierSlots.forEach((sid) => {
          const m = upgrades.find((u) => u.id === sid);
          if (m?.multiplier) mult += m.multiplier;
        });
      }
      const rackUp = upgrades.find((u) => u.id === rack.itemId);
      if (rackUp?.type === 'infrastructure' && rackUp.multiplier) {
        mult += rackUp.multiplier;
      }
      total += baseProd * mult;
    }
  });
  return total;
}

export type RackLayoutSlot = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Área do monitor no chassis (canto inferior direito na arte do rig). */
const DEFAULT_PRODUCTION_DISPLAY_SLOT: RackLayoutSlot = {
  id: 'production_display_auto',
  type: 'production_display',
  x: 66,
  y: 52,
  w: 28,
  h: 16
};

/** Normaliza layout: remove barra de bateria; stat_monitor passa a ecrã de produção. */
export function mergeBatteryWidgetsIfAbsent(layout: {
  slots?: RackLayoutSlot[];
  canvasWidth?: number;
  canvasHeight?: number;
}): { slots: RackLayoutSlot[]; canvasWidth: number; canvasHeight: number } {
  const raw = Array.isArray(layout.slots) ? layout.slots : [];
  const hadProductionArea = raw.some(
    (s) => s.type === 'production_display' || s.type === 'stat_monitor'
  );
  const slots: RackLayoutSlot[] = raw
    .filter((s) => s.type !== 'battery_bar')
    .map((s) =>
      s.type === 'stat_monitor'
        ? { ...s, type: 'production_display', id: s.id || 'production_display' }
        : s
    );
  const canvasWidth = layout.canvasWidth || 500;
  const canvasHeight = layout.canvasHeight || 600;
  if (!hadProductionArea) {
    slots.push({ ...DEFAULT_PRODUCTION_DISPLAY_SLOT });
  }
  return { slots, canvasWidth, canvasHeight };
}

export function getDefaultRackLayout(rackDef: Upgrade): {
  slots: RackLayoutSlot[];
  canvasWidth: number;
  canvasHeight: number;
} {
  const slots: RackLayoutSlot[] = [];
  const slotCount = rackDef.slotsCapacity || 0;
  for (let i = 0; i < slotCount; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    slots.push({
      id: `slot_${i}`,
      type: 'machine',
      x: 5 + col * 31,
      y: 10 + row * 15,
      w: 28,
      h: 12
    });
  }
  slots.push({ id: 'battery', type: 'battery', x: 75, y: 70, w: 20, h: 8 });
  slots.push({ id: 'wiring', type: 'wiring', x: 75, y: 80, w: 20, h: 8 });
  const aiCount = rackDef.aiSlotsCapacity || 0;
  for (let i = 0; i < aiCount; i++) {
    slots.push({ id: `slot_${i}`, type: 'multiplier', x: 75, y: 10 + i * 10, w: 20, h: 8 });
  }
  slots.push({ id: 'power', type: 'power', x: 10, y: 85, w: 12, h: 10 });
  slots.push({ id: 'config', type: 'config', x: 25, y: 85, w: 12, h: 10 });
  slots.push({ id: 'coin_selector', type: 'coin_selector', x: 40, y: 85, w: 30, h: 10 });
  slots.push({ ...DEFAULT_PRODUCTION_DISPLAY_SLOT, id: 'production_display' });
  return { slots, canvasWidth: 500, canvasHeight: 600 };
}

export function listInfrastructureInStock(upgrades: Upgrade[], stock: Record<string, number>): Upgrade[] {
  return upgrades.filter((u) => u.type === 'infrastructure' && (stock[u.id] || 0) > 0);
}

export function listItemsForSelection(
  selection: ServerRoomSelectionContext,
  placedRacks: PlacedRack[],
  upgrades: Upgrade[],
  stock: Record<string, number>,
  _sort?: MachinePickerSortMode
): Upgrade[] {
  if (selection.type === 'rack') {
    const kind = resolveClientRoomKind({
      roomId: selection.roomId,
      roomName: selection.roomName,
      roomKind: selection.roomKind,
      nftAutoArmario1Only: selection.nftAutoArmario1Only
    });
    return upgrades.filter((u) => {
      if (u.type !== 'infrastructure' || !(stock[u.id] || 0)) return false;
      const affinity = resolveChassisRackRoomAffinity(u.id, u.rackRoomAffinity);
      return isChassisAllowedForRoomAffinity(affinity, kind);
    });
  }
  const currentRack = selection.rackId ? placedRacks.find((r) => r.id === selection.rackId) : undefined;
  let filtered = upgrades.filter((u) => u.type === selection.type && (stock[u.id] || 0) > 0);
  if (currentRack) {
    filtered = filtered.filter((u) => {
      if (u.compatibleRacks?.length) return isCompatibleWithRack(u.compatibleRacks, currentRack.itemId);
      return true;
    });
  }
  if (selection.type === 'machine') {
    const kind = resolveClientRoomKind({
      roomId: selection.roomId,
      roomName: selection.roomName,
      roomKind: selection.roomKind,
      nftAutoArmario1Only: selection.nftAutoArmario1Only
    });
    if (kind === 'asic') {
      filtered = filtered.filter((u) => isAsicMachineUpgrade(u));
    } else if (kind === 'nft') {
      filtered = filtered.filter((u) => isNftCollectibleMachine(u) && Boolean(u.nftMiningCoinId));
    } else {
      // Sala normal: nem ASIC real nem colecionável NFT.
      filtered = filtered.filter((u) => !isAsicMachineUpgrade(u) && !isNftCollectibleMachine(u));
    }
  }
  return filtered;
}

export function listStoredBatteriesForSelection(
  selection: ServerRoomSelectionContext,
  placedRacks: PlacedRack[],
  storedBatteries: StoredBattery[],
  upgrades: Upgrade[]
): StoredBattery[] {
  if (selection.type !== 'battery' || !selection.rackId) return [];
  const currentRack = placedRacks.find((r) => r.id === selection.rackId);
  const mountedIds = new Set(
    (placedRacks || []).map((r) => (r.batteryId != null ? String(r.batteryId).trim() : '')).filter(Boolean)
  );

  const filtered = storedBatteries.filter((sb) => {
    const sid = String(sb.id).trim();
    if (mountedIds.has(sid)) return false;
    const def = upgrades.find((u) => u.id === sb.itemId);
    if (currentRack && def?.compatibleRacks?.length)
      return isCompatibleWithRack(def.compatibleRacks, currentRack.itemId);
    return true;
  });

  return filtered.sort((a, b) => {
    const da = upgrades.find((u) => u.id === a.itemId);
    const db = upgrades.find((u) => u.id === b.itemId);
    const ta = batteryTierScore(da);
    const tb = batteryTierScore(db);
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** One picker row per catalog battery — stock qty only. */
export type BatteryPickerRow = {
  itemId: string;
  upgrade: Upgrade;
  /** @deprecated Always empty — inventory is stock-only. */
  warehouseIds: string[];
  stockCount: number;
};

export function listBatteryPickerRows(
  selection: ServerRoomSelectionContext,
  placedRacks: PlacedRack[],
  _storedBatteries: StoredBattery[],
  upgrades: Upgrade[],
  stock: Record<string, number>
): BatteryPickerRow[] {
  if (selection.type !== 'battery') return [];
  const stockItems = listItemsForSelection(selection, placedRacks, upgrades, stock);
  const byId = new Map<string, BatteryPickerRow>();

  for (const item of stockItems) {
    const qty = Math.max(0, Math.floor(Number(stock[item.id]) || 0));
    if (qty <= 0) continue;
    byId.set(item.id, { itemId: item.id, upgrade: item, warehouseIds: [], stockCount: qty });
  }

  return [...byId.values()].sort((a, b) => {
    const ta = batteryTierScore(a.upgrade);
    const tb = batteryTierScore(b.upgrade);
    if (tb !== ta) return tb - ta;
    return a.upgrade.name.localeCompare(b.upgrade.name);
  });
}

export function formatHashrateDisplay(val: number): string {
  if (val === 0) return '0';
  if (val < 0.0001) return val.toFixed(8);
  if (val < 1) {
    return val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(val);
}
