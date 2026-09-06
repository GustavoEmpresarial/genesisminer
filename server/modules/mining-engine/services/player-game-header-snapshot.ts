/**
 * Saldos USDC/moedas e hashrate por moeda + total, a partir da BD (alinhado ao
 * cálculo de produção do cliente). Mesma fonte usada pelo header do jogo (`/ws/player-game`)
 * e agora também pela Dashboard.
 *
 * Migrado de legacy/backend/lib/playerGameHeaderSnapshot.ts (verbatim).
 */
import { prisma } from '../../../core/database/prisma.js';
import { isCheckinFrozenForUser } from '../../checkin/services/checkin.js';
import { normalizePlacedRackRoomId } from './rack-room-id.js';
import { isNftAutoArmario1OnlyRoomRow, listSlotMiningCredits, NFT_AUTO_ROOM_ID, type UpgradeMiningRow } from './nft-room-mining.js';
import { ASIC_ROOM_ID, isAsicMiningRoomId } from './room-kind.js';
import { effectiveHashWithCheckinBonus, sumNonNftRoomRigHashHps } from './checkin-bonus-hash.js';
import { aggregateHeaderHash } from './player-game-header-rust-bridge.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../../shared/utils/time.js';
import { roundMinedCoinAmount } from '../../../shared/utils/mined-coin-amount.js';
import { lastCompletedTenMinuteUtcGrid } from './wall-clock-grid.js';

function num(v: unknown, def = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : def;
}

export type UpgradeRow = {
  base: number;
  mult: number;
  cap: number | null;
  type: string;
  category: string | null;
  nft_mining_coin_id: string | null;
};

const POWER_CAPACITY_UNLIMITED = -1;

function parsePowerCapacity(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw === POWER_CAPACITY_UNLIMITED ? POWER_CAPACITY_UNLIMITED : num(raw);
  const s = String(raw).trim();
  if (s === String(POWER_CAPACITY_UNLIMITED)) return POWER_CAPACITY_UNLIMITED;
  return num(s);
}

/** Catálogo `upgrades` muda raramente; evita leitura completa a cada tick do WS (por jogador). */
const UPGRADES_CATALOG_CACHE_TTL_FLOOR_SECONDS = 15;
const UPGRADES_CATALOG_CACHE_TTL_CEILING_MINUTES = 10;
const UPGRADES_CATALOG_CACHE_TTL_FLOOR_MS = UPGRADES_CATALOG_CACHE_TTL_FLOOR_SECONDS * MS_PER_SECOND;
const UPGRADES_CATALOG_CACHE_TTL_CEILING_MS = UPGRADES_CATALOG_CACHE_TTL_CEILING_MINUTES * MS_PER_MINUTE;
const UPGRADES_CATALOG_CACHE_TTL_DEFAULT_MS = MS_PER_MINUTE;
const UPGRADES_CATALOG_CACHE_TTL_MS = Math.min(
  UPGRADES_CATALOG_CACHE_TTL_CEILING_MS,
  Math.max(
    UPGRADES_CATALOG_CACHE_TTL_FLOOR_MS,
    parseInt(String(process.env.UPGRADES_SNAPSHOT_CACHE_TTL_MS || String(UPGRADES_CATALOG_CACHE_TTL_DEFAULT_MS)), 10) ||
      UPGRADES_CATALOG_CACHE_TTL_DEFAULT_MS
  )
);

let upgradesCatalogCache: {
  map: Map<string, UpgradeRow>;
  miningMap: Map<string, UpgradeMiningRow>;
  expiresAt: number;
} | null = null;

/** Só para testes (Vitest); invalida cache entre casos. */
export function resetUpgradesCatalogCacheForTests(): void {
  upgradesCatalogCache = null;
  nftMiningRoomIdsCache = null;
  asicMiningRoomIdsCache = null;
}

let nftMiningRoomIdsCache: { ids: Set<string>; expiresAt: number } | null = null;
let asicMiningRoomIdsCache: { ids: Set<string>; expiresAt: number } | null = null;

async function loadNftMiningRoomIds(): Promise<Set<string>> {
  const now = Date.now();
  if (nftMiningRoomIdsCache && nftMiningRoomIdsCache.expiresAt > now) {
    return nftMiningRoomIdsCache.ids;
  }
  const rows = await prisma.rig_rooms.findMany({ select: { id: true, name: true } });
  const ids = new Set<string>();
  const canonical = normalizePlacedRackRoomId(NFT_AUTO_ROOM_ID);
  for (const r of rows) {
    const id = normalizePlacedRackRoomId(r.id);
    if (id === canonical || isNftAutoArmario1OnlyRoomRow(r)) ids.add(id);
  }
  ids.add(canonical);
  nftMiningRoomIdsCache = { ids, expiresAt: now + UPGRADES_CATALOG_CACHE_TTL_MS };
  return ids;
}

async function loadAsicMiningRoomIds(): Promise<Set<string>> {
  const now = Date.now();
  if (asicMiningRoomIdsCache && asicMiningRoomIdsCache.expiresAt > now) {
    return asicMiningRoomIdsCache.ids;
  }
  const rows = await prisma.rig_rooms.findMany({ select: { id: true, name: true } });
  const ids = new Set<string>();
  for (const r of rows) {
    const id = normalizePlacedRackRoomId(r.id);
    if (isAsicMiningRoomId(id, null, r.name)) ids.add(id);
  }
  ids.add(normalizePlacedRackRoomId(ASIC_ROOM_ID));
  asicMiningRoomIdsCache = { ids, expiresAt: now + UPGRADES_CATALOG_CACHE_TTL_MS };
  return ids;
}

async function loadUpgradesCatalogMaps(): Promise<{
  catalog: Map<string, UpgradeRow>;
  mining: Map<string, UpgradeMiningRow>;
}> {
  const now = Date.now();
  if (upgradesCatalogCache && upgradesCatalogCache.expiresAt > now) {
    return { catalog: upgradesCatalogCache.map, mining: upgradesCatalogCache.miningMap };
  }
  const upRows = await prisma.upgrades.findMany({
    select: {
      id: true,
      base_production: true,
      multiplier: true,
      power_capacity: true,
      type: true,
      category: true,
      nft_mining_coin_id: true
    }
  });
  const upgrades = new Map<string, UpgradeRow>();
  const upgradesMining = new Map<string, UpgradeMiningRow>();
  for (const u of upRows) {
    const id = String(u.id);
    const cap = parsePowerCapacity(u.power_capacity);
    upgrades.set(id, {
      base: num(u.base_production),
      mult: num(u.multiplier),
      cap,
      type: String(u.type ?? ''),
      category: u.category != null ? String(u.category) : null,
      nft_mining_coin_id: u.nft_mining_coin_id != null ? String(u.nft_mining_coin_id) : null
    });
    upgradesMining.set(id, {
      id,
      type: u.type,
      category: u.category,
      base_production: u.base_production,
      multiplier: u.multiplier,
      nft_mining_coin_id: u.nft_mining_coin_id
    });
  }
  upgradesCatalogCache = {
    map: upgrades,
    miningMap: upgradesMining,
    expiresAt: now + UPGRADES_CATALOG_CACHE_TTL_MS
  };
  return { catalog: upgrades, mining: upgradesMining };
}

export type PlayerGameHeaderPayload = {
  coinBalances: Record<string, number>;
  usdc: number;
  hashByCoinId: Record<string, number>;
  totalHash: number;
  serverUpdatedAt: number;
  /** Contagens de racks — reutilizadas pelo dashboard (evita 2ª query). */
  rigsTotal: number;
  rigsOnline: number;
  /** H/s × último `yield_per_hash` — ticker local do header. */
  estCoinsPerSecByCoinId: Record<string, number>;
  /** Início do bloco de 10 min UTC já fechado (mesmo grid do yield). */
  liveAccrualAnchorMs: number;
};

/** `coins/s = hashrate × yield_per_hash` (mesmo produto que o progress-computer credita). */
export function estimateCoinsPerSecByCoinId(
  hashByCoinId: Record<string, number>,
  yieldPerHashByCoinId: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [coinId, hashRaw] of Object.entries(hashByCoinId)) {
    const hash = Number(hashRaw);
    const yph = Number(yieldPerHashByCoinId[coinId]);
    if (!Number.isFinite(hash) || hash <= 0 || !Number.isFinite(yph) || yph <= 0) continue;
    out[coinId] = hash * yph;
  }
  return out;
}

type YieldHistLatestRow = { coin_id: string; yield_per_hash: number };

export async function loadLatestYieldPerHashByCoinId(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<YieldHistLatestRow[]>`
    SELECT DISTINCT ON (coin_id)
      coin_id,
      yield_per_hash
    FROM mining_yield_history
    WHERE yield_per_hash > 0
    ORDER BY coin_id, effective_at DESC
  `;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const coinId = String(row.coin_id || '').trim();
    const yph = Number(row.yield_per_hash);
    if (!coinId || !Number.isFinite(yph) || yph <= 0) continue;
    out[coinId] = yph;
  }
  return out;
}

function emptyHeaderPayload(nowMs: number): PlayerGameHeaderPayload {
  return {
    coinBalances: {},
    usdc: 0,
    hashByCoinId: {},
    totalHash: 0,
    serverUpdatedAt: nowMs,
    rigsTotal: 0,
    rigsOnline: 0,
    estCoinsPerSecByCoinId: {},
    liveAccrualAnchorMs: lastCompletedTenMinuteUtcGrid(nowMs)
  };
}

/**
 * Saldos USDC/moedas e hashrate por moeda + total, a partir da BD (alinhado ao cálculo de produção do cliente).
 */
export async function computePlayerGameHeaderSnapshot(userId: number): Promise<PlayerGameHeaderPayload> {
  const gs = await prisma.game_states.findUnique({
    where: { user_id: userId },
    select: { usdc: true, server_updated_at: true, last_checkin_at_ms: true, checkin_bonus_hps: true }
  });
  if (!gs) {
    return emptyHeaderPayload(Date.now());
  }
  const usdc = num(gs.usdc);
  const su = gs.server_updated_at;
  const serverUpdatedAt = su == null ? Date.now() : Number(su) || Date.now();

  const lastCheckinAtMs = gs.last_checkin_at_ms != null ? Number(gs.last_checkin_at_ms) : null;

  const [balRows, { mining: upgradesMining }, checkinFrozen] = await Promise.all([
    prisma.coin_balances.findMany({
      where: { user_id: userId },
      select: { coin_id: true, amount: true }
    }),
    loadUpgradesCatalogMaps(),
    isCheckinFrozenForUser(userId, lastCheckinAtMs, Date.now())
  ]);
  const coinBalances: Record<string, number> = {};
  for (const row of balRows) {
    coinBalances[String(row.coin_id)] = roundMinedCoinAmount(num(row.amount));
  }

  const racksRows = checkinFrozen
    ? []
    : await prisma.placed_racks.findMany({
        where: { user_id: userId },
        select: {
          id: true,
          item_id: true,
          is_on: true,
          wiring_id: true,
          battery_id: true,
          selected_coin_id: true,
          room_id: true
        }
      });

  let rigsOnline = 0;
  for (const r of racksRows) {
    const hasBattery = r.battery_id != null && String(r.battery_id).trim() !== '';
    if (Number(r.is_on) === 1 && hasBattery) rigsOnline += 1;
  }
  const rigsTotal = racksRows.length;

  const rackIds = racksRows.map((r) => String(r.id));
  const slotsMap = new Map<string, string[]>();
  const multiMap = new Map<string, string[]>();
  if (rackIds.length > 0) {
    const [slots, mults] = await Promise.all([
      prisma.rack_slots.findMany({
        where: { rack_id: { in: rackIds } },
        orderBy: [{ rack_id: 'asc' }, { slot_index: 'asc' }],
        select: { rack_id: true, slot_index: true, machine_item_id: true }
      }),
      prisma.rack_multiplier_slots.findMany({
        where: { rack_id: { in: rackIds } },
        orderBy: [{ rack_id: 'asc' }, { slot_index: 'asc' }],
        select: { rack_id: true, slot_index: true, multiplier_item_id: true }
      })
    ]);
    for (const s of slots) {
      const rid = String(s.rack_id);
      if (!slotsMap.has(rid)) slotsMap.set(rid, []);
      const arr = slotsMap.get(rid)!;
      const idx = Math.max(0, Math.floor(num(s.slot_index, 0)));
      while (arr.length <= idx) arr.push('');
      arr[idx] = s.machine_item_id ? String(s.machine_item_id) : '';
    }
    for (const m of mults) {
      const rid = String(m.rack_id);
      if (!multiMap.has(rid)) multiMap.set(rid, []);
      const arr = multiMap.get(rid)!;
      const idx = Math.max(0, Math.floor(num(m.slot_index, 0)));
      while (arr.length <= idx) arr.push('');
      arr[idx] = m.multiplier_item_id ? String(m.multiplier_item_id) : '';
    }
  }

  const [nftRoomIds, asicRoomIds] = await Promise.all([loadNftMiningRoomIds(), loadAsicMiningRoomIds()]);
  const checkinBonusHps = Math.max(0, num(gs.checkin_bonus_hps));
  const hashEntries: Array<{
    coinId: string;
    roomId: string | null;
    baseHps: number;
    countsTowardGeneralPower: boolean;
  }> = [];

  for (const r of racksRows) {
    const isOn = Number(r.is_on) === 1;
    const wiringId = r.wiring_id ? String(r.wiring_id).trim() : '';
    const batteryId = r.battery_id ? String(r.battery_id).trim() : '';

    if (!isOn || !wiringId || !batteryId) continue;

    const rid = String(r.id);
    const slots = slotsMap.get(rid) || [];
    const multSlots = multiMap.get(rid) || [];
    const roomId = r.room_id != null ? String(r.room_id) : null;
    const selectedCoinId = r.selected_coin_id ? String(r.selected_coin_id).trim() : '';
    const credits = listSlotMiningCredits(
      roomId,
      slots,
      multSlots,
      upgradesMining,
      selectedCoinId,
      nftRoomIds,
      r.item_id != null ? String(r.item_id) : null,
      asicRoomIds
    );
    for (const sc of credits) {
      if (!Number.isFinite(sc.effectiveBaseProd) || sc.effectiveBaseProd <= 0) continue;
      hashEntries.push({
        coinId: sc.coinId,
        roomId,
        baseHps: sc.effectiveBaseProd,
        countsTowardGeneralPower: sc.countsTowardGeneralPower === true
      });
    }
  }

  const totalNonNftRigHash = sumNonNftRoomRigHashHps(hashEntries, nftRoomIds, asicRoomIds);
  const aggEntries = hashEntries.map((entry) => {
    const effective = effectiveHashWithCheckinBonus(
      entry.baseHps,
      entry.coinId,
      entry.roomId,
      checkinBonusHps,
      totalNonNftRigHash,
      nftRoomIds,
      asicRoomIds,
      entry.countsTowardGeneralPower
    );
    return {
      coinId: entry.coinId,
      effectiveHps: effective,
      countsTowardGeneralPower: entry.countsTowardGeneralPower
    };
  });
  const { hashByCoinId, totalHash } = aggregateHeaderHash(aggEntries);

  const yieldPerHashByCoinId = await loadLatestYieldPerHashByCoinId();
  return {
    coinBalances,
    usdc,
    hashByCoinId,
    totalHash,
    serverUpdatedAt,
    rigsTotal,
    rigsOnline,
    estCoinsPerSecByCoinId: estimateCoinsPerSecByCoinId(hashByCoinId, yieldPerHashByCoinId),
    liveAccrualAnchorMs: lastCompletedTenMinuteUtcGrid(Date.now())
  };
}
