/**
 * Alinha `stored_batteries.status/location/rack_id/...` com `placed_racks` após
 * persistência de sala. Só incrementa `version` quando o estado semântico muda.
 *
 * Migrado de legacy/backend/modules/batteries/batterySemanticSync.ts, verbatim.
 */
import type { PoolClient } from 'pg';
import { PG_BATTERY_INSTANCE_UUID } from './invariant.js';

export async function syncStoredBatterySemanticsForUser(client: PoolClient, userId: number): Promise<void> {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  const uuidRe = PG_BATTERY_INSTANCE_UUID;

  await client.query(
    `
    UPDATE stored_batteries sb
       SET status = 'EQUIPPED',
           location = 'RACK',
           rack_id = pr.id,
           slot_id = COALESCE(pr.slot_index, 0),
           room_id = COALESCE(nullif(btrim(pr.room_id::text), ''), 'room_initial'),
           version = CASE
             WHEN sb.status IS DISTINCT FROM 'EQUIPPED'::text
               OR sb.location IS DISTINCT FROM 'RACK'::text
               OR sb.rack_id IS DISTINCT FROM pr.id::text
               OR sb.room_id IS DISTINCT FROM COALESCE(nullif(btrim(pr.room_id::text), ''), 'room_initial')::text
               OR sb.slot_id IS DISTINCT FROM COALESCE(pr.slot_index, 0)
             THEN COALESCE(sb.version, 0) + 1
             ELSE COALESCE(sb.version, 0)
           END,
           last_moved_at = CASE
             WHEN sb.status IS DISTINCT FROM 'EQUIPPED'::text
               OR sb.location IS DISTINCT FROM 'RACK'::text
               OR sb.rack_id IS DISTINCT FROM pr.id::text
             THEN NOW()
             ELSE sb.last_moved_at
           END,
           updated_at = NOW()
      FROM placed_racks pr
     WHERE sb.user_id = $1
       AND pr.user_id = sb.user_id
       AND pr.battery_id IS NOT NULL
       AND btrim(pr.battery_id::text) <> ''
       AND btrim(pr.battery_id::text) = btrim(sb.id::text)
       AND pr.battery_id::text ~* $2::text
  `,
    [uid, uuidRe]
  );

  await client.query(
    `
    UPDATE stored_batteries sb
       SET status = 'INVENTORY',
           location = 'WAREHOUSE',
           rack_id = NULL,
           slot_id = NULL,
           room_id = NULL,
           version = CASE
             WHEN sb.status IS DISTINCT FROM 'INVENTORY'::text
               OR sb.location IS DISTINCT FROM 'WAREHOUSE'::text
               OR sb.rack_id IS NOT NULL
               OR sb.slot_id IS NOT NULL
               OR sb.room_id IS NOT NULL
             THEN COALESCE(sb.version, 0) + 1
             ELSE COALESCE(sb.version, 0)
           END,
           last_moved_at = CASE
             WHEN sb.status IS DISTINCT FROM 'INVENTORY'::text
               OR sb.location IS DISTINCT FROM 'WAREHOUSE'::text
               OR sb.rack_id IS NOT NULL
             THEN NOW()
             ELSE sb.last_moved_at
           END,
           updated_at = NOW()
     WHERE sb.user_id = $1
       AND COALESCE(nullif(btrim(sb.status::text), ''), '') NOT IN ('BROKEN', 'CONSUMED', 'LOCKED')
       AND NOT EXISTS (
             SELECT 1 FROM placed_racks pr
              WHERE pr.user_id = sb.user_id
                AND pr.battery_id IS NOT NULL
                AND btrim(pr.battery_id::text) <> ''
                AND btrim(pr.battery_id::text) = btrim(sb.id::text)
                AND pr.battery_id::text ~* $2::text
           )
  `,
    [uid, uuidRe]
  );
}
