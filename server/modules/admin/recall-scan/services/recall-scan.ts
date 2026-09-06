/**
 * GET /api/admin/recall-scan — levantamento read-only de itens instalados.
 *
 * Migrado de `legacy/backend/server.ts`. Sem INSERT/UPDATE/DELETE.
 * O POST destrutivo `recall-all-players-items` NÃO está neste módulo.
 *
 * Otimização vs N+1 do legado: mesmas contas (rig + wiring + battery +
 * slots com machine + multipliers com item), 5 queries no total, ordem do
 * summary = ordem do GROUP BY (sem ORDER BY, como o legado).
 */
import { prisma } from '../../../../core/database/prisma.js';

export type RecallScanUserRow = {
  userId: number;
  username: string;
  racksCount: number;
  totalItems: number;
};

export type RecallScanDto = {
  ok: true;
  summary: RecallScanUserRow[];
  totalUsersChecked: number;
};

export type RecallRackRow = {
  id: string;
  user_id: number;
  wiring_id: string | null;
  battery_id: string | null;
};

export function computeRecallItemCount(
  racks: RecallRackRow[],
  slotCountByRack: Map<string, number>,
  multiCountByRack: Map<string, number>
): number {
  let totalItems = racks.length;
  for (const rack of racks) {
    if (rack.wiring_id) totalItems++;
    if (rack.battery_id) totalItems++;
    totalItems += slotCountByRack.get(rack.id) || 0;
    totalItems += multiCountByRack.get(rack.id) || 0;
  }
  return totalItems;
}

type UserRackCountRow = { user_id: number; username: string; racks_count: unknown };

export async function scanRecallInstalledItems(): Promise<RecallScanDto> {
  const [totalUsers, userRackRows] = await Promise.all([
    prisma.users.count(),
    prisma.$queryRaw<UserRackCountRow[]>`
      SELECT u.id AS user_id, u.username, COUNT(pr.id) AS racks_count
      FROM users u
      LEFT JOIN placed_racks pr ON u.id = pr.user_id
      GROUP BY u.id, u.username
      HAVING COUNT(pr.id) > 0
    `
  ]);

  if (userRackRows.length === 0) {
    return { ok: true, summary: [], totalUsersChecked: totalUsers };
  }

  const userIds = userRackRows.map((r) => r.user_id);
  const racks = await prisma.placed_racks.findMany({
    where: { user_id: { in: userIds } },
    select: { id: true, user_id: true, wiring_id: true, battery_id: true }
  });

  const rackIds = racks.map((r) => r.id);
  const [slotGroups, multiGroups] =
    rackIds.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.rack_slots.groupBy({
            by: ['rack_id'],
            where: { rack_id: { in: rackIds }, machine_item_id: { not: null } },
            _count: { _all: true }
          }),
          prisma.rack_multiplier_slots.groupBy({
            by: ['rack_id'],
            where: { rack_id: { in: rackIds }, multiplier_item_id: { not: null } },
            _count: { _all: true }
          })
        ]);

  const slotCountByRack = new Map<string, number>();
  for (const g of slotGroups) slotCountByRack.set(g.rack_id, g._count._all);
  const multiCountByRack = new Map<string, number>();
  for (const g of multiGroups) multiCountByRack.set(g.rack_id, g._count._all);

  const racksByUser = new Map<number, RecallRackRow[]>();
  for (const r of racks) {
    const list = racksByUser.get(r.user_id) || [];
    list.push(r);
    racksByUser.set(r.user_id, list);
  }

  const summary: RecallScanUserRow[] = userRackRows.map((row) => {
    const racksCount = parseInt(String(row.racks_count), 10) || 0;
    const userRacks = racksByUser.get(row.user_id) || [];
    return {
      userId: row.user_id,
      username: row.username,
      racksCount,
      totalItems: computeRecallItemCount(userRacks, slotCountByRack, multiCountByRack)
    };
  });

  return { ok: true, summary, totalUsersChecked: totalUsers };
}
