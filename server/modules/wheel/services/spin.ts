/**
 * Migrado de legacy/backend/models/roletaModel.ts — configuração + giro pago
 * atómico + giro/reivindicação por código promocional. `paidWheelRollInTransaction`
 * e `paidWheelClaimInTransaction` (fluxo legado de 2 passos, já documentado no
 * legado como substituído pelo giro atómico) NÃO foram portados — ver
 * docs/architecture/DECISIONS.md.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import {
  callWheelPaidSpin,
  isHardwareMarketError
} from '../../hardware/services/hardware-client.js';
import { queryWheelPrizeByItemIdJoined, queryWheelPrizesEligibleForRoll, pickWeightedPrize, type WheelPrizeRow } from './prizes.js';
import { promoCodeRowEligibleForRoletaFlow, throwIfPromoCodeExpired } from './promo-code.js';
import { sanitizeDisplayName } from './validation.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const DECIMAL_FIXED_DIGITS = 6;
const DISPLAY_NAME_MAX_LENGTH = 200;
const DEFAULT_WHEEL_CONFIG_ID = 1;
const DEFAULT_MAX_SPINS_PER_REQUEST = 1;
const DEFAULT_COOLDOWN_SECONDS = 0;
const LOCK_TIMEOUT_MS = 45_000;

/** Piso absoluto do preço do giro pago (USDC), independentemente da config em BD. */
export const WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC = new Prisma.Decimal('0.10');

/** Preço por defeito quando a linha `wheel_config` é criada em runtime (não confundir com o piso absoluto). */
export const WHEEL_DEFAULT_SPIN_PRICE_USDC = new Prisma.Decimal('1');

export type WheelRollResult = {
  wonItemId: string;
  item: WheelPrizeRow | null;
  /** true quando já existia `won_item_id` (repetição do endpoint). */
  idempotent: boolean;
};

export type RoletaClaimResult = {
  boxId: string;
  boxName: string;
};

export type PaidWheelAtomicSpinResult = {
  spinId: string;
  wonItemId: string;
  item: WheelPrizeRow | null;
  newUsdc: number;
  chargedUsdc: number;
  boxId: string;
  boxName: string;
  idempotentReplay: boolean;
};

/**
 * Garante pelo menos uma linha válida em `loot_box_items` para uma caixa de prémio da roleta
 * (`trigger = 'roleta_reward'`, `description = reward_for_<itemId>`). Idempotente.
 */
export async function ensureRoletaRewardBoxItem(tx: Prisma.TransactionClient, boxId: string, wonItemId: string): Promise<void> {
  const MIN_PROBABILITY = 100;
  const MIN_QTY = 1;
  const existing = await tx.loot_box_items.findFirst({
    where: { box_id: boxId, item_id: wonItemId, item_type: 'item' },
    select: { id: true, probability: true, min_qty: true, max_qty: true }
  });
  if (existing) {
    const probOk = Number(existing.probability) > 0;
    const minOk = Number(existing.min_qty) >= MIN_QTY;
    const maxOk = Number(existing.max_qty) >= Number(existing.min_qty || MIN_QTY);
    if (probOk && minOk && maxOk) return;
    await tx.loot_box_items.update({
      where: { id: existing.id },
      data: {
        probability: probOk ? Number(existing.probability) : MIN_PROBABILITY,
        min_qty: minOk ? Number(existing.min_qty) : MIN_QTY,
        max_qty: maxOk ? Number(existing.max_qty) : Math.max(MIN_QTY, Number(existing.min_qty) || MIN_QTY)
      }
    });
    return;
  }
  await tx.loot_box_items.create({
    data: { box_id: boxId, item_type: 'item', item_id: wonItemId, min_qty: MIN_QTY, max_qty: MIN_QTY, probability: MIN_PROBABILITY }
  });
}

/**
 * Cria ou reutiliza caixa `roleta_reward` e incrementa `unopened_boxes`. Reutilização sempre
 * passa por `ensureRoletaRewardBoxItem` para reparar caixas antigas órfãs.
 */
export async function grantWheelPrizeUnopenedBox(tx: Prisma.TransactionClient, userId: number, wonItemId: string): Promise<RoletaClaimResult> {
  const existing = await tx.loot_boxes.findFirst({
    where: { trigger: 'roleta_reward', description: `reward_for_${wonItemId}` },
    select: { id: true }
  });

  let prizeBoxId: string;
  if (existing?.id) {
    prizeBoxId = existing.id;
  } else {
    prizeBoxId = crypto.randomUUID();
    const upg = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM upgrades WHERE id = ${wonItemId} LIMIT 1`;
    const rawName = upg[0]?.name ?? wonItemId;
    const itemName = sanitizeDisplayName(String(rawName), DISPLAY_NAME_MAX_LENGTH);
    const boxName = `Prêmio: ${itemName}`;

    await tx.loot_boxes.create({
      data: { id: prizeBoxId, name: boxName, description: `reward_for_${wonItemId}`, price: 0, trigger: 'roleta_reward', icon: '🎁' }
    });
  }

  await ensureRoletaRewardBoxItem(tx, prizeBoxId, wonItemId);

  const boxRow = await tx.loot_boxes.findUnique({ where: { id: prizeBoxId }, select: { name: true } });
  const boxName = sanitizeDisplayName(String(boxRow?.name ?? 'Prêmio'), DISPLAY_NAME_MAX_LENGTH);

  await tx.unopened_boxes.upsert({
    where: { user_id_box_id: { user_id: userId, box_id: prizeBoxId } },
    create: { user_id: userId, box_id: prizeBoxId, qty: 1 },
    update: { qty: { increment: 1 } }
  });

  return { boxId: prizeBoxId, boxName };
}

async function loadWheelConfigRow(tx: Prisma.TransactionClient, nowMs: bigint) {
  let c = await tx.wheel_config.findUnique({ where: { id: DEFAULT_WHEEL_CONFIG_ID } });
  if (!c) {
    await tx.wheel_config.create({
      data: {
        id: DEFAULT_WHEEL_CONFIG_ID,
        spin_price_usdc: WHEEL_DEFAULT_SPIN_PRICE_USDC,
        currency: 'USDC',
        is_enabled: 1,
        min_spin_price_usdc: WHEEL_DEFAULT_SPIN_PRICE_USDC,
        max_spins_per_request: DEFAULT_MAX_SPINS_PER_REQUEST,
        daily_limit: null,
        cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
        starts_at: null,
        ends_at: null,
        updated_at: nowMs,
        metadata_json: null
      }
    });
    c = await tx.wheel_config.findUnique({ where: { id: DEFAULT_WHEEL_CONFIG_ID } });
  }
  if (!c) {
    throw new HttpControlledError(HTTP_INTERNAL_SERVER_ERROR, { error: 'Wheel configuration unavailable.' });
  }
  return c;
}

/** Preço efetivo do giro pago (Decimal): max(spin_price, min_config), depois piso absoluto 0,10 USDC. */
export function resolveEffectivePaidSpinPrice(spinPrice: Prisma.Decimal, minFromConfig: Prisma.Decimal): Prisma.Decimal {
  let eff = spinPrice.gt(minFromConfig) ? spinPrice : minFromConfig;
  if (eff.lt(WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC)) eff = WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC;
  return eff;
}

export async function getWheelPaidSpinPriceDecimal(tx: Prisma.TransactionClient, serverNowMs: number): Promise<Prisma.Decimal> {
  const c = await loadWheelConfigRow(tx, BigInt(serverNowMs));
  return resolveEffectivePaidSpinPrice(new Prisma.Decimal(c.spin_price_usdc.toString()), new Prisma.Decimal(c.min_spin_price_usdc.toString()));
}

export type WheelRuntimeConfigDto = {
  spinPriceUsdc: number;
  currency: string;
  isEnabled: boolean;
  minSpinPriceUsdc: number;
  maxSpinsPerRequest: number;
  dailyLimit: number | null;
  cooldownSeconds: number;
  startsAtMs: string | null;
  endsAtMs: string | null;
};

export async function fetchWheelRuntimeConfig(tx: Prisma.TransactionClient, nowMs: number): Promise<WheelRuntimeConfigDto> {
  const c = await loadWheelConfigRow(tx, BigInt(nowMs));
  const eff = await getWheelPaidSpinPriceDecimal(tx, nowMs);
  return {
    spinPriceUsdc: Number(eff.toFixed(DECIMAL_FIXED_DIGITS)),
    currency: String(c.currency || 'USDC'),
    isEnabled: c.is_enabled === 1,
    minSpinPriceUsdc: Number(new Prisma.Decimal(c.min_spin_price_usdc.toString()).toFixed(DECIMAL_FIXED_DIGITS)),
    maxSpinsPerRequest: c.max_spins_per_request ?? DEFAULT_MAX_SPINS_PER_REQUEST,
    dailyLimit: c.daily_limit ?? null,
    cooldownSeconds: c.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS,
    startsAtMs: c.starts_at != null ? String(c.starts_at) : null,
    endsAtMs: c.ends_at != null ? String(c.ends_at) : null
  };
}

/**
 * Giro pago atómico no worker (`POST /v1/wheel/paid-spin`): debita USDC, sorteia,
 * entrega caixa e regista histórico. Fail-closed — sem fallback Prisma money TX.
 */
export async function paidWheelSpinAtomic(args: {
  userId: number;
  serverNowMs: number;
  idempotencyKey: string;
}): Promise<PaidWheelAtomicSpinResult> {
  const { userId, serverNowMs, idempotencyKey } = args;
  try {
    const out = await callWheelPaidSpin({ userId, idempotencyKey, serverNowMs });
    const item =
      out.item && typeof out.item === 'object'
        ? ({
            id: String(out.item.id ?? ''),
            label: String(out.item.label ?? ''),
            weight: Number(out.item.weight) || 0,
            color: out.item.color != null ? String(out.item.color) : null,
            item_id: String(out.item.item_id ?? out.item.itemId ?? ''),
            image: out.item.image != null ? String(out.item.image) : null
          } satisfies WheelPrizeRow)
        : null;
    return {
      spinId: out.spinId,
      wonItemId: out.wonItemId,
      item,
      newUsdc: out.newUsdc,
      chargedUsdc: out.chargedUsdc,
      boxId: out.boxId,
      boxName: out.boxName,
      idempotentReplay: out.idempotentReplay
    };
  } catch (e) {
    if (isHardwareMarketError(e)) {
      throw new HttpControlledError(e.statusCode, e.jsonBody);
    }
    throw e;
  }
}

/** @deprecated Money TX is in genesis-hardware — do not nest inside Prisma `$transaction`. */
export async function paidWheelSpinAtomicInTransaction(
  _tx: Prisma.TransactionClient,
  _args: { userId: number; serverNowMs: number; idempotencyKey: string }
): Promise<never> {
  throw new Error(
    'paidWheelSpinAtomicInTransaction removed: money TX is POST /v1/wheel/paid-spin. Call paidWheelSpinAtomic without a Prisma money transaction.'
  );
}

/**
 * Giro por código promocional. Exige transação ativa. Bloqueia linha de resgate (`FOR UPDATE`)
 * para evitar corrida em roll/claim.
 */
export async function wheelRollInTransaction(
  tx: Prisma.TransactionClient,
  args: { userId: number; normalizedCode: string; serverNowMs: number }
): Promise<WheelRollResult> {
  const { userId, normalizedCode, serverNowMs } = args;
  await tx.$executeRaw(Prisma.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`));

  const redRes = await tx.$queryRaw<Array<{ reward_granted: number | null; won_item_id: string | null }>>`
    SELECT reward_granted, won_item_id FROM promo_code_redemptions WHERE code = ${normalizedCode} AND user_id = ${userId} FOR UPDATE
  `;
  if (redRes.length === 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'You must redeem the code first.' });
  }
  const redemption = redRes[0]!;
  if (redemption.reward_granted === 1) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'This code has been fully used.' });
  }

  const prowRows = await tx.$queryRaw<Array<{ type: string; loot_box_id: string | null; expires_at: bigint | null }>>`
    SELECT type, loot_box_id, expires_at FROM promo_codes WHERE code = ${normalizedCode} LIMIT 1
  `;
  const prow = prowRows[0];
  if (prow) throwIfPromoCodeExpired(prow, serverNowMs);
  const wheelOk = prow ? await promoCodeRowEligibleForRoletaFlow(tx, prow) : false;
  if (!wheelOk) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'This code does not allow a wheel spin.' });
  }

  if (redemption.won_item_id) {
    const item = await queryWheelPrizeByItemIdJoined(tx, String(redemption.won_item_id));
    return { wonItemId: String(redemption.won_item_id), item, idempotent: true };
  }

  const prizes = await queryWheelPrizesEligibleForRoll(tx);
  if (prizes.length === 0) {
    throw new HttpControlledError(HTTP_INTERNAL_SERVER_ERROR, { error: 'Wheel configuration not found.' });
  }
  const selected = pickWeightedPrize(prizes);

  const upd = await tx.promo_code_redemptions.updateMany({
    where: { code: normalizedCode, user_id: userId, won_item_id: null, reward_granted: 0 },
    data: { won_item_id: selected.item_id, roulette_rolled_at: BigInt(serverNowMs) }
  });

  if (upd.count === 0) {
    const again = await tx.promo_code_redemptions.findUnique({
      where: { code_user_id: { code: normalizedCode, user_id: userId } },
      select: { won_item_id: true }
    });
    const wid = again?.won_item_id;
    if (wid) {
      const item = await queryWheelPrizeByItemIdJoined(tx, String(wid));
      return { wonItemId: String(wid), item, idempotent: true };
    }
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'Could not record the spin. Try again.' });
  }

  return { wonItemId: selected.item_id, item: selected, idempotent: false };
}

export async function roletaClaimInTransaction(
  tx: Prisma.TransactionClient,
  args: { userId: number; normalizedCode: string; wonItemId: string; serverNowMs: number }
): Promise<RoletaClaimResult> {
  const { userId, normalizedCode, wonItemId, serverNowMs } = args;
  await tx.$executeRaw(Prisma.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`));

  const redRes = await tx.$queryRaw<Array<{ reward_granted: number | null; won_item_id: string | null }>>`
    SELECT reward_granted, won_item_id FROM promo_code_redemptions WHERE code = ${normalizedCode} AND user_id = ${userId} FOR UPDATE
  `;
  if (redRes.length === 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Code not redeemed.' });
  }
  const redemption = redRes[0]!;
  if (redemption.reward_granted === 1) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Reward already claimed.' });
  }
  if (!redemption.won_item_id) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'You must spin the wheel first.' });
  }
  if (String(redemption.won_item_id) !== String(wonItemId)) {
    throw new HttpControlledError(HTTP_FORBIDDEN, { error: 'Draw integrity violated. Claimed item does not match the drawn item.' });
  }

  const codeRows = await tx.$queryRaw<Array<{ type: string; loot_box_id: string | null; expires_at: bigint | null }>>`
    SELECT type, loot_box_id, expires_at FROM promo_codes WHERE code = ${normalizedCode} LIMIT 1
  `;
  const promo = codeRows[0];
  if (promo) throwIfPromoCodeExpired(promo, serverNowMs);
  const claimOk = promo ? await promoCodeRowEligibleForRoletaFlow(tx, promo) : false;
  if (!claimOk) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid code type.' });
  }

  const granted = await tx.promo_code_redemptions.updateMany({
    where: { code: normalizedCode, user_id: userId, reward_granted: 0 },
    data: { reward_granted: 1, roulette_claimed_at: BigInt(serverNowMs) }
  });
  if (granted.count === 0) {
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'Failed to finalize code redemption (no rows updated).' });
  }

  /** Claim slot reserved first — crash mid-txn rolls back; retry cannot double-grant. */
  return grantWheelPrizeUnopenedBox(tx, userId, wonItemId);
}
