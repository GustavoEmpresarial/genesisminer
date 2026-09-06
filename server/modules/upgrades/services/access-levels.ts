/**
 * Selos de membership (`access_level_id` actual + `user_access_levels`) do
 * utilizador — usados por `services/state.ts` (o que mostrar) e
 * `services/purchase.ts` (o que ele pode de facto comprar).
 *
 * Extraído de legacy/backend/modules/upgrades/upgradesState.service.ts
 * (a lógica de `levelIds` estava inline em `buildUpgradesStatePayload`).
 */
import { prisma } from '../../../core/database/prisma.js';

export async function resolveUserAccessLevelIds(userId: number): Promise<Set<string>> {
  const [user, grants] = await Promise.all([
    prisma.users.findUnique({ where: { id: userId }, select: { access_level_id: true } }),
    prisma.user_access_levels.findMany({ where: { user_id: userId }, select: { access_level_id: true } })
  ]);
  const levelIds = new Set<string>();
  if (user?.access_level_id) levelIds.add(String(user.access_level_id));
  for (const r of grants) levelIds.add(String(r.access_level_id));
  return levelIds;
}
