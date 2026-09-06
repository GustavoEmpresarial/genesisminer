/**
 * Migrado de legacy/backend/models/promoRedeemModel.ts. `grantAdminUpgradeRewards`
 * (entrega direta de itens/moedas/passes) foi substituída por
 * `materializeUpgradePackageAsLootBoxInTx` (modules/upgrades/services/grant.ts):
 * em vez de creditar direto, materializa uma caixa e credita `unopened_boxes`
 * — mesmo padrão já usado pela compra de pacotes de upgrade em `current/server`.
 * Efeito para o jogador é equivalente (recebe a recompensa), a única mudança é
 * que o conteúdo do `admin_upgrade_id` chega como 1 caixa por abrir, não direto.
 */
import { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { callHardwareCredit } from '../../hardware/services/hardware-client.js';
import { materializeUpgradePackageAsLootBoxInTx } from '../../upgrades/services/grant.js';
import { promoCodeRowEligibleForRoletaFlow, throwIfPromoCodeExpired } from './promo-code.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const LOCK_TIMEOUT_MS = 45_000;

export type PromoRedeemTransactionResult =
  | { kind: 'roleta_new'; code: string; serverNowMs: number }
  | { kind: 'roleta_reentry'; code: string }
  | {
      kind: 'standard';
      unopenedBoxes: Record<string, number>;
      stock: Record<string, number>;
      lootBoxId: string | null;
      upgradeId: string | null;
      adminUpgradeId: string | null;
    };

type PromoRow = {
  code: string;
  loot_box_id: string | null;
  upgrade_id: string | null;
  admin_upgrade_id: string | null;
  type: string;
  is_active: number | null;
  expires_at?: bigint | number | null;
};

function promoRowFromPrisma(p: {
  code: string;
  loot_box_id: string | null;
  upgrade_id: string | null;
  admin_upgrade_id: string | null;
  type: string;
  is_active: number | null;
  expires_at: bigint | null;
}): PromoRow {
  return {
    code: p.code,
    loot_box_id: p.loot_box_id,
    upgrade_id: p.upgrade_id,
    admin_upgrade_id: p.admin_upgrade_id,
    type: p.type,
    is_active: p.is_active,
    expires_at: p.expires_at
  };
}

function mapRawPromoRow(r: Record<string, unknown>): PromoRow {
  return {
    code: String(r.code),
    loot_box_id: (r.loot_box_id as string | null) ?? null,
    upgrade_id: (r.upgrade_id as string | null) ?? null,
    admin_upgrade_id: (r.admin_upgrade_id as string | null) ?? null,
    type: String(r.type),
    is_active: r.is_active == null ? null : Number(r.is_active),
    expires_at: r.expires_at as bigint | number | null | undefined
  };
}

/** Corpo da transação de resgate (dentro de `prisma.$transaction`). */
export async function runPromoCodeRedeemInTransaction(
  tx: Prisma.TransactionClient,
  args: { userId: number; normalizedCode: string; serverNowMs: number }
): Promise<PromoRedeemTransactionResult> {
  const { userId, normalizedCode, serverNowMs } = args;
  await tx.$executeRaw(Prisma.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`));
  /** Serializa resgates do mesmo (user, code) — PK ainda é a garantia económica. */
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('promo_redeem'), hashtext(${`${userId}:${normalizedCode}`}))
  `;

  const promoRow = await tx.promo_codes.findUnique({ where: { code: normalizedCode } });
  let promo = promoRow ? promoRowFromPrisma(promoRow) : undefined;

  if (!promo) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Invalid code' });
  }
  if (!promo.is_active) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Code disabled' });
  }
  throwIfPromoCodeExpired(promo, serverNowMs);

  const treatAsRoleta = await promoCodeRowEligibleForRoletaFlow(tx, promo);

  const isSingleUseType = promo.type === 'global_once' || promo.type === 'roleta_global_1x' || promo.type === 'roleta_player_1x';

  if (isSingleUseType) {
    const locked = await tx.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM promo_codes WHERE code = ${normalizedCode} FOR UPDATE`;
    const raw = locked[0];
    if (!raw) {
      throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Invalid code' });
    }
    promo = mapRawPromoRow(raw);
    if (!promo.is_active) {
      throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Expired.' });
    }
    throwIfPromoCodeExpired(promo, serverNowMs);

    const globalRedeem = await tx.promo_code_redemptions.findFirst({ where: { code: promo.code }, select: { code: true } });
    if (globalRedeem) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'This code has already been redeemed.' });
    }
  }

  const existingUserRedeem = await tx.promo_code_redemptions.findUnique({
    where: { code_user_id: { code: promo.code, user_id: userId } },
    select: { reward_granted: true }
  });
  if (existingUserRedeem) {
    const rg = existingUserRedeem.reward_granted ?? 1;
    if (treatAsRoleta && rg === 0) {
      return { kind: 'roleta_reentry', code: promo.code };
    }
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'You have already redeemed this code.' });
  }

  const redeemedAt = BigInt(serverNowMs);

  try {
    if (treatAsRoleta) {
      await tx.promo_code_redemptions.create({ data: { code: promo.code, user_id: userId, redeemed_at: redeemedAt, reward_granted: 0 } });
      return { kind: 'roleta_new', code: promo.code, serverNowMs };
    }

    await tx.promo_code_redemptions.create({ data: { code: promo.code, user_id: userId, redeemed_at: redeemedAt } });
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
    if (code === 'P2002') {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'You have already redeemed this code.' });
    }
    throw e;
  }
  if (promo.loot_box_id) {
    const bid = String(promo.loot_box_id).trim();
    await tx.unopened_boxes.upsert({
      where: { user_id_box_id: { user_id: userId, box_id: bid } },
      create: { user_id: userId, box_id: bid, qty: 1 },
      update: { qty: { increment: 1 } }
    });
  } else if (promo.upgrade_id) {
    const iid = String(promo.upgrade_id).trim();
    await callHardwareCredit({ userId, itemId: iid, qty: 1 });
  } else if (promo.admin_upgrade_id) {
    await materializeUpgradePackageAsLootBoxInTx(tx, { userId, upgradeId: String(promo.admin_upgrade_id).trim() });
  }

  if (promo.type === 'global_once') {
    await tx.promo_codes.update({ where: { code: normalizedCode }, data: { is_active: 0 } });
  }

  const boxesRes = await tx.unopened_boxes.findMany({ where: { user_id: userId }, select: { box_id: true, qty: true } });
  const unopenedBoxes: Record<string, number> = {};
  for (const r of boxesRes) {
    unopenedBoxes[r.box_id] = r.qty;
  }

  const stockRes = await tx.stock.findMany({ where: { user_id: userId }, select: { item_id: true, qty: true } });
  const stock: Record<string, number> = {};
  for (const r of stockRes) {
    stock[r.item_id] = r.qty;
  }

  return {
    kind: 'standard',
    unopenedBoxes,
    stock,
    lootBoxId: promo.loot_box_id,
    upgradeId: promo.upgrade_id,
    adminUpgradeId: promo.admin_upgrade_id
  };
}
