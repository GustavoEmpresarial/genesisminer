/**
 * Snapshot autoritativo para a área Servidores — alinhado com leituras de `GET /api/game-state`
 * (subconjunto: stock, baterias, racks, salas, moedas, upgrades).
 *
 * Migrado de legacy/backend/modules/servers/servers.snapshot.service.ts, verbatim.
 */
import { prisma } from '../../../core/database/prisma.js';
import pool from '../../../core/database/pool.js';
import { computeProgressForUser } from '../../mining-engine/services/progress-computer.js';
import { SAVE_GAME_ITEM_ID_RE } from '../../hardware/services/save-guard.js';
import { loadMyRigRoomsForUser } from './rig-rooms.js';
import { loadMiningCoinsForBootstrap, loadUpgradesForBootstrap } from './bootstrap-catalog.js';
import { normalizePlacedRackRoomId } from '../../hardware/services/validation.js';
import { isRackBatteryInstanceUuid } from '../../hardware/services/repository.js';
import { normalizeKnown1000WhBatteryCatalogId } from '../../hardware/services/catalog.js';
import { normalizeBatteryStatus } from '../../hardware/services/invariant.js';
import { overlayTimedLeaseStockCounts } from '../../hardware/services/persistence.js';
import { shouldEmitThrottled } from '../../../shared/utils/log-throttle.js';
import { MS_PER_MINUTE } from '../../../shared/utils/time.js';
import type { ServersAuthoritativeStateDto, ServersStateAsicLeaseDetailDto, ServersStatePlacedRackDto, ServersStateStoredBatteryDto } from './servers-state-types.js';

const DEFAULT_PROGRESS_THROTTLE_MS = 30_000;
const CONSISTENCY_THROTTLE_MINUTES = 10;
const REQUEST_ID_MAX_LEN = 120;

function isValidSaveGameItemId(value: unknown): value is string {
  return typeof value === 'string' && SAVE_GAME_ITEM_ID_RE.test(value);
}

/** Expõe construção de racks para testes unitários sem Prisma. */
export function mapPrismaRacksToPlacedRackDtos(
  rackRows: Array<{
    id: string;
    item_id: string;
    wiring_id: string | null;
    battery_id: string | null;
    is_on: number;
    selected_coin_id: string | null;
    room_id: string | null;
    slot_index: number | null;
    battery_catalog_item_id?: string | null;
    battery_display_name?: string | null;
    battery_image_url?: string | null;
  }>,
  slotsList: Array<{
    rack_id: string;
    slot_index: number;
    machine_item_id: string | null;
    machine_lease_id?: string | null;
  }>,
  multipliersList: Array<{ rack_id: string; slot_index: number; multiplier_item_id: string | null }>
): ServersStatePlacedRackDto[] {
  const slotsMap = new Map<string, unknown[]>();
  const slotLeaseMap = new Map<string, (string | null)[]>();
  const multipliersMap = new Map<string, unknown[]>();

  slotsList.forEach((s) => {
    if (!slotsMap.has(s.rack_id)) {
      slotsMap.set(s.rack_id, []);
      slotLeaseMap.set(s.rack_id, []);
    }
    const arr = slotsMap.get(s.rack_id)!;
    const leaseArr = slotLeaseMap.get(s.rack_id)!;
    arr[s.slot_index] = s.machine_item_id;
    const lid = s.machine_lease_id != null ? String(s.machine_lease_id).trim() : '';
    leaseArr[s.slot_index] = lid || null;
  });

  multipliersList.forEach((m) => {
    if (!multipliersMap.has(m.rack_id)) multipliersMap.set(m.rack_id, []);
    const arr = multipliersMap.get(m.rack_id)!;
    arr[m.slot_index] = m.multiplier_item_id;
  });

  const placedRacks: ServersStatePlacedRackDto[] = [];
  for (const r of rackRows) {
    placedRacks.push({
      id: r.id,
      itemId: r.item_id,
      slots: slotsMap.get(r.id) || [],
      slotLeaseIds: slotLeaseMap.get(r.id) || [],
      multiplierSlots: multipliersMap.get(r.id) || [],
      wiringId: r.wiring_id,
      batteryId: r.battery_id,
      isOn: !!r.is_on,
      selectedCoinId: r.selected_coin_id,
      batteryCatalogItemId: r.battery_catalog_item_id != null ? normalizeKnown1000WhBatteryCatalogId(r.battery_catalog_item_id) : null,
      batteryDisplayName: r.battery_display_name ?? null,
      batteryImageUrl: r.battery_image_url ?? null,
      roomId: normalizePlacedRackRoomId(r.room_id),
      slotIndex: r.slot_index || 0
    });
  }
  return placedRacks;
}

export type ServersStateRequestContext = { requestId?: string | null; skipProgress?: boolean };

function safeRequestId(ctx: ServersStateRequestContext | undefined): string | null {
  const r = ctx?.requestId;
  if (r == null || typeof r !== 'string') return null;
  const t = r.trim().slice(0, REQUEST_ID_MAX_LEN);
  return t || null;
}

/** Detecta órfãos/duplicados/status incompatível com `placed_racks` (sem mutar dados). */
export function logServerStateBatteryConsistency(
  userId: number,
  placedRacks: Array<{ id: string; batteryId?: string | null }>,
  storedById: Map<string, { id: string; status: string | null }>,
  ctx?: ServersStateRequestContext
): void {
  const rid = safeRequestId(ctx);
  let orphan = 0;
  let mismatch = 0;
  let duplicate = 0;

  const racksPerBattery = new Map<string, string[]>();
  for (const r of placedRacks) {
    const bid = r.batteryId != null ? String(r.batteryId).trim() : '';
    if (!bid || !isRackBatteryInstanceUuid(bid)) continue;
    const arr = racksPerBattery.get(bid) || [];
    arr.push(String(r.id));
    racksPerBattery.set(bid, arr);
  }
  for (const [, rackIds] of racksPerBattery) {
    if (rackIds.length > 1) duplicate += 1;
  }

  for (const r of placedRacks) {
    const bid = r.batteryId != null ? String(r.batteryId).trim() : '';
    if (!bid || !isRackBatteryInstanceUuid(bid)) continue;
    const sb = storedById.get(bid);
    if (!sb) {
      orphan += 1;
      continue;
    }
    const st = normalizeBatteryStatus(sb.status);
    if (st === 'INVENTORY') mismatch += 1;
  }

  if ((orphan > 0 || mismatch > 0 || duplicate > 0) && shouldEmitThrottled(`srv_bat_consistency:${userId}`, CONSISTENCY_THROTTLE_MINUTES * MS_PER_MINUTE)) {
    console.warn(JSON.stringify({ event: 'server_state_battery_consistency_summary', userId, orphan, mismatch, duplicate, ...(rid ? { requestId: rid } : {}) }));
  }
}

export async function buildServersAuthoritativeStateDto(uid: number, ctx?: ServersStateRequestContext): Promise<ServersAuthoritativeStateDto> {
  if (ctx?.skipProgress !== true) {
    const progressThrottleMs = Math.max(0, parseInt(String(process.env.GAME_STATE_PROGRESS_THROTTLE_MS || String(DEFAULT_PROGRESS_THROTTLE_MS)), 10) || DEFAULT_PROGRESS_THROTTLE_MS);
    const progressRes = await computeProgressForUser(pool, uid, Date.now(), true, { skipIfRecentMs: progressThrottleMs });
    if (!progressRes.ok) {
      console.warn('[servers/state] computeProgressForUser falhou uid=%s — snapshot pode estar ligeiramente atrás neste pedido', uid);
    }
  }

  const [gsRow, stockRows, storedBatRows, rackRows, rigRooms, miningCoins, upgrades] = await Promise.all([
    prisma.game_states.findUnique({ where: { user_id: uid } }),
    prisma.stock.findMany({ where: { user_id: uid } }),
    prisma.stored_batteries.findMany({ where: { user_id: uid }, select: { id: true, item_id: true, display_name: true, image_url: true, status: true } }),
    prisma.placed_racks.findMany({ where: { user_id: uid } }),
    loadMyRigRoomsForUser(uid),
    loadMiningCoinsForBootstrap(),
    loadUpgradesForBootstrap(uid)
  ]);

  const gs = gsRow || ({ usdc: 0, server_updated_at: BigInt(0) } as NonNullable<typeof gsRow>);

  const stock: Record<string, number> = {};
  stockRows.forEach((r) => {
    if (!isValidSaveGameItemId(r.item_id)) return;
    const itemId = normalizeKnown1000WhBatteryCatalogId(r.item_id);
    stock[itemId] = (stock[itemId] || 0) + (Number(r.qty) || 0);
  });
  // ASICs timed: qty autoritativa = leases `stock` válidos (mesmo overlay que loadUserStock).
  {
    const client = await pool.connect();
    try {
      await overlayTimedLeaseStockCounts(client, uid, stock);
    } finally {
      client.release();
    }
  }

  const storedById = new Map<string, { id: string; status: string | null }>();
  for (const r of storedBatRows) {
    storedById.set(String(r.id), { id: String(r.id), status: r.status != null ? String(r.status) : null });
  }

  const storedBatteries: ServersStateStoredBatteryDto[] = storedBatRows.map((r) => ({
    id: r.id,
    itemId: normalizeKnown1000WhBatteryCatalogId(r.item_id),
    displayName: r.display_name != null ? String(r.display_name) : null,
    imageUrl: r.image_url != null ? String(r.image_url) : null
  }));

  let placedRacks: ServersStatePlacedRackDto[] = [];
  if (rackRows.length > 0) {
    const rackIds = rackRows.map((r) => r.id);
    const [slotsList, multipliersList] = await Promise.all([
      prisma.rack_slots.findMany({ where: { rack_id: { in: rackIds } }, orderBy: [{ rack_id: 'asc' }, { slot_index: 'asc' }] }),
      prisma.rack_multiplier_slots.findMany({ where: { rack_id: { in: rackIds } }, orderBy: [{ rack_id: 'asc' }, { slot_index: 'asc' }] })
    ]);
    placedRacks = mapPrismaRacksToPlacedRackDtos(rackRows, slotsList, multipliersList);
  }

  // Off por defeito sob carga; activar com SERVERS_BATTERY_CONSISTENCY_LOG=1
  if (String(process.env.SERVERS_BATTERY_CONSISTENCY_LOG || '').trim() === '1') {
    logServerStateBatteryConsistency(uid, placedRacks, storedById, ctx);
  }

  const serverUpdatedAtNum = Number(gs.server_updated_at ?? 0);
  const serverUpdatedAt = Number.isFinite(serverUpdatedAtNum) ? serverUpdatedAtNum : 0;
  const nftAsicRaw = Number((gs as { nft_asic_mined_usd_total?: number }).nft_asic_mined_usd_total ?? 0);
  const nftAsicMinedUsdTotal = Number.isFinite(nftAsicRaw) ? nftAsicRaw : 0;

  const leaseRows = await prisma.player_asic_leases.findMany({
    where: { user_id: uid },
    select: {
      id: true,
      item_id: true,
      expires_at: true,
      status: true,
      rack_id: true,
      slot_index: true
    }
  });
  const asicLeaseDetails: ServersStateAsicLeaseDetailDto[] = leaseRows
    .map((row) => {
      const st = String(row.status || '').toLowerCase();
      const status: 'stock' | 'equipped' | null = st === 'stock' || st === 'equipped' ? st : null;
      if (!status) return null;
      const expiresAt = Number(row.expires_at);
      return {
        leaseId: String(row.id),
        itemId: String(row.item_id),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        status,
        rackId: row.rack_id != null ? String(row.rack_id) : null,
        slotIndex: row.slot_index != null ? Number(row.slot_index) : null
      };
    })
    .filter((x): x is ServersStateAsicLeaseDetailDto => x != null);

  return {
    version: 1,
    usdc: gs.usdc,
    serverUpdatedAt,
    stateVersion: serverUpdatedAt,
    stock,
    storedBatteries,
    placedRacks,
    rigRooms,
    miningCoins,
    upgrades,
    nftAsicMinedUsdTotal,
    asicLeaseDetails
  };
}
