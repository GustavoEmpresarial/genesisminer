/**
 * Grant/revoke admin de `user_rig_rooms`. Ao revogar, desmonta racks da sala
 * e devolve-os ao estoque (persist sem `stock` → recovery).
 */
import type { Pool, PoolClient } from 'pg';
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { callHardwarePersist } from '../../../hardware/services/hardware-client.js';
import {
  loadUserPlacedRacksWithSlots,
  type PlacedRackLoaded
} from '../../../hardware/services/persistence.js';
import { EXTRA_ROOM_ID } from '../../../mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../../mining-engine/services/room-kind.js';
import {
  computeOwnedRoomDiff,
  ensureOwnedRoomIds,
  partitionRacksForRoomRevoke,
  roomIdsFromPlacedRacks
} from './owned-rooms-diff.js';

/** Grants em `user_rig_rooms` (Inicial não precisa de linha). */
const DEFAULT_PLAYER_GRANT_ROOM_IDS = [ASIC_ROOM_ID, EXTRA_ROOM_ID] as const;

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
/** Flag activa em `rig_rooms.is_active` (Int no schema). */
const RIG_ROOM_ACTIVE = 1;
/** Extra slots no grant admin; 0 = `initial_capacity` do catálogo. */
const ADMIN_GRANT_UNLOCKED_SLOTS = 0;

const ERR_USER_ID = { error: 'Invalid user id.', code: 'VALIDATION' };
const ERR_USER_NOT_FOUND = { error: 'Utilizador não encontrado.', code: 'NOT_FOUND' };

export type ApplyAdminOwnedRoomsInput = {
  userId: number;
  roomIds: string[];
  pool: Pool;
};

export type ApplyAdminOwnedRoomsResult = {
  ok: true;
  ownedRoomIds: string[];
  removedRackCount: number;
};

function isValidUserId(userId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0;
}

async function loadActiveRoomIds(): Promise<Set<string>> {
  const rows = await prisma.rig_rooms.findMany({
    where: { is_active: RIG_ROOM_ACTIVE },
    select: { id: true }
  });
  return new Set(rows.map((r) => String(r.id).trim()).filter(Boolean));
}

async function loadCurrentOwnedRoomIds(userId: number): Promise<string[]> {
  const rows = await prisma.user_rig_rooms.findMany({
    where: { user_id: userId },
    select: { room_id: true }
  });
  return rows.map((r) => String(r.room_id));
}

async function loadPlacedRackRoomIds(userId: number): Promise<string[]> {
  const rows = await prisma.placed_racks.findMany({
    where: { user_id: userId },
    select: { room_id: true }
  });
  return roomIdsFromPlacedRacks(rows.map((r) => ({ roomId: r.room_id })));
}

async function insertRoomGrants(
  client: PoolClient,
  userId: number,
  roomIds: string[],
  purchasedAt: number
): Promise<void> {
  for (const roomId of roomIds) {
    await client.query(
      `INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, room_id) DO NOTHING`,
      [userId, roomId, purchasedAt, ADMIN_GRANT_UNLOCKED_SLOTS]
    );
  }
}

async function deleteRoomGrants(client: PoolClient, userId: number, roomIds: string[]): Promise<void> {
  await client.query(`DELETE FROM user_rig_rooms WHERE user_id = $1 AND room_id = ANY($2::text[])`, [
    userId,
    roomIds
  ]);
}

async function loadOwnedRoomIdsFromClient(client: PoolClient, userId: number): Promise<string[]> {
  const res = await client.query('SELECT room_id FROM user_rig_rooms WHERE user_id = $1', [userId]);
  return ensureOwnedRoomIds((res.rows as Array<{ room_id: string }>).map((r) => r.room_id));
}

async function revokeRoomsAndReturnRacks(
  client: PoolClient,
  userId: number,
  toRemove: string[]
): Promise<number> {
  const racks: PlacedRackLoaded[] = await loadUserPlacedRacksWithSlots(client, userId);
  const { keep, removed } = partitionRacksForRoomRevoke(racks, toRemove);
  await callHardwarePersist({ userId, placedRacks: keep });
  await deleteRoomGrants(client, userId, toRemove);
  return removed.length;
}

export async function applyAdminOwnedRooms(
  input: ApplyAdminOwnedRoomsInput
): Promise<ApplyAdminOwnedRoomsResult> {
  const { userId, roomIds, pool } = input;
  if (!isValidUserId(userId)) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, ERR_USER_ID);
  }

  const user = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    throw new HttpControlledError(HTTP_NOT_FOUND, ERR_USER_NOT_FOUND);
  }

  const desiredIds = Array.isArray(roomIds) ? roomIds : [];
  const [activeIds, urrIds, rackRoomIds] = await Promise.all([
    loadActiveRoomIds(),
    loadCurrentOwnedRoomIds(userId),
    loadPlacedRackRoomIds(userId)
  ]);
  const currentIds = [...urrIds, ...rackRoomIds];
  const { toAdd, toRemove } = computeOwnedRoomDiff({ currentIds, desiredIds, activeIds });
  const urrSet = new Set(urrIds.map((id) => String(id).trim()).filter(Boolean));
  for (const id of DEFAULT_PLAYER_GRANT_ROOM_IDS) {
    if (activeIds.has(id) && !urrSet.has(id) && !toAdd.includes(id)) toAdd.push(id);
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return {
      ok: true,
      ownedRoomIds: ensureOwnedRoomIds(currentIds),
      removedRackCount: 0
    };
  }

  const client = await pool.connect();
  let removedRackCount = 0;
  try {
    await client.query('BEGIN');
    if (toAdd.length > 0) {
      await insertRoomGrants(client, userId, toAdd, Date.now());
    }
    if (toRemove.length > 0) {
      removedRackCount = await revokeRoomsAndReturnRacks(client, userId, toRemove);
    }
    const ownedRoomIds = await loadOwnedRoomIdsFromClient(client, userId);
    await client.query('COMMIT');
    return { ok: true, ownedRoomIds, removedRackCount };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}
