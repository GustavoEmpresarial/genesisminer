/**
 * Concede salas default do jogador (ASICs + EXTRA) em `user_rig_rooms`.
 *
 * Ambas estão locked a `__admin_grant_only__`; sem linha o catálogo esconde-as.
 * `unlocked_slots = 0` → capacidade efetiva = `initial_capacity` da sala.
 */
import { prisma } from '../../../core/database/prisma.js';
import { EXTRA_ROOM_ID } from '../../mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../mining-engine/services/room-kind.js';

export const DEFAULT_ASIC_UNLOCKED_SLOTS = 0;

/** Salas com grant em `user_rig_rooms` no signup (Inicial não precisa de linha). */
const DEFAULT_PLAYER_GRANT_ROOM_IDS = [ASIC_ROOM_ID, EXTRA_ROOM_ID] as const;

function isValidUserId(userId: number): boolean {
  return Number.isInteger(userId) && userId > 0;
}

export async function ensureUserHasDefaultPlayerRooms(userId: number): Promise<void> {
  if (!isValidUserId(userId)) return;
  const purchasedAt = BigInt(Date.now());
  await prisma.user_rig_rooms.createMany({
    data: DEFAULT_PLAYER_GRANT_ROOM_IDS.map((room_id) => ({
      user_id: userId,
      room_id,
      purchased_at: purchasedAt,
      unlocked_slots: DEFAULT_ASIC_UNLOCKED_SLOTS
    })),
    skipDuplicates: true
  });
}

/** @deprecated alias — prefer `ensureUserHasDefaultPlayerRooms`. */
export const ensureUserHasDefaultAsicRoom = ensureUserHasDefaultPlayerRooms;
