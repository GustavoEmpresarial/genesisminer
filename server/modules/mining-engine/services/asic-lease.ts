/**
 * ASICs com validade: cada unidade comprada gera uma linha em `player_asic_leases`.
 * Após `expires_at`: soft-expire (`status=expired`), limpa slot operacional, preserva lease + ASIC_EXPIRED (4C).
 *
 * Migrado de legacy/backend/lib/asicLease.ts; 4C: soft-expire + eventos de elegibilidade.
 */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { isNftRoomCatalogMachineRow, type UpgradeMiningRow } from './nft-room-mining.js';
import { recordMiningEligibilityEvent } from './mining-eligibility-events.js';
import {
  ASIC_DURATION_KINDS,
  ASIC_DURATION_UNITS,
  durationMsForConfig,
  isTimedAsicDuration,
  normalizeAsicDurationConfig,
  normalizeAsicDurationKind,
  normalizeAsicDurationUnit,
  type AsicDurationConfig,
  type AsicDurationKind,
  type AsicDurationUnit
} from '../../../shared/utils/lease-duration.js';
import { instanceCode } from '../../../shared/utils/item-instance-code.js';

export {
  ASIC_DURATION_KINDS,
  ASIC_DURATION_UNITS,
  durationMsForConfig,
  isTimedAsicDuration,
  normalizeAsicDurationConfig,
  normalizeAsicDurationKind,
  normalizeAsicDurationUnit
};
export type { AsicDurationConfig, AsicDurationKind, AsicDurationUnit };

const ASIC_LEASE_STATUS_STOCK = 'stock' as const;
const ASIC_LEASE_STATUS_EQUIPPED = 'equipped' as const;
const ASIC_LEASE_STATUS_EXPIRED = 'expired' as const;
/** Trim / debit leftover — keep the instance row for audit (never DELETE). */
const ITEM_INSTANCE_STATUS_CONSUMED = 'consumed' as const;

async function mirrorInstanceLeaseState(
  client: PoolClient,
  leaseId: string,
  status: typeof ASIC_LEASE_STATUS_STOCK | typeof ASIC_LEASE_STATUS_EQUIPPED | typeof ASIC_LEASE_STATUS_EXPIRED,
  rackId: string | null,
  slotIndex: number | null
): Promise<void> {
  await client.query(
    `UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1`,
    [leaseId, status, rackId, slotIndex]
  );
}

export function computeAsicLeaseExpiresAt(cfg: AsicDurationConfig, fromMs: number): number {
  const ms = durationMsForConfig(cfg);
  if (ms <= 0) return 0;
  return fromMs + ms;
}

export function isAsicCatalogRow(row: UpgradeMiningRow | null | undefined): boolean {
  return isNftRoomCatalogMachineRow(row);
}

export async function loadAsicDurationConfig(client: PoolClient, itemId: string): Promise<AsicDurationConfig> {
  const r = await client.query(
    `SELECT type, category, id,
            nft_mining_coin_id,
            COALESCE(asic_duration_amount, 0) AS asic_duration_amount,
            asic_duration_unit,
            COALESCE(asic_duration_kind, 'none') AS asic_duration_kind
     FROM upgrades WHERE id = $1 LIMIT 1`,
    [itemId]
  );
  const row = r.rows[0] as
    | {
        type?: string;
        category?: string;
        id?: string;
        nft_mining_coin_id?: string | null;
        asic_duration_amount?: number;
        asic_duration_unit?: string | null;
        asic_duration_kind?: string;
      }
    | undefined;
  if (!row || !isNftRoomCatalogMachineRow(row)) return { amount: 0, unit: null };
  return normalizeAsicDurationConfig({ amount: row.asic_duration_amount, unit: row.asic_duration_unit, kind: row.asic_duration_kind });
}

export async function createAsicLeasesOnPurchase(
  client: PoolClient,
  userId: number,
  itemId: string,
  qty: number,
  cfg: AsicDurationConfig,
  nowMs: number
): Promise<void> {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0 || !isTimedAsicDuration(cfg)) return;
  const expiresAt = computeAsicLeaseExpiresAt(cfg, nowMs);
  if (expiresAt <= nowMs) return;

  for (let i = 0; i < n; i++) {
    const leaseId = crypto.randomUUID();
    await client.query(
      `INSERT INTO player_asic_leases (id, user_id, item_id, acquired_at, expires_at, status, rack_id, slot_index)
       VALUES ($1, $2, $3, $4, $5, 'stock', NULL, NULL)`,
      [leaseId, userId, itemId, nowMs, expiresAt]
    );
    await client.query(
      `INSERT INTO item_instances (id, code, catalog_item_id, user_id, status, rack_id, slot_index)
       VALUES ($1, $2, $3, $4, 'stock', NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [leaseId, instanceCode(itemId, leaseId), itemId, userId]
    );
  }
}

/**
 * Alinha stock com leases timed existentes: trim excessos quando target < COUNT(stock);
 * nunca minta leases (só nascem em shop/credit-catalog/checkin). Persist snapshot só synca qty.
 */
export async function reconcileTimedAsicStockLeases(client: PoolClient, userId: number, itemId: string, targetQty: number, nowMs: number): Promise<boolean> {
  const cfg = await loadAsicDurationConfig(client, itemId);
  if (!isTimedAsicDuration(cfg)) return false;

  const target = Math.max(0, Math.floor(Number(targetQty) || 0));
  const cntRes = await client.query(`SELECT COUNT(*)::int AS n FROM player_asic_leases WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3`, [userId, itemId, nowMs]);
  const current = Number(cntRes.rows[0]?.n) || 0;

  // target > current: não mintar — leases só nascem em shop/credit-catalog/checkin; persist snapshot nunca mint.
  if (target < current) {
    const toRemove = current - target;
    const deleted = await client.query(
      `DELETE FROM player_asic_leases
       WHERE id IN (
         SELECT id FROM player_asic_leases
         WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3
         ORDER BY expires_at DESC
         LIMIT $4
       )
       RETURNING id`,
      [userId, itemId, nowMs, toRemove]
    );
    const deletedIds = (deleted.rows as { id: string }[])
      .map((row) => String(row.id || '').trim())
      .filter((id) => id.length > 0);
    if (deletedIds.length > 0) {
      await client.query(
        `UPDATE item_instances SET status = $2 WHERE id = ANY($1::uuid[])`,
        [deletedIds, ITEM_INSTANCE_STATUS_CONSUMED]
      );
    }
  }

  await syncTimedAsicStockForItem(client, userId, itemId, nowMs);
  return true;
}

export async function syncTimedAsicStockForItem(client: PoolClient, userId: number, itemId: string, nowMs: number): Promise<void> {
  const cntRes = await client.query(`SELECT COUNT(*)::int AS n FROM player_asic_leases WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3`, [userId, itemId, nowMs]);
  const qty = Number(cntRes.rows[0]?.n) || 0;
  if (qty > 0) {
    await client.query(`INSERT INTO stock (user_id, item_id, qty) VALUES ($1, $2, $3) ON CONFLICT (user_id, item_id) DO UPDATE SET qty = EXCLUDED.qty`, [userId, itemId, qty]);
  } else {
    await client.query(`DELETE FROM stock WHERE user_id = $1 AND item_id = $2`, [userId, itemId]);
  }
}

export async function syncAllTimedAsicStock(client: PoolClient, userId: number, nowMs: number): Promise<void> {
  const items = await client.query(`SELECT DISTINCT item_id FROM player_asic_leases WHERE user_id = $1`, [userId]);
  for (const row of items.rows as { item_id: string }[]) {
    await syncTimedAsicStockForItem(client, userId, String(row.item_id), nowMs);
  }
}

/**
 * Soft-expire: limpa ocupação operacional, preserva acquired_at/expires_at, emite ASIC_EXPIRED uma vez.
 * Idempotente: leases já `expired` não são seleccionadas de novo.
 */
export async function expireUserAsicLeases(client: PoolClient, userId: number, nowMs: number): Promise<number> {
  const expired = await client.query(
    `SELECT id, item_id, status, rack_id, slot_index, acquired_at, expires_at
     FROM player_asic_leases
     WHERE user_id = $1 AND expires_at <= $2 AND status IN ('stock', 'equipped')
     FOR UPDATE`,
    [userId, nowMs]
  );
  let n = 0;
  for (const row of expired.rows as {
    id: string;
    item_id: string;
    status: string;
    rack_id: string | null;
    slot_index: number | null;
    acquired_at: number | string;
    expires_at: number | string;
  }[]) {
    n++;
    const leaseId = String(row.id);
    const itemId = String(row.item_id || '').trim();
    const rackId = row.rack_id != null ? String(row.rack_id).trim() : '';
    const slotIndex = row.slot_index != null && Number.isFinite(Number(row.slot_index)) ? Math.floor(Number(row.slot_index)) : null;

    if (row.status === 'equipped' && rackId && slotIndex != null) {
      await recordMiningEligibilityEvent(client, {
        userId,
        eventType: 'MINER_UNEQUIPPED',
        atMs: nowMs,
        identityKind: 'lease',
        leaseId,
        rackId,
        slotIndex,
        catalogItemId: itemId || null,
        payload: { reason: 'asic_expired' }
      });
      await client.query(
        `UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL
         WHERE rack_id = $1 AND slot_index = $2 AND machine_lease_id = $3`,
        [rackId, slotIndex, leaseId]
      );
    }

    await client.query(
      `UPDATE player_asic_leases
       SET status = 'expired', rack_id = NULL, slot_index = NULL
       WHERE id = $1 AND status IN ('stock', 'equipped')`,
      [leaseId]
    );
    await mirrorInstanceLeaseState(client, leaseId, ASIC_LEASE_STATUS_EXPIRED, null, null);

    await recordMiningEligibilityEvent(client, {
      userId,
      eventType: 'ASIC_EXPIRED',
      atMs: nowMs,
      identityKind: 'lease',
      leaseId,
      rackId: rackId || null,
      slotIndex,
      catalogItemId: itemId || null,
      payload: {
        acquired_at: Number(row.acquired_at),
        expires_at: Number(row.expires_at),
        previous_status: row.status
      }
    });
  }
  if (n > 0) {
    await syncAllTimedAsicStock(client, userId, nowMs);
  }
  return n;
}

export async function reserveAsicLeaseForEquip(client: PoolClient, userId: number, itemId: string, nowMs: number): Promise<{ ok: true; leaseId: string } | { ok: false; error: string }> {
  const res = await client.query(
    `SELECT id FROM player_asic_leases
     WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3
     ORDER BY expires_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [userId, itemId, nowMs]
  );
  const leaseId = res.rows[0]?.id != null ? String(res.rows[0].id) : '';
  if (!leaseId) {
    return { ok: false, error: 'No valid ASICs in stock (expired or sold out).' };
  }
  return { ok: true, leaseId };
}

export async function markLeaseEquipped(client: PoolClient, leaseId: string, userId: number, rackId: string, slotIndex: number): Promise<void> {
  const si = Math.floor(slotIndex);
  await client.query(`UPDATE player_asic_leases SET status = 'equipped', rack_id = $3, slot_index = $4 WHERE id = $1 AND user_id = $2 AND status = 'stock'`, [leaseId, userId, rackId, si]);
  await mirrorInstanceLeaseState(client, leaseId, ASIC_LEASE_STATUS_EQUIPPED, rackId, si);
}

export async function releaseEquippedAsicLease(client: PoolClient, userId: number, rackId: string, slotIndex: number, nowMs: number): Promise<void> {
  const si = Math.floor(slotIndex);
  const slotRes = await client.query(`SELECT machine_item_id, machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2`, [rackId, si]);
  const slot = slotRes.rows[0] as { machine_item_id?: string; machine_lease_id?: string } | undefined;
  let leaseId = slot?.machine_lease_id ? String(slot.machine_lease_id).trim() : '';
  const itemId = slot?.machine_item_id ? String(slot.machine_item_id).trim() : '';

  // Resolve lease before clearing the slot so a null machine_lease_id pointer
  // can still be recovered via rack+slot on the lease row.
  if (!leaseId) {
    const existing = await client.query(
      `SELECT id FROM player_asic_leases WHERE user_id = $1 AND status = 'equipped' AND rack_id = $2 AND slot_index = $3 AND expires_at > $4 LIMIT 1`,
      [userId, rackId, si, nowMs]
    );
    if (existing.rows[0]?.id) {
      leaseId = String(existing.rows[0].id);
    }
  }

  if (itemId || leaseId) {
    await recordMiningEligibilityEvent(client, {
      userId,
      eventType: 'MINER_UNEQUIPPED',
      atMs: nowMs,
      identityKind: leaseId ? 'lease' : 'placement',
      leaseId: leaseId || null,
      rackId,
      slotIndex: si,
      catalogItemId: itemId || null,
      payload: { reason: 'unequip' }
    });
  }

  await client.query(`UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL WHERE rack_id = $1 AND slot_index = $2`, [rackId, si]);

  if (!leaseId) return;

  const leaseRes = await client.query(
    `SELECT id, item_id, expires_at, acquired_at, status FROM player_asic_leases WHERE id = $1 AND user_id = $2`,
    [leaseId, userId]
  );
  const lease = leaseRes.rows[0] as { id: string; item_id: string; expires_at: number; acquired_at: number; status: string } | undefined;
  if (!lease) return;

  if (Number(lease.expires_at) <= nowMs) {
    await softExpireLeaseRow(client, userId, leaseId, itemId || String(lease.item_id), nowMs, {
      acquired_at: Number(lease.acquired_at),
      expires_at: Number(lease.expires_at),
      previous_status: lease.status,
      rackId,
      slotIndex: si
    });
  } else {
    await client.query(`UPDATE player_asic_leases SET status = 'stock', rack_id = NULL, slot_index = NULL WHERE id = $1`, [leaseId]);
    await mirrorInstanceLeaseState(client, leaseId, ASIC_LEASE_STATUS_STOCK, null, null);
  }
  if (itemId) await syncTimedAsicStockForItem(client, userId, itemId, nowMs);
}

async function softExpireLeaseRow(
  client: PoolClient,
  userId: number,
  leaseId: string,
  itemId: string,
  nowMs: number,
  meta: { acquired_at: number; expires_at: number; previous_status: string; rackId?: string | null; slotIndex?: number | null }
): Promise<void> {
  const upd = await client.query(
    `UPDATE player_asic_leases
     SET status = 'expired', rack_id = NULL, slot_index = NULL
     WHERE id = $1 AND user_id = $2 AND status IN ('stock', 'equipped')`,
    [leaseId, userId]
  );
  if ((upd.rowCount ?? 0) === 0) return;
  await mirrorInstanceLeaseState(client, leaseId, ASIC_LEASE_STATUS_EXPIRED, null, null);
  await recordMiningEligibilityEvent(client, {
    userId,
    eventType: 'ASIC_EXPIRED',
    atMs: nowMs,
    identityKind: 'lease',
    leaseId,
    rackId: meta.rackId ?? null,
    slotIndex: meta.slotIndex ?? null,
    catalogItemId: itemId || null,
    payload: {
      acquired_at: meta.acquired_at,
      expires_at: meta.expires_at,
      previous_status: meta.previous_status
    }
  });
}

/**
 * Repara ponteiros operacionais: reattach de lease `equipped` existente ao slot.
 * NÃO inventa lease com acquired_at=now / expires_at=now+duration (4C).
 */
export async function repairEquippedAsicLeasesForRack(client: PoolClient, userId: number, rackId: string, nowMs: number): Promise<number> {
  const slotsRes = await client.query(
    `SELECT s.rack_id, s.slot_index, s.machine_item_id
     FROM rack_slots s
     INNER JOIN placed_racks pr ON pr.id = s.rack_id AND pr.user_id = $1
     WHERE s.rack_id = $2
       AND s.machine_item_id IS NOT NULL
       AND (s.machine_lease_id IS NULL OR BTRIM(s.machine_lease_id::text) = '')`,
    [userId, rackId]
  );
  let repaired = 0;
  for (const row of slotsRes.rows as { rack_id: string; slot_index: number; machine_item_id: string }[]) {
    const itemId = String(row.machine_item_id || '').trim();
    if (!itemId) continue;
    const cfg = await loadAsicDurationConfig(client, itemId);
    if (!isTimedAsicDuration(cfg)) continue;

    const existing = await client.query(
      `SELECT id FROM player_asic_leases WHERE user_id = $1 AND status = 'equipped' AND rack_id = $2 AND slot_index = $3 AND expires_at > $4 LIMIT 1`,
      [userId, row.rack_id, row.slot_index, nowMs]
    );
    if (existing.rows[0]?.id) {
      const leaseId = String(existing.rows[0].id);
      await client.query(`UPDATE rack_slots SET machine_lease_id = $3 WHERE rack_id = $1 AND slot_index = $2`, [row.rack_id, row.slot_index, leaseId]);
      repaired++;
      continue;
    }

    // Inconsistência: slot timed sem lease histórica — não inventar vida económica.
    console.warn(
      JSON.stringify({
        event: 'asic_lease_repair_orphan_slot',
        userId,
        rackId: row.rack_id,
        slotIndex: row.slot_index,
        itemId,
        atMs: nowMs,
        action: 'left_unlinked'
      })
    );
  }
  return repaired;
}

/** Devolve todos os ASICs timed equipados na rig ao stock (leases `status='stock'`). */
export async function releaseAllEquippedLeasesOnRack(client: PoolClient, userId: number, rackId: string, nowMs: number): Promise<void> {
  await repairEquippedAsicLeasesForRack(client, userId, rackId, nowMs);

  const slotsRes = await client.query(`SELECT slot_index, machine_item_id, machine_lease_id FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL ORDER BY slot_index`, [rackId]);

  const affectedItems = new Set<string>();

  for (const row of slotsRes.rows as { slot_index: number; machine_item_id: string; machine_lease_id?: string | null }[]) {
    const si = Math.floor(Number(row.slot_index) || 0);
    const itemId = String(row.machine_item_id || '').trim();
    let leaseId = row.machine_lease_id != null && String(row.machine_lease_id).trim() ? String(row.machine_lease_id).trim() : '';

    if (!leaseId) {
      const existing = await client.query(
        `SELECT id FROM player_asic_leases WHERE user_id = $1 AND status = 'equipped' AND rack_id = $2 AND slot_index = $3 AND expires_at > $4 LIMIT 1`,
        [userId, rackId, si, nowMs]
      );
      if (existing.rows[0]?.id) {
        leaseId = String(existing.rows[0].id);
      }
    }

    if (leaseId) {
      await releaseEquippedAsicLeaseById(client, userId, leaseId, itemId, nowMs);
    } else {
      await releaseEquippedAsicLease(client, userId, rackId, si, nowMs);
    }
    if (itemId) affectedItems.add(itemId);
  }

  const orphanLeases = await client.query(`SELECT id, item_id FROM player_asic_leases WHERE user_id = $1 AND rack_id = $2 AND status = 'equipped' AND expires_at > $3`, [userId, rackId, nowMs]);
  for (const row of orphanLeases.rows as { id: string; item_id: string }[]) {
    await releaseEquippedAsicLeaseById(client, userId, String(row.id), String(row.item_id), nowMs);
    const syncItem = String(row.item_id || '').trim();
    if (syncItem) affectedItems.add(syncItem);
  }

  for (const itemId of affectedItems) {
    await syncTimedAsicStockForItem(client, userId, itemId, nowMs);
  }
}

/** Resolve lease equipado num slot (slot BD ou fallback por rack+slot). */
export async function resolveEquippedLeaseIdForSlot(client: PoolClient, userId: number, rackId: string, slotIndex: number, slotLeaseIdHint: string, nowMs: number): Promise<string> {
  const hint = String(slotLeaseIdHint || '').trim();
  if (hint) {
    // Stale snapshot hints must not short-circuit: only accept if still an equipped lease for this user.
    const hintRes = await client.query(
      `SELECT id FROM player_asic_leases WHERE id = $1 AND user_id = $2 AND status = 'equipped' AND expires_at > $3`,
      [hint, userId, nowMs]
    );
    if (hintRes.rows[0]?.id) return String(hintRes.rows[0].id);
  }

  const slotRes = await client.query(`SELECT machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2`, [rackId, Math.floor(slotIndex)]);
  const fromSlot = slotRes.rows[0] as { machine_lease_id?: string | null } | undefined;
  const fromDb = fromSlot?.machine_lease_id != null && String(fromSlot.machine_lease_id).trim() ? String(fromSlot.machine_lease_id).trim() : '';
  if (fromDb) return fromDb;

  await repairEquippedAsicLeasesForRack(client, userId, rackId, nowMs);

  const afterRepair = await client.query(`SELECT machine_lease_id FROM rack_slots WHERE rack_id = $1 AND slot_index = $2`, [rackId, Math.floor(slotIndex)]);
  const repaired = afterRepair.rows[0] as { machine_lease_id?: string | null } | undefined;
  if (repaired?.machine_lease_id != null && String(repaired.machine_lease_id).trim()) {
    return String(repaired.machine_lease_id).trim();
  }

  const existing = await client.query(
    `SELECT id FROM player_asic_leases WHERE user_id = $1 AND status = 'equipped' AND rack_id = $2 AND slot_index = $3 AND expires_at > $4 LIMIT 1`,
    [userId, rackId, Math.floor(slotIndex), nowMs]
  );
  if (existing.rows[0]?.id) return String(existing.rows[0].id);
  return '';
}

/** @returns true if the lease row existed and was processed; false if missing / empty id. */
export async function releaseEquippedAsicLeaseById(client: PoolClient, userId: number, leaseId: string, itemId: string, nowMs: number): Promise<boolean> {
  const id = String(leaseId || '').trim();
  if (!id) return false;
  const leaseRes = await client.query(
    `SELECT id, item_id, expires_at, acquired_at, status, rack_id, slot_index FROM player_asic_leases WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  const lease = leaseRes.rows[0] as {
    id: string;
    item_id: string;
    expires_at: number;
    acquired_at: number;
    status: string;
    rack_id: string | null;
    slot_index: number | null;
  } | undefined;
  if (!lease) return false;

  const syncItem = itemId || String(lease.item_id || '').trim();
  const rackId = lease.rack_id != null ? String(lease.rack_id).trim() : '';
  const slotIndex = lease.slot_index != null && Number.isFinite(Number(lease.slot_index)) ? Math.floor(Number(lease.slot_index)) : null;

  if (lease.status === 'equipped') {
    await recordMiningEligibilityEvent(client, {
      userId,
      eventType: 'MINER_UNEQUIPPED',
      atMs: nowMs,
      identityKind: 'lease',
      leaseId: id,
      rackId: rackId || null,
      slotIndex,
      catalogItemId: syncItem || null,
      payload: { reason: 'unequip' }
    });
  }

  if (rackId && slotIndex != null) {
    await client.query(
      `UPDATE rack_slots SET machine_item_id = NULL, machine_lease_id = NULL
       WHERE rack_id = $1 AND slot_index = $2 AND machine_lease_id = $3`,
      [rackId, slotIndex, id]
    );
  }

  if (Number(lease.expires_at) <= nowMs) {
    await softExpireLeaseRow(client, userId, id, syncItem, nowMs, {
      acquired_at: Number(lease.acquired_at),
      expires_at: Number(lease.expires_at),
      previous_status: lease.status,
      rackId: rackId || null,
      slotIndex
    });
  } else {
    await client.query(`UPDATE player_asic_leases SET status = 'stock', rack_id = NULL, slot_index = NULL WHERE id = $1`, [id]);
    await mirrorInstanceLeaseState(client, id, ASIC_LEASE_STATUS_STOCK, null, null);
  }
  if (syncItem) await syncTimedAsicStockForItem(client, userId, syncItem, nowMs);
  return true;
}

export async function applyTimedStockQtyToSnapshot(client: PoolClient, userId: number, stock: Record<string, number>, itemId: string, nowMs: number): Promise<void> {
  const cntRes = await client.query(`SELECT COUNT(*)::int AS n FROM player_asic_leases WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3`, [userId, itemId, nowMs]);
  const qty = Number(cntRes.rows[0]?.n) || 0;
  if (qty > 0) stock[itemId] = qty;
  else delete stock[itemId];
}

export async function finalizeTimedMinerEquip(
  client: PoolClient,
  userId: number,
  rackId: string,
  slotIndex: number,
  catalogItemId: string,
  placedRacks: Array<{ id: string; slots?: string[]; slotLeaseIds?: string[] }>,
  stock: Record<string, number>,
  nowMs: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Timed ASICs: leases are the unit of ownership. Do NOT mint leases from stock
  // here — that raced / over-minted (leases >> stock). Missing leases are healed
  // offline / via purchase+reconcile paths that already own the stock write.
  const reserved = await reserveAsicLeaseForEquip(client, userId, catalogItemId, nowMs);
  if (!reserved.ok) return reserved;
  await markLeaseEquipped(client, reserved.leaseId, userId, rackId, slotIndex);
  await recordMiningEligibilityEvent(client, {
    userId,
    eventType: 'MINER_EQUIPPED',
    atMs: nowMs,
    identityKind: 'lease',
    leaseId: reserved.leaseId,
    rackId,
    slotIndex: Math.floor(slotIndex),
    catalogItemId,
    payload: null
  });
  const ri = placedRacks.findIndex((r) => r.id === rackId);
  if (ri >= 0) {
    const rack = placedRacks[ri]!;
    rack.slotLeaseIds = [...(rack.slotLeaseIds || [])];
    while (rack.slotLeaseIds.length <= slotIndex) rack.slotLeaseIds.push('');
    rack.slotLeaseIds[slotIndex] = reserved.leaseId;
  }
  await applyTimedStockQtyToSnapshot(client, userId, stock, catalogItemId, nowMs);
  return { ok: true };
}

/** Equip de GPU / ASIC vitalícia (sem lease): identidade por placement. */
export async function recordPlacementMinerEquipped(
  client: PoolClient,
  userId: number,
  rackId: string,
  slotIndex: number,
  catalogItemId: string,
  nowMs: number
): Promise<void> {
  await recordMiningEligibilityEvent(client, {
    userId,
    eventType: 'MINER_EQUIPPED',
    atMs: nowMs,
    identityKind: 'placement',
    leaseId: null,
    rackId,
    slotIndex: Math.floor(slotIndex),
    catalogItemId,
    payload: null
  });
}

/** Unequip de placement (GPU/vitalícia) quando não há lease — usa estado pré-limpeza. */
export async function recordPlacementMinerUnequipped(
  client: PoolClient,
  userId: number,
  rackId: string,
  slotIndex: number,
  catalogItemId: string,
  nowMs: number
): Promise<void> {
  const itemId = String(catalogItemId || '').trim();
  if (!itemId) return;
  await recordMiningEligibilityEvent(client, {
    userId,
    eventType: 'MINER_UNEQUIPPED',
    atMs: nowMs,
    identityKind: 'placement',
    leaseId: null,
    rackId,
    slotIndex: Math.floor(slotIndex),
    catalogItemId: itemId,
    payload: { reason: 'unequip' }
  });
}
