/**
 * Migrado de legacy/backend/modules/merge/merge.service.ts (verbatim, usando
 * o pool singleton `core/database/pool.js` em vez de `Pool` injetado por deps,
 * e `bumpQuestProgress` importado estaticamente — `modules/quests` já migrou).
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import db from '../../../core/database/pool.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { assertActiveUserPg } from '../../../shared/security/assert-active-user-tx.js';
import { recordInventoryMovement } from '../../../shared/audit/inventory-movement.js';
import { bumpQuestProgress } from '../../quests/services/quest.js';
import { bumpUpgradesCatalogRevision, lockUpgradesCatalogRevision } from '../../catalog/services/catalog-revision.js';
import {
  MERGE_ALLOWED_TYPES,
  MERGE_MAX_COUNT,
  MERGE_RARITY_LABELS,
  MERGE_RESULT_RARITY,
  isAsicMachineForMerge,
  isMergeForbiddenCatalog,
  isMergeableSourceRarity,
  normalizeMergeRarity,
  type MergeAllowedType,
  type MergeRarity
} from './constants.js';
import { anyMergeTypeEnabled, isMergeTypeEnabled, loadMergeSettings, type MergeRuntimeSettings } from './settings.js';
import { computeMergeResultStats, mergeSourceCatalogsEquivalent, statsMatchExisting, type MergeResultStats, type MergeSourceCatalog } from './stats-rust-bridge.js';
import { callMergeExecute, isHardwareMarketError } from '../../hardware/services/hardware-client.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
/** Evita espera indefinida em `FOR UPDATE` (504 no proxy). Unidade: ms. */
const LOCK_TIMEOUT_MS = 45_000;

export class MergeError extends HttpControlledError {
  readonly code: string;

  get httpStatus(): number {
    return this.statusCode;
  }

  constructor(code: string, message: string, httpStatus: number = HTTP_BAD_REQUEST) {
    super(httpStatus, { ok: false, error: message, code });
    this.name = 'MergeError';
    this.code = code;
  }
}

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function isAllowedType(t: string): t is MergeAllowedType {
  return (MERGE_ALLOWED_TYPES as readonly string[]).includes(t);
}

const RESULT_ID_HASH_LENGTH = 10;
const RESULT_ID_SOURCE_MAX_LENGTH = 48;
const RESULT_ID_MAX_LENGTH = 120;

function makeResultCatalogId(sourceId: string, resultRarity: string, stats: MergeResultStats): string {
  const h = createHash('sha1')
    .update([sourceId, resultRarity, String(stats.baseCost), String(stats.baseProduction), String(stats.powerConsumption ?? ''), String(stats.multiplier ?? ''), String(stats.slotsCapacity ?? ''), String(stats.aiSlotsCapacity ?? '')].join('|'))
    .digest('hex')
    .slice(0, RESULT_ID_HASH_LENGTH);
  const safeSrc = String(sourceId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, RESULT_ID_SOURCE_MAX_LENGTH);
  return `merge_${safeSrc}_${resultRarity}_${h}`.slice(0, RESULT_ID_MAX_LENGTH);
}

async function copyUpgradeCompatFromSource(client: PoolClient, resultId: string, sourceId: string): Promise<void> {
  await client.query(
    `INSERT INTO upgrade_compat_racks (upgrade_id, rack_id)
     SELECT $1, c.rack_id
     FROM upgrade_compat_racks c
     WHERE c.upgrade_id = $2
     ON CONFLICT DO NOTHING`,
    [resultId, sourceId]
  );
}

export async function getMergePublicConfig() {
  const settings = await loadMergeSettings();
  const enabledByType = {
    machine: settings.enabledMachine,
    multiplier: settings.enabledMultiplier,
    infrastructure: settings.enabledInfrastructure
  };
  const allowedTypes = MERGE_ALLOWED_TYPES.filter((t) => settings.enabled && isMergeTypeEnabled(settings, t));
  return {
    enabled: settings.enabled && anyMergeTypeEnabled(settings),
    enabledByType,
    gainPercent: settings.gainPercent,
    costPctByRarity: settings.costPctByRarity,
    rackHsBonusPctByRarity: settings.rackHsBonusPctByRarity,
    resultRarityBySource: { ...MERGE_RESULT_RARITY },
    rarities: Object.entries(MERGE_RARITY_LABELS).map(([id, label]) => ({ id, label })),
    allowedTypes
  };
}

function assertMergeEnabled(settings: { enabled: boolean }): void {
  if (!settings.enabled) {
    throw new MergeError('MERGE_DISABLED', 'Merge Station is disabled.', HTTP_FORBIDDEN);
  }
}

function assertMergeTypeEnabled(settings: MergeRuntimeSettings, type: MergeAllowedType): void {
  if (!isMergeTypeEnabled(settings, type)) {
    const label = type === 'machine' ? 'GPUs' : type === 'multiplier' ? 'Chips IA' : 'Rigs';
    throw new MergeError('MERGE_TYPE_DISABLED', `${label} merge is disabled.`, HTTP_FORBIDDEN);
  }
}

export type MergeInventoryItem = {
  itemId: string;
  qty: number;
  name: string;
  type: MergeAllowedType;
  rarity: MergeRarity;
  resultRarity: MergeRarity | null;
  baseCost: number;
  baseProduction: number;
  powerConsumption: number | null;
  multiplier: number | null;
  image: string | null;
  icon: string;
  /** Taxa USDC de 1 merge (1 par). */
  feeUsdc: number;
  /** Quantos merges cabem com o stock atual (floor(qty/2), cap MERGE_MAX_COUNT). */
  maxMerges: number;
  canMerge: boolean;
  blockReason: string | null;
  preview: MergeResultStats | null;
};

const DEFAULT_ICON = '📦';
const MIN_MERGE_QTY = 2;

function inventoryMergePeersEquivalent(a: MergeInventoryItem, b: MergeInventoryItem): boolean {
  if (a.type !== b.type || a.rarity !== b.rarity || a.name !== b.name) return false;
  if (a.baseCost !== b.baseCost || a.baseProduction !== b.baseProduction) return false;
  if ((a.powerConsumption ?? null) !== (b.powerConsumption ?? null)) return false;
  if ((a.multiplier ?? null) !== (b.multiplier ?? null)) return false;
  return true;
}

/** Agrega SKUs duplicados (mesmo nome/stats) — legado criou vários merge_* com qty=1 cada. */
function groupMergeInventoryItems(items: MergeInventoryItem[]): MergeInventoryItem[] {
  const grouped: MergeInventoryItem[] = [];
  for (const item of items) {
    const idx = grouped.findIndex((g) => inventoryMergePeersEquivalent(g, item));
    if (idx < 0) {
      grouped.push({ ...item });
      continue;
    }
    const g = grouped[idx];
    const qty = g.qty + item.qty;
    const maxMerges = Math.min(MERGE_MAX_COUNT, Math.floor(qty / MIN_MERGE_QTY));
    const preview = g.preview ?? item.preview;
    const canMerge = qty >= MIN_MERGE_QTY && isMergeableSourceRarity(g.rarity) && preview != null;
    let blockReason: string | null = null;
    if (!canMerge) {
      if (qty < MIN_MERGE_QTY) blockReason = 'Precisas de 2 unidades iguais no stock.';
      else if (!isMergeableSourceRarity(g.rarity)) blockReason = 'Supreme não pode ser mergeado.';
      else blockReason = g.blockReason ?? item.blockReason ?? 'Item não mergeável.';
    }
    grouped[idx] = {
      ...g,
      itemId: g.qty >= item.qty ? g.itemId : item.itemId,
      qty,
      maxMerges,
      canMerge,
      blockReason,
      preview
    };
  }
  return grouped;
}

type MergeStockLot = { itemId: string; qty: number };
type MergeConsumedLot = { itemId: string; before: number; after: number };
type MergeConsumePlan = {
  consumedLots: MergeConsumedLot[];
  debits: Array<{ itemId: string; qty: number }>;
};

function planMergeConsume(lots: MergeStockLot[], needQty: number): MergeConsumePlan {
  let remaining = needQty;
  let totalBefore = 0;
  const consumedLots: MergeConsumedLot[] = [];
  const debits: Array<{ itemId: string; qty: number }> = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    if (take <= 0) continue;
    totalBefore += take;
    remaining -= take;
    const after = lot.qty - take;
    const afterQty = Math.max(0, after);
    consumedLots.push({ itemId: lot.itemId, before: lot.qty, after: afterQty });
    debits.push({ itemId: lot.itemId, qty: lot.qty - afterQty });
  }
  if (remaining > 0) {
    const maxOk = Math.floor(totalBefore / MIN_MERGE_QTY);
    throw new MergeError(
      'INSUFFICIENT_STOCK',
      maxOk > 0
        ? `Insufficient stock for ${Math.ceil(needQty / MIN_MERGE_QTY)} merge(s). Maximum now: ${maxOk}.`
        : 'You need at least 2 identical units in stock.'
    );
  }
  return { consumedLots, debits };
}

async function listEquivalentMergeStockLots(
  client: PoolClient,
  userId: number,
  source: MergeSourceCatalog,
  opts?: { forUpdate?: boolean }
): Promise<MergeStockLot[]> {
  const lockClause = opts?.forUpdate === false ? '' : '\n     FOR UPDATE';
  const res = await client.query<{ item_id: string; qty: number; type: string; category: string; name: string; rarity: string; base_cost: number; base_production: number; power_consumption: number | null; multiplier: number | null; slots_capacity: number | null; ai_slots_capacity: number | null; description: string; icon: string; image: string | null; status: string; is_nft: number | null }>(
    `SELECT s.item_id, s.qty, u.type, u.category, u.name, COALESCE(u.rarity, 'common') AS rarity,
            u.base_cost, u.base_production, u.power_consumption, u.multiplier,
            u.slots_capacity, u.ai_slots_capacity, u.description, u.icon, u.image, u.status,
            COALESCE(u.is_nft, 0) AS is_nft
     FROM stock s
     INNER JOIN upgrades u ON u.id = s.item_id
     WHERE s.user_id = $1
       AND s.qty > 0
       AND u.type = $2
       AND COALESCE(u.rarity, 'common') = $3
       AND u.name = $4
     ORDER BY s.item_id ASC${lockClause}`,
    [userId, source.type, normalizeMergeRarity(source.rarity), source.name]
  );
  const lots: MergeStockLot[] = [];
  for (const row of res.rows) {
    if (isMergeForbiddenCatalog({ id: row.item_id, is_nft: row.is_nft, category: row.category, type: row.type })) continue;
    if (isAsicMachineForMerge(row.item_id, row.category, row.type)) continue;
    const peer: MergeSourceCatalog = {
      id: row.item_id,
      name: row.name,
      category: row.category,
      type: row.type,
      rarity: normalizeMergeRarity(row.rarity),
      base_cost: Number(row.base_cost) || 0,
      base_production: Number(row.base_production) || 0,
      power_consumption: row.power_consumption == null ? null : Number(row.power_consumption),
      multiplier: row.multiplier == null ? null : Number(row.multiplier),
      slots_capacity: row.slots_capacity == null ? null : Number(row.slots_capacity),
      ai_slots_capacity: row.ai_slots_capacity == null ? null : Number(row.ai_slots_capacity),
      description: row.description ?? '',
      icon: row.icon ?? DEFAULT_ICON,
      image: row.image,
      status: row.status ?? 'normal'
    };
    if (!mergeSourceCatalogsEquivalent(source, peer)) continue;
    lots.push({ itemId: row.item_id, qty: Math.max(0, Math.floor(Number(row.qty) || 0)) });
  }
  return lots;
}

export async function listMergeInventory(userId: number): Promise<MergeInventoryItem[]> {
  const settings = await loadMergeSettings();
  assertMergeEnabled(settings);
  const activeTypes = MERGE_ALLOWED_TYPES.filter((t) => isMergeTypeEnabled(settings, t));
  if (activeTypes.length === 0) return [];
  const res = await db.query<{
    item_id: string;
    qty: number;
    name: string;
    type: string;
    category: string;
    rarity: string;
    base_cost: number;
    base_production: number;
    power_consumption: number | null;
    multiplier: number | null;
    slots_capacity: number | null;
    ai_slots_capacity: number | null;
    image: string | null;
    icon: string;
    is_nft: number | null;
  }>(
    `SELECT s.item_id, s.qty, u.name, u.type, u.category, COALESCE(u.rarity, 'common') AS rarity,
            u.base_cost, u.base_production, u.power_consumption, u.multiplier,
            u.slots_capacity, u.ai_slots_capacity, u.image, u.icon, COALESCE(u.is_nft, 0) AS is_nft
     FROM stock s
     INNER JOIN upgrades u ON u.id = s.item_id
     WHERE s.user_id = $1
       AND s.qty > 0
       AND u.type = ANY($2::text[])
     ORDER BY u.type ASC, u.name ASC`,
    [userId, [...activeTypes]]
  );

  const out: MergeInventoryItem[] = [];
  for (const row of res.rows) {
    const type = row.type;
    if (!isAllowedType(type)) continue;
    if (!isMergeTypeEnabled(settings, type)) continue;
    if (isMergeForbiddenCatalog({ id: row.item_id, is_nft: row.is_nft, category: row.category, type })) continue;
    if (isAsicMachineForMerge(row.item_id, row.category, type)) continue;

    const rarity = normalizeMergeRarity(row.rarity);
    const catalog: MergeSourceCatalog = {
      id: row.item_id,
      name: row.name,
      category: row.category,
      type,
      rarity,
      base_cost: Number(row.base_cost) || 0,
      base_production: Number(row.base_production) || 0,
      power_consumption: row.power_consumption == null ? null : Number(row.power_consumption),
      multiplier: row.multiplier == null ? null : Number(row.multiplier),
      slots_capacity: row.slots_capacity == null ? null : Number(row.slots_capacity),
      ai_slots_capacity: row.ai_slots_capacity == null ? null : Number(row.ai_slots_capacity),
      description: '',
      icon: row.icon || DEFAULT_ICON,
      image: row.image,
      status: 'normal'
    };
    const preview = computeMergeResultStats(catalog, settings);
    const qty = Math.max(0, Math.floor(Number(row.qty) || 0));
    const maxMerges = Math.min(MERGE_MAX_COUNT, Math.floor(qty / MIN_MERGE_QTY));
    let canMerge = true;
    let blockReason: string | null = null;
    if (qty < MIN_MERGE_QTY) {
      canMerge = false;
      blockReason = 'Precisas de 2 unidades iguais no stock.';
    } else if (!isMergeableSourceRarity(rarity)) {
      canMerge = false;
      blockReason = 'Supreme não pode ser mergeado.';
    } else if (!preview) {
      canMerge = false;
      blockReason = 'Item não mergeável.';
    }

    out.push({
      itemId: row.item_id,
      qty,
      name: row.name,
      type,
      rarity,
      resultRarity: preview?.resultRarity ?? null,
      baseCost: Number(row.base_cost) || 0,
      baseProduction: Number(row.base_production) || 0,
      powerConsumption: row.power_consumption == null ? null : Number(row.power_consumption),
      multiplier: row.multiplier == null ? null : Number(row.multiplier),
      image: row.image,
      icon: row.icon || DEFAULT_ICON,
      feeUsdc: preview?.feeUsdc ?? 0,
      maxMerges,
      canMerge,
      blockReason,
      preview
    });
  }
  return groupMergeInventoryItems(out);
}

async function resolveOrCreateResultUpgrade(client: PoolClient, source: MergeSourceCatalog, stats: MergeResultStats): Promise<string> {
  const existing = await client.query<{
    id: string;
    base_cost: number;
    base_production: number;
    power_consumption: number | null;
    multiplier: number | null;
    slots_capacity: number | null;
    ai_slots_capacity: number | null;
  }>(
    `SELECT id, base_cost, base_production, power_consumption, multiplier, slots_capacity, ai_slots_capacity
     FROM upgrades
     WHERE type = $1 AND COALESCE(rarity, 'common') = $2 AND name = $3`,
    [source.type, stats.resultRarity, stats.name]
  );
  for (const row of existing.rows) {
    if (statsMatchExisting(row, stats, source.type)) {
      await copyUpgradeCompatFromSource(client, row.id, source.id);
      return row.id;
    }
  }

  const id = makeResultCatalogId(source.id, stats.resultRarity, stats);
  const dup = await client.query<{ id: string }>('SELECT id FROM upgrades WHERE id = $1', [id]);
  if (dup.rows[0]) {
    await copyUpgradeCompatFromSource(client, dup.rows[0].id, source.id);
    return dup.rows[0].id;
  }

  const category = source.category || (source.type === 'multiplier' ? 'chip_ia' : source.type === 'infrastructure' ? 'rig' : 'gpu');
  const HS_PERCENT_ROUND = 10000;
  const HS_PERCENT_DISPLAY_ROUND = 100;
  const desc =
    source.type === 'infrastructure'
      ? `Resultado de merge (${stats.resultRarity}): +${Math.round((stats.multiplier || 0) * HS_PERCENT_ROUND) / HS_PERCENT_DISPLAY_ROUND}% H/s.`
      : `Resultado de merge (${stats.resultRarity}, +${stats.gainPercent}%).`;

  // Lock revision antes do INSERT (mesma ordem que replaceShopUpgrades).
  await lockUpgradesCatalogRevision(client);

  const ins = await client.query(
    `INSERT INTO upgrades (
       id, name, category, type, base_cost, base_production, power_consumption, power_capacity,
       multiplier, slots_capacity, ai_slots_capacity, description, icon, status, is_nft,
       image, reward_wh, sell_in_hardware_market, sell_in_black_market, is_active, rarity
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,0,$14,0,0,0,1,$15
     )
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, stats.name, category, source.type, stats.baseCost, stats.baseProduction, stats.powerConsumption, stats.multiplier, stats.slotsCapacity, stats.aiSlotsCapacity, desc, source.icon || DEFAULT_ICON, source.status || 'normal', source.image, stats.resultRarity]
  );

  if ((ins.rowCount ?? 0) > 0) {
    await bumpUpgradesCatalogRevision(client);
  }

  // Herda compatibilidade do source (GPU/chip): se encaixa na rig base, encaixa no merge.
  await copyUpgradeCompatFromSource(client, id, source.id);

  return id;
}

export type MergeExecuteResult = {
  ok: true;
  sourceItemId: string;
  resultItemId: string;
  sourceRarity: MergeRarity;
  resultRarity: MergeRarity;
  /** Taxa total cobrada (feeUnit × count). */
  feeUsdc: number;
  feeUnitUsdc: number;
  count: number;
  newUsdc: number;
  resultQty: number;
  sourceQty: number;
  result: MergeResultStats & { id: string; name: string };
};

const FEE_ROUND_FACTOR = 100;
const USDC_EPSILON = 1e-9;

export async function executeMerge(userId: number, sourceItemId: string, countInput: number = 1): Promise<MergeExecuteResult> {
  const itemId = String(sourceItemId || '').trim();
  if (!itemId) throw new MergeError('BAD_ITEM', 'Invalid item.');
  const count = Math.max(1, Math.min(MERGE_MAX_COUNT, Math.floor(Number(countInput) || 1)));
  const needQty = count * MIN_MERGE_QTY;

  return withClient(async (client) => {
    let source: MergeSourceCatalog & { is_nft?: number | null };
    let rarity: MergeRarity;
    let stats: MergeResultStats;
    let feeUnit: number;
    let feeTotal: number;
    let qtyBefore: number;
    let qtyAfterSource: number;
    let plan: ReturnType<typeof planMergeConsume>;
    let consumedLots: ReturnType<typeof planMergeConsume>['consumedLots'];

    // Phase 1 — validation reads only; ROLLBACK so we never COMMIT a TX then HTTP.
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await assertActiveUserPg(client, userId);
      const settings = await loadMergeSettings();
      assertMergeEnabled(settings);
      const catRes = await client.query<MergeSourceCatalog & { is_nft?: number | null }>(
        `SELECT id, name, category, type, COALESCE(rarity, 'common') AS rarity,
                base_cost, base_production, power_consumption, multiplier,
                slots_capacity, ai_slots_capacity,
                description, icon, image, status, COALESCE(is_nft, 0) AS is_nft
         FROM upgrades WHERE id = $1 FOR SHARE`,
        [itemId]
      );
      const sourceRow = catRes.rows[0];
      if (!sourceRow) throw new MergeError('NOT_FOUND', 'Catalog item not found.', HTTP_NOT_FOUND);
      if (!isAllowedType(sourceRow.type)) {
        throw new MergeError('BAD_TYPE', 'Only GPUs, AI Chips, and Rigs can be merged.');
      }
      assertMergeTypeEnabled(settings, sourceRow.type);
      if (isMergeForbiddenCatalog({ id: sourceRow.id, is_nft: sourceRow.is_nft, category: sourceRow.category, type: sourceRow.type })) {
        throw new MergeError('ITEM_FORBIDDEN', 'This item (NFT / Free-to-Play / special) cannot be merged.', HTTP_FORBIDDEN);
      }
      if (isAsicMachineForMerge(sourceRow.id, sourceRow.category, sourceRow.type)) {
        throw new MergeError('ASIC_FORBIDDEN', 'ASICs cannot be merged.');
      }

      rarity = normalizeMergeRarity(sourceRow.rarity);
      sourceRow.rarity = rarity;
      if (!isMergeableSourceRarity(rarity)) {
        throw new MergeError('SUPREME', 'Supreme items cannot be merged.');
      }

      const computed = computeMergeResultStats(sourceRow, settings);
      if (!computed) throw new MergeError('BAD_STATS', 'Could not calculate the result.');
      stats = computed;
      source = sourceRow;

      feeUnit = stats.feeUsdc;
      feeTotal = Math.round(feeUnit * count * FEE_ROUND_FACTOR) / FEE_ROUND_FACTOR;

      const stockLots = await listEquivalentMergeStockLots(client, userId, source, {
        forUpdate: false
      });
      qtyBefore = stockLots.reduce((sum, lot) => sum + lot.qty, 0);
      if (qtyBefore < needQty) {
        const maxOk = Math.floor(qtyBefore / MIN_MERGE_QTY);
        throw new MergeError('INSUFFICIENT_STOCK', maxOk > 0 ? `Insufficient stock for ${count} merge(s). Maximum now: ${maxOk}.` : 'You need at least 2 identical units in stock.');
      }

      const gsRes = await client.query<{ usdc: number }>(`SELECT usdc FROM game_states WHERE user_id = $1`, [userId]);
      if (!gsRes.rows[0]) throw new MergeError('NO_STATE', 'Game state not found.', HTTP_NOT_FOUND);
      const usdcBefore = Number(gsRes.rows[0].usdc) || 0;
      if (usdcBefore + USDC_EPSILON < feeTotal) {
        throw new MergeError('INSUFFICIENT_USDC', `Insufficient USDC. Total fee: ${feeTotal.toFixed(2)} (${count}× ${feeUnit.toFixed(2)}).`);
      }

      qtyAfterSource = qtyBefore - needQty;
      plan = planMergeConsume(stockLots, needQty);
      consumedLots = plan.consumedLots;

      await client.query('ROLLBACK');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }

    // Phase 2 — catalog ensure in its own short TX (orphan upgrade OK if money TX fails later).
    let resultId: string;
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      resultId = await resolveOrCreateResultUpgrade(client, source, stats);
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }

    // Phase 3 — worker owns USDC + adjust + merge_history atomically (no open Node TX).
    const now = Date.now();
    const mergeHistoryTimestamps = Array.from({ length: count }, (_, i) => now + i);
    let exec;
    try {
      exec = await callMergeExecute({
        userId,
        sourceItemId: itemId,
        resultItemId: resultId,
        sourceRarity: rarity,
        resultRarity: stats.resultRarity,
        feeUnitUsdc: feeUnit,
        count,
        debit: plan.debits,
        credit: [{ itemId: resultId, qty: count }],
        historyTimestamps: mergeHistoryTimestamps
      });
    } catch (error) {
      if (isHardwareMarketError(error)) {
        const code = typeof error.jsonBody.code === 'string' ? error.jsonBody.code : 'MERGE_WORKER';
        const msg = typeof error.jsonBody.error === 'string' ? error.jsonBody.error : error.message;
        if (code === 'INSUFFICIENT_STOCK') {
          const maxOk = Math.floor(qtyBefore / MIN_MERGE_QTY);
          throw new MergeError(
            'INSUFFICIENT_STOCK',
            maxOk > 0 ? `Insufficient stock for ${count} merge(s). Maximum now: ${maxOk}.` : 'You need at least 2 identical units in stock.'
          );
        }
        throw new MergeError(code, msg, error.statusCode);
      }
      if (error instanceof Error && error.message.startsWith('INSUFFICIENT_STOCK')) {
        const maxOk = Math.floor(qtyBefore / MIN_MERGE_QTY);
        throw new MergeError('INSUFFICIENT_STOCK', maxOk > 0 ? `Insufficient stock for ${count} merge(s). Maximum now: ${maxOk}.` : 'You need at least 2 identical units in stock.');
      }
      throw error;
    }

    const rawAfter = exec.stock?.[resultId];
    const resultAfter =
      typeof exec.resultQty === 'number' && Number.isFinite(exec.resultQty)
        ? exec.resultQty
        : typeof rawAfter === 'number' && Number.isFinite(rawAfter)
          ? rawAfter
          : count;
    const resultBefore = Math.max(0, resultAfter - count);
    const usdcAfter = exec.newUsdc;

    void recordInventoryMovement({
      userId,
      action: 'merge_craft',
      catalogItemId: resultId,
      quantityBefore: resultBefore,
      quantityAfter: resultAfter,
      meta: { sourceItemId: itemId, sourceRarity: rarity, resultRarity: stats.resultRarity, feeUsdc: feeTotal, feeUnitUsdc: feeUnit, gainPercent: stats.gainPercent, consumed: needQty, count }
    });
    for (const lot of consumedLots) {
      void recordInventoryMovement({
        userId,
        action: 'merge_consume',
        catalogItemId: lot.itemId,
        quantityBefore: lot.before,
        quantityAfter: lot.after,
        meta: { resultItemId: resultId, feeUsdc: feeTotal, count, consumedFromLot: lot.before - lot.after, primaryItemId: itemId }
      });
    }

    void bumpQuestProgress(userId, 'merge', count);

    return {
      ok: true,
      sourceItemId: itemId,
      resultItemId: resultId,
      sourceRarity: rarity,
      resultRarity: stats.resultRarity,
      feeUsdc: feeTotal,
      feeUnitUsdc: feeUnit,
      count,
      newUsdc: usdcAfter,
      resultQty: resultAfter,
      sourceQty: Math.max(0, qtyAfterSource),
      result: { ...stats, id: resultId, name: stats.name }
    };
  });
}

export type MergeHistorySummaryRow = {
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  mergeCount: number;
  feeTotalUsdc: number;
  lastAt: number;
};

export type MergeHistoryEntry = {
  id: string;
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  feeUsdc: number;
  createdAt: number;
};

function toMs(raw: unknown): number {
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const HISTORY_RECENT_LIMIT_MAX = 100;
const HISTORY_RECENT_LIMIT_DEFAULT = 40;

/** Histórico do jogador — não depende do kill-switch. */
export async function listMergeHistory(
  userId: number,
  opts?: { recentLimit?: number }
): Promise<{
  totalMerges: number;
  feeTotalUsdc: number;
  summary: MergeHistorySummaryRow[];
  recent: MergeHistoryEntry[];
}> {
  const recentLimit = Math.min(HISTORY_RECENT_LIMIT_MAX, Math.max(1, Math.floor(opts?.recentLimit ?? HISTORY_RECENT_LIMIT_DEFAULT)));

  const [totalsRes, summaryRes, recentRes] = await Promise.all([
    db.query<{ total: string; fee_total: number | string | null }>(`SELECT COUNT(*)::text AS total, COALESCE(SUM(fee_usdc), 0) AS fee_total FROM merge_history WHERE user_id = $1`, [userId]),
    db.query<{
      source_item_id: string;
      source_rarity: string;
      result_item_id: string;
      result_rarity: string;
      merge_count: number | string;
      fee_total: number | string | null;
      last_at: string | number | bigint;
      source_name: string | null;
      result_name: string | null;
      source_image: string | null;
      source_icon: string | null;
      source_type: string | null;
    }>(
      `SELECT h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity,
              COUNT(*)::int AS merge_count,
              COALESCE(SUM(h.fee_usdc), 0) AS fee_total,
              MAX(h.created_at) AS last_at,
              MAX(us.name) AS source_name,
              MAX(ur.name) AS result_name,
              MAX(us.image) AS source_image,
              MAX(us.icon) AS source_icon,
              MAX(us.type) AS source_type
       FROM merge_history h
       LEFT JOIN upgrades us ON us.id = h.source_item_id
       LEFT JOIN upgrades ur ON ur.id = h.result_item_id
       WHERE h.user_id = $1
       GROUP BY h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity
       ORDER BY MAX(h.created_at) DESC`,
      [userId]
    ),
    db.query<{
      id: string | number | bigint;
      source_item_id: string;
      source_rarity: string;
      result_item_id: string;
      result_rarity: string;
      fee_usdc: number | string | null;
      created_at: string | number | bigint;
      source_name: string | null;
      result_name: string | null;
      source_image: string | null;
      source_icon: string | null;
      source_type: string | null;
    }>(
      `SELECT h.id, h.source_item_id, h.source_rarity, h.result_item_id, h.result_rarity,
              h.fee_usdc, h.created_at,
              us.name AS source_name, ur.name AS result_name,
              us.image AS source_image, us.icon AS source_icon, us.type AS source_type
       FROM merge_history h
       LEFT JOIN upgrades us ON us.id = h.source_item_id
       LEFT JOIN upgrades ur ON ur.id = h.result_item_id
       WHERE h.user_id = $1
       ORDER BY h.created_at DESC
       LIMIT $2`,
      [userId, recentLimit]
    )
  ]);

  const FEE_TOTAL_ROUND_FACTOR = 100;
  const totalMerges = Math.max(0, Math.floor(Number(totalsRes.rows[0]?.total) || 0));
  const feeTotalUsdc = Math.round((Number(totalsRes.rows[0]?.fee_total) || 0) * FEE_TOTAL_ROUND_FACTOR) / FEE_TOTAL_ROUND_FACTOR;

  const summary: MergeHistorySummaryRow[] = summaryRes.rows.map((r) => ({
    sourceItemId: r.source_item_id,
    sourceName: r.source_name || r.source_item_id,
    sourceRarity: normalizeMergeRarity(r.source_rarity),
    resultItemId: r.result_item_id,
    resultName: r.result_name || r.result_item_id,
    resultRarity: normalizeMergeRarity(r.result_rarity),
    type: r.source_type,
    icon: r.source_icon || DEFAULT_ICON,
    image: r.source_image,
    mergeCount: Math.max(0, Math.floor(Number(r.merge_count) || 0)),
    feeTotalUsdc: Math.round((Number(r.fee_total) || 0) * FEE_TOTAL_ROUND_FACTOR) / FEE_TOTAL_ROUND_FACTOR,
    lastAt: toMs(r.last_at)
  }));

  const recent: MergeHistoryEntry[] = recentRes.rows.map((r) => ({
    id: String(r.id),
    sourceItemId: r.source_item_id,
    sourceName: r.source_name || r.source_item_id,
    sourceRarity: normalizeMergeRarity(r.source_rarity),
    resultItemId: r.result_item_id,
    resultName: r.result_name || r.result_item_id,
    resultRarity: normalizeMergeRarity(r.result_rarity),
    type: r.source_type,
    icon: r.source_icon || DEFAULT_ICON,
    image: r.source_image,
    feeUsdc: Math.round((Number(r.fee_usdc) || 0) * FEE_TOTAL_ROUND_FACTOR) / FEE_TOTAL_ROUND_FACTOR,
    createdAt: toMs(r.created_at)
  }));

  return { totalMerges, feeTotalUsdc, summary, recent };
}
