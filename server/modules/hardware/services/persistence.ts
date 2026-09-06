/**
 * Load/persist stock, stored batteries e placed racks (com slots) para ações de sala.
 * Espelha os blocos relevantes do save-game/game-state.
 *
 * Sistema de carregamento descontinuado em `20260516180000_battery_uuids_and_purge_charging`:
 * já não há `current_charge`/`power_capacity_wh` em `stored_batteries` nem
 * `current_charge`/`battery_power_capacity_wh` em `placed_racks`; cada bateria tem UUID
 * próprio e é infinita.
 *
 * Migrado de legacy/backend/lib/serverRoomPersistence.ts, verbatim.
 */
import type { PoolClient } from 'pg';
import { syncStoredBatterySemanticsForUser } from './semantic-sync.js';
import { PG_BATTERY_INSTANCE_UUID } from './invariant.js';
import { normalizePlacedRackRoomId } from './validation.js';
import { validateStoredBatteryWarehouseRemovalAllowed, sanitizeStoredBatteriesForSavePayload, StoredBatterySaveGuardError } from './save-guard.js';
import { deleteWarehouseStoredBatteriesExceptKeepIds } from './warehouse-delete.js';
import {
  buildRackBatteryPersistSnapshot,
  collectMountedBatteryInstanceIdsFromPlacedRacks,
  fetchBatteryUpgradeRowsByIds,
  isRackBatteryInstanceUuid,
  loadStoredBatteryRowsForIds,
  loadUserStoredBatteries,
  type PrevPlacedRackBattRow,
  type StoredBatteryRowSnap
} from './repository.js';
import { normalizeKnown1000WhBatteryCatalogId } from './catalog.js';
import { reconcileTimedAsicStockLeases, releaseAllEquippedLeasesOnRack, loadAsicDurationConfig, isTimedAsicDuration } from '../../mining-engine/services/asic-lease.js';

export { loadUserStoredBatteries, normalizePlacedRackRoomId };

const BATTERY_DISPLAY_NAME_MAX_LEN = 500;
const BATTERY_IMAGE_URL_MAX_LEN = 2048;

/** Carrega o stock livre (não-instância) do jogador, agregando por item_id normalizado e sobrepondo qty autoritativa de ASICs com lease temporizado. */
export async function loadUserStock(client: PoolClient, uid: number | string): Promise<Record<string, number>> {
  const stockRes = await client.query('SELECT item_id, qty FROM stock WHERE user_id = $1', [uid]);
  const stock: Record<string, number> = {};
  stockRes.rows.forEach((r: { item_id: string; qty: number }) => {
    const itemId = normalizeKnown1000WhBatteryCatalogId(r.item_id);
    stock[itemId] = (stock[itemId] || 0) + (Number(r.qty) || 0);
  });
  // ASICs com validade: qty autoritativa = leases em status `stock`.
  // Cobre stock fantasma (ex.: revert de merge que só mexeu na tabela stock).
  await overlayTimedLeaseStockCounts(client, uid, stock);
  return stock;
}

export type PlacedRackLoaded = {
  id: string;
  itemId: string;
  slots: string[];
  /** UUID de `player_asic_leases` por slot de GPU (paralelo a `slots`). */
  slotLeaseIds?: string[];
  multiplierSlots: string[];
  wiringId: string | null;
  batteryId: string | null;
  isOn: boolean;
  selectedCoinId: string | null;
  roomId: string;
  slotIndex: number;
  /** Snapshot BD: catálogo da bateria montada (UI). */
  batteryCatalogItemId?: string | null;
  batteryDisplayName?: string | null;
  batteryImageUrl?: string | null;
};

/** Carrega todas as rigs montadas do jogador com os respetivos slots de máquina e de multiplicador (joins em memória, uma query por tabela). */
export async function loadUserPlacedRacksWithSlots(client: PoolClient, uid: number | string): Promise<PlacedRackLoaded[]> {
  const placedRacksRes = await client.query('SELECT * FROM placed_racks WHERE user_id = $1', [uid]);
  const rackRows = placedRacksRes.rows as Record<string, unknown>[];
  if (rackRows.length === 0) return [];

  const rackIds = rackRows.map((r) => String(r.id));
  const [slotsRes, multipliersRes] = await Promise.all([
    client.query('SELECT rack_id, slot_index, machine_item_id, machine_lease_id FROM rack_slots WHERE rack_id = ANY($1) ORDER BY slot_index', [rackIds]),
    client.query('SELECT rack_id, slot_index, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1) ORDER BY slot_index', [rackIds])
  ]);

  const slotsMap = new Map<string, string[]>();
  const slotLeaseMap = new Map<string, string[]>();
  const multipliersMap = new Map<string, string[]>();

  slotsRes.rows.forEach((s: { rack_id: string; slot_index: number; machine_item_id: string | null; machine_lease_id?: string | null }) => {
    if (!slotsMap.has(s.rack_id)) {
      slotsMap.set(s.rack_id, []);
      slotLeaseMap.set(s.rack_id, []);
    }
    const arr = slotsMap.get(s.rack_id)!;
    const leaseArr = slotLeaseMap.get(s.rack_id)!;
    arr[s.slot_index] = s.machine_item_id != null ? String(s.machine_item_id) : '';
    leaseArr[s.slot_index] = s.machine_lease_id != null && String(s.machine_lease_id).trim() ? String(s.machine_lease_id).trim() : '';
  });

  multipliersRes.rows.forEach((m: { rack_id: string; slot_index: number; multiplier_item_id: string }) => {
    if (!multipliersMap.has(m.rack_id)) multipliersMap.set(m.rack_id, []);
    const arr = multipliersMap.get(m.rack_id)!;
    arr[m.slot_index] = m.multiplier_item_id;
  });

  const placedRacks: PlacedRackLoaded[] = [];
  for (const r of rackRows) {
    const id = String(r.id);
    placedRacks.push({
      id,
      itemId: String(r.item_id ?? ''),
      slots: slotsMap.get(id) || [],
      slotLeaseIds: slotLeaseMap.get(id) || [],
      multiplierSlots: multipliersMap.get(id) || [],
      wiringId: (r.wiring_id as string | null) ?? null,
      batteryId: (r.battery_id as string | null) ?? null,
      isOn: !!r.is_on,
      selectedCoinId: (r.selected_coin_id as string | null) ?? null,
      roomId: normalizePlacedRackRoomId(r.room_id),
      slotIndex: Number(r.slot_index) || 0,
      batteryCatalogItemId: (r.battery_catalog_item_id as string | null) ?? null,
      batteryDisplayName: (r.battery_display_name as string | null) ?? null,
      batteryImageUrl: (r.battery_image_url as string | null) ?? null
    });
  }
  return placedRacks;
}

export type UpgradeWithCompat = {
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
  compatibleRacks: string[];
  /** 0 = inativo no catálogo (não colocar nova rig). */
  isActive?: number;
  nftMiningCoinId?: string | null;
  asicDurationKind?: string | null;
  asicDurationAmount?: number;
  asicDurationUnit?: string | null;
  rackRoomAffinity?: string | null;
};

/** Carrega o catálogo de upgrades inteiro com a lista de chassis compatíveis anexada a cada item. */
export async function loadUpgradesWithCompat(client: PoolClient): Promise<UpgradeWithCompat[]> {
  const rowsRes = await client.query('SELECT * FROM upgrades');
  const compatRowsRes = await client.query('SELECT * FROM upgrade_compat_racks');
  const compatMap = compatRowsRes.rows.reduce<Record<string, string[]>>((acc, r: { upgrade_id: string; rack_id: string }) => {
    acc[r.upgrade_id] = acc[r.upgrade_id] || [];
    acc[r.upgrade_id].push(r.rack_id);
    return acc;
  }, {});
  return (rowsRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    category: String(r.category ?? ''),
    type: String(r.type ?? ''),
    isActive: r.is_active == null ? 1 : Number(r.is_active),
    baseCost: Number(r.base_cost) || 0,
    baseProduction: Number(r.base_production) || 0,
    powerConsumption: r.power_consumption != null ? Number(r.power_consumption) : undefined,
    powerCapacity: r.power_capacity != null ? Number(r.power_capacity) : undefined,
    multiplier: r.multiplier != null ? Number(r.multiplier) : undefined,
    slotsCapacity: r.slots_capacity != null ? Number(r.slots_capacity) : undefined,
    aiSlotsCapacity: r.ai_slots_capacity != null ? Number(r.ai_slots_capacity) : undefined,
    description: String(r.description ?? ''),
    icon: String(r.icon ?? ''),
    status: String(r.status ?? ''),
    compatibleRacks: compatMap[String(r.id)] || [],
    nftMiningCoinId: r.nft_mining_coin_id != null && String(r.nft_mining_coin_id).trim() ? String(r.nft_mining_coin_id).trim() : null,
    asicDurationKind: r.asic_duration_kind != null && String(r.asic_duration_kind).trim() ? String(r.asic_duration_kind).trim() : 'none',
    asicDurationAmount: Math.max(0, Math.floor(Number(r.asic_duration_amount) || 0)),
    asicDurationUnit: r.asic_duration_unit != null && String(r.asic_duration_unit).trim() ? String(r.asic_duration_unit).trim() : null,
    rackRoomAffinity:
      r.rack_room_affinity != null && String(r.rack_room_affinity).trim()
        ? String(r.rack_room_affinity).trim()
        : null
  }));
}

export type GameStateChanges = {
  stock?: Record<string, number>;
  storedBatteries?: Array<{ id: string; itemId: string; displayName?: string | null; imageUrl?: string | null }>;
  placedRacks?: PlacedRackLoaded[];
  /**
   * Como interpretar `stock` na persistência:
   * - `'snapshot'`: o objeto representa o estoque livre completo do utilizador; linhas em
   *   `stock` ausentes do snapshot são apagadas (corrige duplicação infinita quando um item
   *   chega a qty 0 ao equipar no rack).
   * - `'merge'`: UPSERT only — **nunca** `DELETE FROM stock WHERE NOT (item_id = ANY(...))`
   *   (fecha wipe Grangeiro: SKUs omitidos do payload ficam).
   * - `'partial'` (default): comportamento legado — apenas UPSERT das chaves presentes.
   */
  stockMode?: 'snapshot' | 'partial' | 'merge';
};

export type ActivityLogEntry = { action: string; meta: Record<string, unknown> };

async function ensureStoredBatteriesInChanges(client: PoolClient, uid: number | string, changes: GameStateChanges): Promise<void> {
  if (Array.isArray(changes.storedBatteries)) return;
  changes.storedBatteries = await loadUserStoredBatteries(client, uid);
}

/**
 * Libertar leases de rigs removidas no payload antes de reconciliar stock (evita apagar timed).
 * @returns ids das rigs removidas em relação à BD
 */
async function releaseLeasesForRemovedPlacedRacks(client: PoolClient, uid: number | string, placedRacks: NonNullable<GameStateChanges['placedRacks']>): Promise<string[]> {
  const prevRes = await client.query(`SELECT id FROM placed_racks WHERE user_id = $1`, [uid]);
  const nextIds = new Set(placedRacks.map((r) => r.id));
  const removed = (prevRes.rows as { id: string }[]).filter((r) => !nextIds.has(r.id));
  if (removed.length === 0) return [];
  const nowMs = Date.now();
  const userIdNum = Number(uid);
  for (const row of removed) {
    await releaseAllEquippedLeasesOnRack(client, userIdNum, row.id, nowMs);
  }
  return removed.map((r) => r.id);
}

/** Inclui qty de ASICs timed (leases em stock) no objeto stock antes de snapshot. */
async function mergeTimedLeaseStockIntoChangesStock(client: PoolClient, uid: number | string, stock: Record<string, number>): Promise<void> {
  await overlayTimedLeaseStockCounts(client, uid, stock);
}

/**
 * Para cada item timed presente em `stock` ou em leases do user, substitui a qty
 * pela contagem real de leases `status='stock'` válidos.
 * Mutates `stock` in place. Exported for servers/inventory snapshots that mount
 * stock via Prisma (not `loadUserStock`).
 */
export async function overlayTimedLeaseStockCounts(client: PoolClient, uid: number | string, stock: Record<string, number>): Promise<void> {
  const nowMs = Date.now();
  const leaseItems = await client.query(`SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1`, [uid]);
  const itemIds = new Set<string>();
  for (const row of leaseItems.rows as { item_id: string }[]) {
    const itemId = String(row.item_id || '').trim();
    if (itemId) itemIds.add(itemId);
  }
  for (const itemId of Object.keys(stock)) {
    itemIds.add(itemId);
  }
  for (const itemId of itemIds) {
    const cfg = await loadAsicDurationConfig(client, itemId);
    if (!isTimedAsicDuration(cfg)) continue;
    const cntRes = await client.query(`SELECT COUNT(*)::int AS n FROM player_asic_leases WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3`, [uid, itemId, nowMs]);
    const qty = Number(cntRes.rows[0]?.n) || 0;
    if (qty > 0) stock[itemId] = qty;
    else delete stock[itemId];
  }
}

/** Conta ocorrências de cada item_id numa lista (ignora vazios/nulos) — usado para
 *  comparar "quantos slots tinham este item antes" vs "quantos têm agora". */
function countByItemId(ids: Array<string | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of ids) {
    const id = raw != null ? String(raw).trim() : '';
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * Quando o cliente envia só `placedRacks` (sem `stock`), o servidor remove/edita rigs
 * na BD mas não recebia os incrementos de estoque — os componentes "evaporavam".
 * Recupera chassis, fiação, slots permanentes, multiplicadores e bateria a partir do estado anterior em BD:
 *
 * - **Rig inteiramente removida** (id ausente do novo `placedRacks`): devolve todos os
 *   componentes (chassis, fiação, cada slot de máquina, cada multiplicador, bateria).
 * - **Rig mantida mas com menos itens** (mesmo id, `slots`/`multiplierSlots`/`wiringId`
 *   com menos ocorrências de um item do que a BD tinha): devolve só a diferença (ex.:
 *   BD tinha 2× `gpu_x` nos slots, o payload novo só tem 1× → devolve 1× `gpu_x`).
 *   Corrigido: antes só a remoção de rig inteira era detectada — reduzir slots de uma
 *   rig que continua a existir fazia o item desaparecer sem ir pro stock nem ficar na
 *   rig (o `DELETE`+`INSERT` de `rack_slots`/`rack_multiplier_slots` em
 *   {@link persistStockStoredBatteriesPlacedRacks} substitui o conjunto antigo pelo
 *   novo sem comparar item a item). Ver DECISIONS.md.
 *
 * Bateria em rig mantida (troca/remoção de `batteryId` sem enviar `storedBatteries`)
 * não perde dado: a tabela `stored_batteries` só é tocada quando o caller envia
 * `storedBatteries` explicitamente (ver bloco correspondente em
 * `persistStockStoredBatteriesPlacedRacks`), então a instância antiga simplesmente
 * fica órfã de `placed_racks` mas continua existindo em armazém — não precisa de
 * recuperação aqui.
 *
 * ASICs timed/NFT: stock via leases após `releaseLeasesForRemovedPlacedRacks`, nunca
 * via este caminho (excluídos explicitamente — ver `bumpRecoveredEquipItem`).
 */
async function applyDismantledRacksStockRecoveryWhenStockOmitted(
  client: PoolClient,
  uid: number | string,
  placedRacks: NonNullable<GameStateChanges['placedRacks']>,
  changes: GameStateChanges
): Promise<void> {
  if (changes.stock !== undefined) return;

  const prevRes = await client.query(`SELECT id, item_id, wiring_id, battery_id FROM placed_racks WHERE user_id = $1`, [uid]);
  type PrevRow = { id: string; item_id: string; wiring_id: string | null; battery_id: string | null };
  const nextRackById = new Map(placedRacks.map((r) => [r.id, r]));
  const removed = (prevRes.rows as PrevRow[]).filter((r) => !nextRackById.has(r.id));
  const kept = (prevRes.rows as PrevRow[]).filter((r) => nextRackById.has(r.id));
  if (removed.length === 0 && kept.length === 0) return;

  const additions: Record<string, number> = {};
  const bump = (id: string | null | undefined, n = 1) => {
    const t = id != null ? String(id).trim() : '';
    if (!t || n <= 0) return;
    additions[t] = (additions[t] || 0) + n;
  };

  /** Como `bump`, mas exclui ASICs com validade (tracked via `player_asic_leases`,
   *  não devem virar entrada de `stock` comum). */
  const bumpRecoveredEquipItem = async (itemId: string, n: number) => {
    const t = itemId.trim();
    if (!t || n <= 0) return;
    const cfg = await loadAsicDurationConfig(client, t);
    if (isTimedAsicDuration(cfg)) return;
    bump(t, n);
  };

  for (const row of removed) {
    bump(row.item_id, 1);
    bump(row.wiring_id, 1);
    const [slots, multis] = await Promise.all([
      client.query('SELECT machine_item_id FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL', [row.id]),
      client.query('SELECT multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = $1 AND multiplier_item_id IS NOT NULL', [row.id])
    ]);
    for (const s of slots.rows as { machine_item_id: string }[]) {
      const itemId = String(s.machine_item_id || '').trim();
      if (itemId) await bumpRecoveredEquipItem(itemId, 1);
    }
    for (const m of multis.rows as { multiplier_item_id: string }[]) {
      bump(m.multiplier_item_id, 1);
    }

    await returnRackBatteryFromDismantleToChanges(client, uid, row.battery_id, additions, changes);
  }

  for (const row of kept) {
    const nextRack = nextRackById.get(row.id)!;

    // Fiação: item único (não multiset) — só devolve se saiu/trocou.
    const oldWiring = row.wiring_id != null ? String(row.wiring_id).trim() : '';
    const newWiring = nextRack.wiringId != null ? String(nextRack.wiringId).trim() : '';
    if (oldWiring && oldWiring !== newWiring) {
      bump(oldWiring, 1);
    }

    const [slotsRes, multisRes] = await Promise.all([
      client.query('SELECT machine_item_id FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL', [row.id]),
      client.query('SELECT multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = $1 AND multiplier_item_id IS NOT NULL', [row.id])
    ]);

    const oldSlotCounts = countByItemId((slotsRes.rows as { machine_item_id: string }[]).map((s) => s.machine_item_id));
    const newSlotCounts = countByItemId(Array.isArray(nextRack.slots) ? nextRack.slots : []);
    for (const [itemId, oldCount] of oldSlotCounts) {
      const surplus = oldCount - (newSlotCounts.get(itemId) || 0);
      if (surplus > 0) await bumpRecoveredEquipItem(itemId, surplus);
    }

    const oldMultiCounts = countByItemId((multisRes.rows as { multiplier_item_id: string }[]).map((m) => m.multiplier_item_id));
    const newMultiCounts = countByItemId(Array.isArray(nextRack.multiplierSlots) ? nextRack.multiplierSlots : []);
    for (const [itemId, oldCount] of oldMultiCounts) {
      const surplus = oldCount - (newMultiCounts.get(itemId) || 0);
      if (surplus > 0) bump(itemId, surplus);
    }
  }

  const keys = Object.keys(additions);
  if (keys.length === 0) return;
  const qtyRes = await client.query('SELECT item_id, qty FROM stock WHERE user_id = $1 AND item_id = ANY($2::text[])', [uid, keys]);
  const prevQty = new Map<string, number>();
  for (const r of qtyRes.rows as { item_id: string; qty: number }[]) {
    prevQty.set(String(r.item_id), Number(r.qty) || 0);
  }
  changes.stock = {};
  for (const k of keys) {
    const base = prevQty.get(k) ?? 0;
    changes.stock[k] = Math.floor(base + (additions[k] || 0));
  }
}

/**
 * Bateria desmontada volta ao stock (qty++). UUID deixa de ser inventário solto.
 */
async function returnRackBatteryFromDismantleToChanges(
  client: PoolClient,
  uid: number | string,
  batteryId: string | null | undefined,
  additions: Record<string, number>,
  changes: GameStateChanges
): Promise<void> {
  const bid = batteryId != null ? String(batteryId).trim() : '';
  if (!bid) return;
  const isUuid = isRackBatteryInstanceUuid(bid);
  if (isUuid) {
    const br = await client.query('SELECT id, item_id FROM stored_batteries WHERE id = $1 AND user_id = $2', [bid, uid]);
    if (br.rows[0]) {
      const itemId = normalizeKnown1000WhBatteryCatalogId(String((br.rows[0] as { item_id: string }).item_id || '').trim());
      if (itemId) additions[itemId] = (additions[itemId] || 0) + 1;
      // Ensure storedBatteries snapshot is loaded so subsequent delete can drop this UUID.
      await ensureStoredBatteriesInChanges(client, uid, changes);
      if (changes.storedBatteries) {
        changes.storedBatteries = changes.storedBatteries.filter((x) => x.id !== bid);
      }
      return;
    }
  }
  // Catalog id on rack: return as stock qty.
  const u = await client.query('SELECT type FROM upgrades WHERE id = $1', [bid]);
  const row = u.rows[0] as { type?: string } | undefined;
  if (row && String(row.type) === 'battery') {
    const itemId = normalizeKnown1000WhBatteryCatalogId(bid);
    additions[itemId] = (additions[itemId] || 0) + 1;
  }
}

/**
 * Materializa `stored_batteries` em falta para UUIDs montados em `placed_racks`
 * (ex.: `from_stock` / bulk mintam UUID na rig sem criar row). Idempotente (`ON CONFLICT DO NOTHING`).
 * Não inventa catálogo quando `battery_catalog_item_id` está vazio/NULL.
 */
export async function ensureMountedStoredBatteriesForUser(client: PoolClient, uid: number | string): Promise<void> {
  const userId = Number(uid);
  if (!Number.isFinite(userId) || userId <= 0) return;
  await client.query(
    `
    INSERT INTO stored_batteries (
      id, user_id, item_id, display_name, image_url,
      status, location, rack_id, slot_id, room_id,
      version, last_moved_at, updated_at
    )
    SELECT
      pr.battery_id,
      pr.user_id,
      btrim(pr.battery_catalog_item_id),
      NULLIF(btrim(COALESCE(pr.battery_display_name, '')), ''),
      NULLIF(btrim(COALESCE(pr.battery_image_url, '')), ''),
      'EQUIPPED',
      'RACK',
      pr.id,
      COALESCE(pr.slot_index, 0),
      COALESCE(NULLIF(btrim(COALESCE(pr.room_id::text, '')), ''), 'room_initial'),
      0,
      NOW(),
      NOW()
    FROM placed_racks pr
    WHERE pr.user_id = $1
      AND pr.battery_id IS NOT NULL
      AND btrim(pr.battery_id::text) <> ''
      AND pr.battery_id::text ~* $2::text
      AND pr.battery_catalog_item_id IS NOT NULL
      AND btrim(pr.battery_catalog_item_id) <> ''
      AND NOT EXISTS (SELECT 1 FROM stored_batteries sb WHERE sb.id = pr.battery_id)
    ON CONFLICT (id) DO NOTHING`,
    [userId, PG_BATTERY_INSTANCE_UUID]
  );
}

/**
 * Ponto único de escrita de `stock` / `stored_batteries` / `placed_racks` (+slots) para um jogador.
 * Chamado dentro de uma transação já aberta pelo caller (BEGIN/COMMIT/ROLLBACK ficam por conta dele);
 * esta função não abre nem fecha transação própria.
 *
 * Quando `changes.stock` vem omitido, `applyDismantledRacksStockRecoveryWhenStockOmitted`
 * recupera automaticamente qualquer componente que "sumiu" em relação à BD — tanto de
 * rigs inteiramente removidas quanto de rigs mantidas com menos itens nos slots/fiação
 * (correção de um gap real, ver DECISIONS.md) — antes do `DELETE`+`INSERT` de
 * `rack_slots`/`rack_multiplier_slots` mais abaixo substituir o conjunto antigo pelo novo.
 *
 * Após UPSERT de `placed_racks`, {@link ensureMountedStoredBatteriesForUser} materializa
 * rows `stored_batteries` em falta para UUIDs montados (from_stock/bulk), antes do semantic sync.
 */
export async function persistStockStoredBatteriesPlacedRacks(client: PoolClient, uid: number | string, changes: GameStateChanges, saveActivityLogs: ActivityLogEntry[]): Promise<void> {
  if (Array.isArray(changes.placedRacks) && changes.stock === undefined) {
    await applyDismantledRacksStockRecoveryWhenStockOmitted(client, uid, changes.placedRacks, changes);
  }

  if (Array.isArray(changes.placedRacks)) {
    const removedRackIds = await releaseLeasesForRemovedPlacedRacks(client, uid, changes.placedRacks);
    if (removedRackIds.length > 0) {
      if (changes.stock === undefined) {
        changes.stock = {};
      }
      await mergeTimedLeaseStockIntoChangesStock(client, uid, changes.stock);
    }
  }

  const { stock, storedBatteries, placedRacks } = changes;

  let preMountBatterySnap = new Map<string, StoredBatteryRowSnap>();
  if (Array.isArray(placedRacks) && placedRacks.length > 0) {
    const mountedIds = collectMountedBatteryInstanceIdsFromPlacedRacks(placedRacks as { batteryId?: unknown }[]);
    if (mountedIds.length > 0) {
      preMountBatterySnap = await loadStoredBatteryRowsForIds(client, uid, mountedIds);
    }
  }

  let storedBatteriesNorm = storedBatteries;
  if (storedBatteries) {
    storedBatteriesNorm = sanitizeStoredBatteriesForSavePayload(storedBatteries, changes.placedRacks) as typeof storedBatteries;
    const incomingBatIds = storedBatteriesNorm.map((b) => b.id);
    const rm = await validateStoredBatteryWarehouseRemovalAllowed(client, uid, incomingBatIds, { placedRacks: changes.placedRacks }, false);
    if (!rm.ok) {
      throw new StoredBatterySaveGuardError(rm.error);
    }
  }

  if (stock) {
    const stockMode: 'snapshot' | 'partial' | 'merge' =
      changes.stockMode === 'snapshot' ? 'snapshot' : changes.stockMode === 'merge' ? 'merge' : 'partial';
    const stockNorm = new Map<string, number>();
    for (const [rawId, rawQty] of Object.entries(stock)) {
      const itemId = normalizeKnown1000WhBatteryCatalogId(rawId);
      if (!itemId) continue;
      const qty = Math.floor(Number(rawQty) || 0);
      if (qty <= 0) continue;
      stockNorm.set(itemId, (stockNorm.get(itemId) || 0) + qty);
    }
    const itemIds = [...stockNorm.keys()];
    const qtys = itemIds.map((id) => stockNorm.get(id) || 0);

    if (stockMode === 'snapshot') {
      if (itemIds.length > 0) {
        await client.query('DELETE FROM stock WHERE user_id = $1 AND NOT (item_id = ANY($2::text[]))', [uid, itemIds]);
        await client.query(
          `
            INSERT INTO stock (user_id, item_id, qty)
            SELECT $1, unnest($2::text[]), unnest($3::int[])
            ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`,
          [uid, itemIds, qtys]
        );
      } else {
        await client.query('DELETE FROM stock WHERE user_id = $1', [uid]);
      }
      await client.query('DELETE FROM stock WHERE user_id = $1 AND qty <= 0', [uid]);
    } else if (stockMode === 'merge') {
      // UPSERT only — never DELETE omitted SKUs (Grangeiro).
      if (itemIds.length > 0) {
        await client.query(
          `
            INSERT INTO stock (user_id, item_id, qty)
            SELECT $1, unnest($2::text[]), unnest($3::int[])
            ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`,
          [uid, itemIds, qtys]
        );
      }
    } else if (itemIds.length > 0) {
      await client.query(
        `
          INSERT INTO stock (user_id, item_id, qty)
          SELECT $1, unnest($2::text[]), unnest($3::int[])
          ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`,
        [uid, itemIds, qtys]
      );
    }

    const nowMs = Date.now();
    const userIdNum = Number(uid);
    for (const [itemId, qty] of stockNorm.entries()) {
      await reconcileTimedAsicStockLeases(client, userIdNum, itemId, qty, nowMs);
    }
    if (stockMode === 'snapshot') {
      const leaseItems = await client.query(`SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1`, [uid]);
      for (const row of leaseItems.rows as { item_id: string }[]) {
        const id = String(row.item_id || '').trim();
        if (id && !stockNorm.has(id)) {
          await reconcileTimedAsicStockLeases(client, userIdNum, id, 0, nowMs);
        }
      }
    }
  }

  if (storedBatteriesNorm) {
    // `incomingIds` (saneado) NUNCA inclui UUIDs equipados em `placedRacks` (sanitize remove-os).
    // `placed_racks` na BD ainda reflete o estado VELHO; é actualizado mais à frente neste
    // mesmo método. Sem proteger explicitamente, equipar uma bateria UUID de armazém faria
    // o DELETE apagar a instância antes do INSERT placed_racks → rig fica com `battery_id`
    // órfão (foi exactamente este o bug que gerou os 92 racks fantasmas pós-explode UUID).
    const mountedIdsFromIncomingRacks = collectMountedBatteryInstanceIdsFromPlacedRacks(
      Array.isArray(changes.placedRacks) ? (changes.placedRacks as unknown as Array<{ batteryId?: unknown }>) : []
    );
    const incomingIds = [...new Set([...storedBatteriesNorm.map((b) => b.id), ...mountedIdsFromIncomingRacks])];
    await deleteWarehouseStoredBatteriesExceptKeepIds(client, Number(uid), incomingIds);
    if (storedBatteriesNorm.length > 0) {
      const bIds = storedBatteriesNorm.map((b) => b.id);
      const bItemIds = storedBatteriesNorm.map((b) => normalizeKnown1000WhBatteryCatalogId(b.itemId));
      const upStored = await fetchBatteryUpgradeRowsByIds(client, bItemIds);
      const bNames = bItemIds.map((cid) => {
        const n = upStored.get(String(cid))?.name;
        return n != null && String(n).trim() !== '' ? String(n).trim().slice(0, BATTERY_DISPLAY_NAME_MAX_LEN) : null;
      });
      const bImgs = bItemIds.map((cid) => {
        const im = upStored.get(String(cid))?.image;
        return im != null && String(im).trim() !== '' ? String(im).trim().slice(0, BATTERY_IMAGE_URL_MAX_LEN) : null;
      });
      await client.query(
        `
          INSERT INTO stored_batteries (id, user_id, item_id, display_name, image_url)
          SELECT unnest($2::text[]), $1, unnest($3::text[]), unnest($4::text[]), unnest($5::text[])
          ON CONFLICT (id) DO UPDATE SET
            item_id = EXCLUDED.item_id,
            display_name = COALESCE(NULLIF(BTRIM(EXCLUDED.display_name), ''), stored_batteries.display_name),
            image_url = COALESCE(NULLIF(BTRIM(EXCLUDED.image_url), ''), stored_batteries.image_url)`,
        [uid, bIds, bItemIds, bNames, bImgs]
      );
    }
  }

  if (placedRacks) {
    const ts = new Date().toISOString();
    const prevRacksRes = await client.query(
      `SELECT id, item_id, wiring_id, battery_id, is_on, selected_coin_id,
              COALESCE(NULLIF(BTRIM(room_id::text), ''), 'room_initial') AS room_id, slot_index,
              battery_catalog_item_id, battery_display_name, battery_image_url
       FROM placed_racks WHERE user_id = $1`,
      [uid]
    );
    type PrevRackRow = {
      id: string;
      item_id: string;
      wiring_id: string | null;
      battery_id: string | null;
      is_on: number;
      selected_coin_id: string | null;
      room_id: string;
      slot_index: number;
      battery_catalog_item_id: string | null;
      battery_display_name: string | null;
      battery_image_url: string | null;
    };
    const prevMap = new Map<string, PrevRackRow>(prevRacksRes.rows.map((row: PrevRackRow) => [row.id, row]));
    const nextIdSet = new Set(placedRacks.map((r) => r.id));

    for (const row of prevRacksRes.rows as PrevRackRow[]) {
      if (!nextIdSet.has(row.id)) {
        const [slots, multis] = await Promise.all([
          client.query('SELECT slot_index, machine_item_id FROM rack_slots WHERE rack_id = $1 ORDER BY slot_index', [row.id]),
          client.query('SELECT slot_index, multiplier_item_id FROM rack_multiplier_slots WHERE rack_id = $1 ORDER BY slot_index', [row.id])
        ]);
        const dismantledParts = {
          chassis: row.item_id,
          wiring: row.wiring_id,
          battery: row.battery_id,
          miners: slots.rows.filter((s: { machine_item_id: string | null }) => s.machine_item_id).map((s: { slot_index: number; machine_item_id: string }) => ({ slot: s.slot_index, id: s.machine_item_id })),
          multipliers: multis.rows.filter((m: { multiplier_item_id: string | null }) => m.multiplier_item_id).map((m: { slot_index: number; multiplier_item_id: string }) => ({ slot: m.slot_index, id: m.multiplier_item_id }))
        };
        console.log(`[RackDismantle] ts=${ts} userId=${uid} rackId=${row.id} parts=${JSON.stringify(dismantledParts)}`);
        saveActivityLogs.push({ action: 'rack_dismantle', meta: { rackId: row.id, parts: dismantledParts } });
      }
    }
    for (const r of placedRacks) {
      if (!prevMap.has(r.id)) {
        console.log(`[RackPlace] ts=${ts} userId=${uid} rackId=${r.id} itemId=${r.itemId} room=${r.roomId ?? ''} slotIndex=${r.slotIndex ?? 0}`);
        saveActivityLogs.push({ action: 'rack_place', meta: { rackId: r.id, itemId: r.itemId, room: r.roomId ?? '', slotIndex: r.slotIndex ?? 0 } });
      }
    }

    const prevSlotsRes = await client.query(
      `SELECT s.rack_id, s.slot_index, s.machine_item_id
       FROM rack_slots s
       INNER JOIN placed_racks pr ON pr.id = s.rack_id AND pr.user_id = $1
       ORDER BY s.rack_id, s.slot_index`,
      [uid]
    );
    const prevMultRes = await client.query(
      `SELECT s.rack_id, s.slot_index, s.multiplier_item_id
       FROM rack_multiplier_slots s
       INNER JOIN placed_racks pr ON pr.id = s.rack_id AND pr.user_id = $1
       ORDER BY s.rack_id, s.slot_index`,
      [uid]
    );
    const prevMachSig = (rackId: string) =>
      prevSlotsRes.rows
        .filter((x: { rack_id: string }) => x.rack_id === rackId)
        .sort((a: { slot_index: number }, b: { slot_index: number }) => a.slot_index - b.slot_index)
        .map((x: { machine_item_id: string | null }) => String(x.machine_item_id || ''))
        .join('|');
    const prevMultiSig = (rackId: string) =>
      prevMultRes.rows
        .filter((x: { rack_id: string }) => x.rack_id === rackId)
        .sort((a: { slot_index: number }, b: { slot_index: number }) => a.slot_index - b.slot_index)
        .map((x: { multiplier_item_id: string | null }) => String(x.multiplier_item_id || ''))
        .join('|');
    let miningUpdateLogs = 0;
    const MAX_MINING_UPDATE_LOGS = 48;
    for (const r of placedRacks) {
      if (!prevMap.has(r.id)) continue;
      const prow = prevMap.get(r.id);
      if (!prow) continue;
      const changed: string[] = [];
      if (String(prow.item_id || '') !== String(r.itemId || '')) changed.push('chassis');
      if (String(prow.wiring_id || '') !== String(r.wiringId || '')) changed.push('wiring');
      if (String(prow.battery_id || '') !== String(r.batteryId || '')) changed.push('battery');
      if (Number(prow.is_on) !== (r.isOn ? 1 : 0)) changed.push('power');
      if (String(prow.selected_coin_id || '') !== String(r.selectedCoinId || '')) changed.push('coin');
      if (String(prow.room_id || '') !== String(normalizePlacedRackRoomId(r.roomId))) changed.push('room');
      if (Number(prow.slot_index || 0) !== Number(r.slotIndex || 0)) changed.push('slot');
      const nextMach = Array.isArray(r.slots) ? r.slots.map((x) => String(x || '')).join('|') : '';
      const nextMult = Array.isArray(r.multiplierSlots) ? r.multiplierSlots.map((x) => String(x || '')).join('|') : '';
      if (prevMachSig(r.id) !== nextMach) changed.push('miners');
      if (prevMultiSig(r.id) !== nextMult) changed.push('multipliers');
      if (changed.length > 0 && miningUpdateLogs < MAX_MINING_UPDATE_LOGS) {
        saveActivityLogs.push({ action: 'mining_rack_update', meta: { rackId: r.id, changed } });
        miningUpdateLogs++;
      }
    }

    const currentRackIds = placedRacks.map((r) => r.id);
    if (currentRackIds.length > 0) {
      const removedRacksQuery = 'SELECT id FROM placed_racks WHERE user_id = $1 AND NOT (id = ANY($2::text[]))';
      await client.query(`DELETE FROM rack_slots WHERE rack_id IN (${removedRacksQuery})`, [uid, currentRackIds]);
      await client.query(`DELETE FROM rack_multiplier_slots WHERE rack_id IN (${removedRacksQuery})`, [uid, currentRackIds]);
      await client.query('DELETE FROM placed_racks WHERE user_id = $1 AND NOT (id = ANY($2::text[]))', [uid, currentRackIds]);
    } else {
      await client.query('DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)', [uid]);
      await client.query('DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)', [uid]);
      await client.query('DELETE FROM placed_racks WHERE user_id = $1', [uid]);
    }

    if (placedRacks.length > 0) {
      const catalogIdsForUpgrades = new Set<string>();
      for (const r of placedRacks) {
        const bid = r.batteryId != null ? String(r.batteryId).trim() : '';
        if (!bid) continue;
        const prow = prevMap.get(r.id);
        let cat: string | null;
        if (isRackBatteryInstanceUuid(bid)) {
          const inst = preMountBatterySnap.get(bid);
          cat = inst?.item_id != null ? normalizeKnown1000WhBatteryCatalogId(inst.item_id) : null;
          if (!cat && prow && String(prow.battery_id || '') === bid) {
            cat = prow.battery_catalog_item_id != null ? normalizeKnown1000WhBatteryCatalogId(prow.battery_catalog_item_id) : null;
          }
          if (!cat && r.batteryCatalogItemId != null && String(r.batteryCatalogItemId).trim() !== '') {
            cat = normalizeKnown1000WhBatteryCatalogId(r.batteryCatalogItemId);
          }
        } else {
          cat = normalizeKnown1000WhBatteryCatalogId(bid);
        }
        if (cat) catalogIdsForUpgrades.add(cat);
      }
      const upgradeByCatalog = await fetchBatteryUpgradeRowsByIds(client, [...catalogIdsForUpgrades]);

      const rIds = placedRacks.map((r) => r.id);
      const rItems = placedRacks.map((r) => r.itemId);
      const rWirings = placedRacks.map((r) => r.wiringId || null);
      const rBatteries = placedRacks.map((r) => {
        const bid = r.batteryId != null ? String(r.batteryId).trim() : '';
        if (!bid || isRackBatteryInstanceUuid(bid)) return r.batteryId || null;
        return normalizeKnown1000WhBatteryCatalogId(bid);
      });
      const rOns = placedRacks.map((r) => (r.isOn ? 1 : 0));
      const rCoins = placedRacks.map((r) => r.selectedCoinId || null);
      const rRooms = placedRacks.map((r) => normalizePlacedRackRoomId(r.roomId));
      const rSlotIdxs = placedRacks.map((r) => r.slotIndex || 0);

      const rBatCats: (string | null)[] = [];
      const rBatNames: (string | null)[] = [];
      const rBatImgs: (string | null)[] = [];
      for (const r of placedRacks) {
        const prow = prevMap.get(r.id);
        const prevBatt: PrevPlacedRackBattRow | null = prow
          ? { battery_id: prow.battery_id, battery_catalog_item_id: prow.battery_catalog_item_id, battery_display_name: prow.battery_display_name, battery_image_url: prow.battery_image_url }
          : null;
        const snap = buildRackBatteryPersistSnapshot(r.batteryId, preMountBatterySnap, upgradeByCatalog, prevBatt);
        const catOut =
          snap.catalogItemId != null && String(snap.catalogItemId).trim() !== ''
            ? normalizeKnown1000WhBatteryCatalogId(snap.catalogItemId)
            : r.batteryCatalogItemId != null && String(r.batteryCatalogItemId).trim() !== ''
              ? normalizeKnown1000WhBatteryCatalogId(r.batteryCatalogItemId)
              : null;
        const uFromCat = catOut ? upgradeByCatalog.get(catOut) : undefined;
        const nameOut =
          snap.displayName != null && String(snap.displayName).trim() !== ''
            ? String(snap.displayName).trim().slice(0, BATTERY_DISPLAY_NAME_MAX_LEN)
            : uFromCat?.name != null && String(uFromCat.name).trim() !== ''
              ? String(uFromCat.name).trim().slice(0, BATTERY_DISPLAY_NAME_MAX_LEN)
              : null;
        const imgOut =
          snap.imageUrl != null && String(snap.imageUrl).trim() !== ''
            ? String(snap.imageUrl).trim().slice(0, BATTERY_IMAGE_URL_MAX_LEN)
            : uFromCat?.image != null && String(uFromCat.image).trim() !== ''
              ? String(uFromCat.image).trim().slice(0, BATTERY_IMAGE_URL_MAX_LEN)
              : null;
        rBatCats.push(catOut);
        rBatNames.push(nameOut);
        rBatImgs.push(imgOut);
      }

      await client.query(
        `
          INSERT INTO placed_racks (
            id, user_id, item_id, wiring_id, battery_id, is_on, selected_coin_id, room_id, slot_index,
            battery_catalog_item_id, battery_display_name, battery_image_url
          )
          SELECT unnest($2::text[]), $1, unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::int[]), unnest($7::text[]), unnest($8::text[]), unnest($9::int[]),
                 unnest($10::text[]), unnest($11::text[]), unnest($12::text[])
          ON CONFLICT (id) DO UPDATE SET
            item_id = EXCLUDED.item_id, wiring_id = EXCLUDED.wiring_id, battery_id = EXCLUDED.battery_id,
            is_on = EXCLUDED.is_on, selected_coin_id = EXCLUDED.selected_coin_id,
            room_id = EXCLUDED.room_id, slot_index = EXCLUDED.slot_index,
            battery_catalog_item_id = EXCLUDED.battery_catalog_item_id,
            battery_display_name = EXCLUDED.battery_display_name,
            battery_image_url = EXCLUDED.battery_image_url`,
        [uid, rIds, rItems, rWirings, rBatteries, rOns, rCoins, rRooms, rSlotIdxs, rBatCats, rBatNames, rBatImgs]
      );

      await client.query('DELETE FROM rack_slots WHERE rack_id = ANY($1)', [rIds]);
      await client.query('DELETE FROM rack_multiplier_slots WHERE rack_id = ANY($1)', [rIds]);

      const allSlotsRackId: string[] = [];
      const allSlotsIdx: number[] = [];
      const allSlotsItem: string[] = [];
      const allSlotsLease: (string | null)[] = [];

      const allMultiRackId: string[] = [];
      const allMultiIdx: number[] = [];
      const allMultiItem: string[] = [];

      for (const r of placedRacks) {
        if (r.slots) {
          const leases = r.slotLeaseIds || [];
          for (let i = 0; i < r.slots.length; i++) {
            if (r.slots[i]) {
              allSlotsRackId.push(r.id);
              allSlotsIdx.push(i);
              allSlotsItem.push(String(r.slots[i]));
              const leaseRaw = leases[i] != null ? String(leases[i]).trim() : '';
              allSlotsLease.push(leaseRaw || null);
            }
          }
        }
        if (r.multiplierSlots) {
          for (let i = 0; i < r.multiplierSlots.length; i++) {
            if (r.multiplierSlots[i]) {
              allMultiRackId.push(r.id);
              allMultiIdx.push(i);
              allMultiItem.push(String(r.multiplierSlots[i]));
            }
          }
        }
      }

      if (allSlotsRackId.length > 0) {
        await client.query(`INSERT INTO rack_slots (rack_id, slot_index, machine_item_id, machine_lease_id) SELECT unnest($1::text[]), unnest($2::int[]), unnest($3::text[]), unnest($4::uuid[])`, [
          allSlotsRackId,
          allSlotsIdx,
          allSlotsItem,
          allSlotsLease
        ]);
      }
      if (allMultiRackId.length > 0) {
        await client.query(`INSERT INTO rack_multiplier_slots (rack_id, slot_index, multiplier_item_id) SELECT unnest($1::text[]), unnest($2::int[]), unnest($3::text[])`, [allMultiRackId, allMultiIdx, allMultiItem]);
      }

      // from_stock / bulk mintam UUID em placed_racks sem INSERT em stored_batteries;
      // materializa rows montadas em falta antes do semantic sync.
      await ensureMountedStoredBatteriesForUser(client, uid);
    }
  }

  if (Array.isArray(placedRacks) || storedBatteriesNorm) {
    await syncStoredBatterySemanticsForUser(client, Number(uid));
  }
}
