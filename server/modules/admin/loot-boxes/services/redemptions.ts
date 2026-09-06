/**
 * Resgates de códigos promo ligados a uma loot box (`promo_codes.loot_box_id`).
 * Usado pelo painel admin em `/admin/lootboxes` (trigger Código de Resgate).
 */
import { prisma } from '../../../../core/database/prisma.js';

export type LootBoxRedemptionRow = {
  code: string;
  /** `per_player` | `global_once` (valor de `promo_codes.type`) */
  type: string;
  username: string;
  redeemedAt: number;
};

function displayUsername(user: { id: number; username: string; email: string } | undefined, userId: number): string {
  const name = user?.username?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  return `user_${userId}`;
}

/** Lista resgates de promo codes da caixa, mais recentes primeiro. Sem LIMIT artificial. */
export async function listLootBoxRedemptions(boxId: string): Promise<LootBoxRedemptionRow[]> {
  const codes = await prisma.promo_codes.findMany({
    where: { loot_box_id: boxId },
    select: { code: true, type: true }
  });
  if (codes.length === 0) return [];

  const typeByCode = new Map(codes.map((c) => [c.code, c.type]));
  const codeList = codes.map((c) => c.code);

  const redemptions = await prisma.promo_code_redemptions.findMany({
    where: { code: { in: codeList } },
    orderBy: { redeemed_at: 'desc' },
    select: { code: true, user_id: true, redeemed_at: true }
  });
  if (redemptions.length === 0) return [];

  const userIds = [...new Set(redemptions.map((r) => r.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, email: true }
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  return redemptions.map((r) => ({
    code: r.code,
    type: typeByCode.get(r.code) ?? '',
    username: displayUsername(userById.get(r.user_id), r.user_id),
    redeemedAt: Number(r.redeemed_at)
  }));
}
