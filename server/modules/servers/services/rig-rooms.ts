/**
 * Salas de rigs visíveis para o utilizador.
 *
 * **Sala ≠ plano.** `access_levels` = planos/membership; `rig_rooms` = pisos.
 * Gate: coluna DB `allowed_levels` → JSON `allowedPlanIds` (+ season pass /
 * já possuída / racks colocados).
 *
 * Migrado de legacy/backend/lib/meUpgradeShopBundlePayload.ts (`loadMyRigRoomsForUser`).
 */
import pool from '../../../core/database/pool.js';
import { isNftAutoArmario1OnlyRoomRow } from '../../mining-engine/services/nft-room-mining.js';
import { ensureUserHasDefaultPlayerRooms } from '../../rooms/services/grant-default-asic-room.js';
import { isRoomAccessAllowedForUser, resolveUserRoomAccess } from '../../rooms/services/rooms.js';

export async function loadMyRigRoomsForUser(uid: number): Promise<unknown[]> {
  await ensureUserHasDefaultPlayerRooms(uid);
  const access = await resolveUserRoomAccess(uid);

  const racksRoomRes = await pool.query(
    `SELECT DISTINCT
       CASE
         WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = '' OR BTRIM(room_id) = 'main' THEN 'room_initial'
         ELSE BTRIM(room_id)
       END AS room_id
     FROM placed_racks WHERE user_id = $1`,
    [uid]
  );
  const roomIdsWithPlacedRacks = new Set(racksRoomRes.rows.map((row: { room_id: string }) => row.room_id));

  const rowsRes = await pool.query(
    `SELECT
       rr.id, rr.name, rr.initial_capacity, rr.max_capacity, rr.base_slot_price, rr.slot_price_increase_percent,
       rr.allowed_levels, rr.allowed_season_pass_ids, rr.is_active, rr.sort_order,
       urr.purchased_at, urr.unlocked_slots
     FROM rig_rooms rr
     LEFT JOIN user_rig_rooms urr ON urr.room_id = rr.id AND urr.user_id = $1
     ORDER BY rr.sort_order ASC`,
    [uid]
  );

  const list = rowsRes.rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    initialCapacity: r.initial_capacity,
    maxCapacity: r.max_capacity,
    baseSlotPrice: r.base_slot_price,
    slotPriceIncreasePercent: r.slot_price_increase_percent,
    allowedPlanIds: r.allowed_levels
      ? (() => {
          try {
            return JSON.parse(String(r.allowed_levels)) as unknown[];
          } catch {
            return [];
          }
        })()
      : [],
    allowedSeasonPassIds: r.allowed_season_pass_ids
      ? (() => {
          try {
            return JSON.parse(String(r.allowed_season_pass_ids)) as unknown[];
          } catch {
            return [];
          }
        })()
      : [],
    isActive: !!r.is_active,
    sortOrder: r.sort_order,
    owned: !!r.purchased_at,
    unlockedSlots: r.unlocked_slots || 0,
    nftAutoArmario1Only: isNftAutoArmario1OnlyRoomRow(r as { id?: unknown; name?: unknown })
  }));

  return list.filter((r) => {
    const row = r as { allowedPlanIds: unknown[]; allowedSeasonPassIds: unknown[]; owned: boolean; id: string };
    const roomAccess = {
      allowedPlanIds: (Array.isArray(row.allowedPlanIds) ? row.allowedPlanIds : []).map(String),
      allowedSeasonPassIds: (Array.isArray(row.allowedSeasonPassIds) ? row.allowedSeasonPassIds : []).map(String)
    };
    const hasRacksHere = roomIdsWithPlacedRacks.has(row.id);
    return row.owned || hasRacksHere || isRoomAccessAllowedForUser(roomAccess, access);
  });
}
