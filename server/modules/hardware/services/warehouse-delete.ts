/**
 * Apaga linhas de `stored_batteries` que não estão em `keepIds` e que **não** estão
 * montadas numa rig (`placed_racks.battery_id`). Antes de apagar, credita a qty
 * correspondente em `stock` (migração residual warehouse → stock-only).
 *
 * Ordem: correr antes de persistir o novo `placed_racks` no mesmo pedido.
 */
import type { PoolClient } from 'pg';

export async function deleteWarehouseStoredBatteriesExceptKeepIds(
  client: PoolClient,
  userId: number,
  keepIds: string[]
): Promise<void> {
  const keep = keepIds.length > 0 ? keepIds : [];

  // Credit stock for doomed loose rows, then delete them (mounted UUIDs protected).
  if (keep.length > 0) {
    await client.query(
      `WITH doomed AS (
         SELECT sb.id, sb.item_id
           FROM stored_batteries sb
          WHERE sb.user_id = $1
            AND NOT (sb.id = ANY($2::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM placed_racks pr
               WHERE pr.user_id = $1
                 AND pr.battery_id IS NOT NULL
                 AND btrim(pr.battery_id::text) <> ''
                 AND btrim(pr.battery_id::text) = btrim(sb.id::text)
            )
       ),
       credited AS (
         INSERT INTO stock (user_id, item_id, qty)
         SELECT $1, d.item_id, COUNT(*)::int
           FROM doomed d
          GROUP BY d.item_id
         ON CONFLICT (user_id, item_id) DO UPDATE
           SET qty = stock.qty + EXCLUDED.qty
         RETURNING item_id
       )
       DELETE FROM stored_batteries sb
        WHERE sb.id IN (SELECT id FROM doomed)`,
      [userId, keep]
    );
  } else {
    await client.query(
      `WITH doomed AS (
         SELECT sb.id, sb.item_id
           FROM stored_batteries sb
          WHERE sb.user_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM placed_racks pr
               WHERE pr.user_id = $1
                 AND pr.battery_id IS NOT NULL
                 AND btrim(pr.battery_id::text) <> ''
                 AND btrim(pr.battery_id::text) = btrim(sb.id::text)
            )
       ),
       credited AS (
         INSERT INTO stock (user_id, item_id, qty)
         SELECT $1, d.item_id, COUNT(*)::int
           FROM doomed d
          GROUP BY d.item_id
         ON CONFLICT (user_id, item_id) DO UPDATE
           SET qty = stock.qty + EXCLUDED.qty
         RETURNING item_id
       )
       DELETE FROM stored_batteries sb
        WHERE sb.id IN (SELECT id FROM doomed)`,
      [userId]
    );
  }
}
