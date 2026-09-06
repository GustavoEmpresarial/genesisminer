/**
 * Editor admin da roleta (`/api/admin/wheel/*`): catálogo completo de prémios
 * (todos, ativos e inativos, sem o filtro `tier` do sorteio real), config de
 * preço/limites (`wheel_config`), lista de jogadores com acesso liberado
 * (`wheel_players`).
 *
 * Migrado de legacy/backend/server.ts:2124-2275 +
 * legacy/backend/models/roletaModel.ts (`fetchWheelPrizesForAdminWheelEditor`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const TX_TIMEOUT_MS = 60_000;
const TX_MAX_WAIT_MS = 10_000;
const TIER_MAX_LENGTH = 32;
const DEFAULT_TIER = 'BASIC';
const WHEEL_CONFIG_ROW_ID = 1;
const CURRENCY_MAX_LENGTH = 12;
const MIN_SPIN_PRICE_USDC = '0.10';

export type AdminWheelPrizeRow = { id: string; label: string; color: string | null; weight: number; itemId: string; isActive: number; tier: string };

export async function fetchWheelPrizesForAdminWheelEditor(): Promise<AdminWheelPrizeRow[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; label: string; weight: number; color: string | null; item_id: string | null; is_active: number | null; tier: string | null }>>`
    SELECT id, label, weight, color, item_id, is_active, tier
    FROM wheel_prizes
    ORDER BY id ASC
  `;
  return rows.map((r) => ({
    id: String(r.id),
    label: String(r.label),
    color: r.color,
    weight: Number(r.weight),
    itemId: r.item_id != null ? String(r.item_id) : '',
    isActive: r.is_active == null ? 1 : Number(r.is_active),
    tier: r.tier != null ? String(r.tier) : DEFAULT_TIER
  }));
}

export type AdminWheelPrizeInput = { id: string; label: string; weight: number; color: string; itemId?: string | null; isActive?: unknown; tier?: string | null };

/** Substitui o catálogo inteiro (o editor sempre envia a lista completa). */
export async function replaceWheelPrizesCatalog(items: AdminWheelPrizeInput[]): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.wheel_prizes.deleteMany({});
      for (const item of items) {
        await tx.wheel_prizes.create({
          data: {
            id: String(item.id),
            label: String(item.label),
            weight: Number(item.weight),
            color: String(item.color),
            item_id: item.itemId != null && String(item.itemId).trim() !== '' ? String(item.itemId) : null,
            is_active: item.isActive === 0 || item.isActive === false ? 0 : 1,
            tier: item.tier != null && String(item.tier).trim() !== '' ? String(item.tier).slice(0, TIER_MAX_LENGTH) : DEFAULT_TIER
          }
        });
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
  );
}

export type AdminWheelRuntimeConfigDto = {
  spinPriceUsdc: number;
  minSpinPriceUsdc: number;
  currency: string;
  isEnabled: boolean;
  maxSpinsPerRequest: number;
  dailyLimit: number | null;
  cooldownSeconds: number;
  startsAtMs: string | null;
  endsAtMs: string | null;
  updatedAtMs: string;
};

export async function getAdminWheelRuntimeConfig(): Promise<AdminWheelRuntimeConfigDto> {
  const row = await prisma.wheel_config.findUnique({ where: { id: WHEEL_CONFIG_ROW_ID } });
  if (!row) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'wheel_config não encontrada' });
  }
  return {
    spinPriceUsdc: Number(row.spin_price_usdc),
    minSpinPriceUsdc: Number(row.min_spin_price_usdc),
    currency: row.currency,
    isEnabled: row.is_enabled === 1,
    maxSpinsPerRequest: row.max_spins_per_request,
    dailyLimit: row.daily_limit,
    cooldownSeconds: row.cooldown_seconds,
    startsAtMs: row.starts_at != null ? String(row.starts_at) : null,
    endsAtMs: row.ends_at != null ? String(row.ends_at) : null,
    updatedAtMs: String(row.updated_at)
  };
}

export type AdminWheelRuntimeConfigInput = {
  spinPriceUsdc?: unknown;
  minSpinPriceUsdc?: unknown;
  currency?: unknown;
  isEnabled?: unknown;
  maxSpinsPerRequest?: unknown;
  dailyLimit?: unknown;
  cooldownSeconds?: unknown;
};

export async function upsertAdminWheelRuntimeConfig(b: AdminWheelRuntimeConfigInput): Promise<void> {
  const floor = new Prisma.Decimal(MIN_SPIN_PRICE_USDC);
  const spinRaw = b.spinPriceUsdc;
  const minRaw = b.minSpinPriceUsdc ?? b.spinPriceUsdc;
  if (spinRaw == null) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'spinPriceUsdc obrigatório' });
  }
  const spinDec = new Prisma.Decimal(String(spinRaw));
  const minDec = new Prisma.Decimal(String(minRaw));
  if (spinDec.lt(floor) || minDec.lt(floor)) {
    throw new HttpControlledError(HTTP_UNPROCESSABLE, { error: 'Preço mínimo permitido: 0.10 USDC' });
  }
  const isEn = b.isEnabled === 0 || b.isEnabled === false ? 0 : 1;
  const maxSp = Number(b.maxSpinsPerRequest);
  const maxSpinsPerRequest = Number.isFinite(maxSp) && maxSp > 0 ? Math.floor(maxSp) : 1;
  const dailyLimit = b.dailyLimit === null || b.dailyLimit === undefined || b.dailyLimit === '' ? null : Math.max(0, Math.floor(Number(b.dailyLimit)));
  const cd = Number(b.cooldownSeconds);
  const cooldownSeconds = Number.isFinite(cd) && cd >= 0 ? Math.floor(cd) : 0;
  const currency = typeof b.currency === 'string' && b.currency.trim() ? b.currency.slice(0, CURRENCY_MAX_LENGTH) : 'USDC';
  const now = BigInt(Date.now());

  await prisma.wheel_config.upsert({
    where: { id: WHEEL_CONFIG_ROW_ID },
    create: {
      id: WHEEL_CONFIG_ROW_ID,
      spin_price_usdc: spinDec,
      min_spin_price_usdc: minDec,
      currency,
      is_enabled: isEn,
      max_spins_per_request: maxSpinsPerRequest,
      daily_limit: dailyLimit,
      cooldown_seconds: cooldownSeconds,
      starts_at: null,
      ends_at: null,
      updated_at: now,
      metadata_json: null
    },
    update: {
      spin_price_usdc: spinDec,
      min_spin_price_usdc: minDec,
      is_enabled: isEn,
      max_spins_per_request: maxSpinsPerRequest,
      daily_limit: dailyLimit,
      cooldown_seconds: cooldownSeconds,
      updated_at: now
    }
  });
}

export type AdminWheelPlayerRow = { username: string; addedAt: number };

export async function listAdminWheelPlayers(): Promise<AdminWheelPlayerRow[]> {
  const rows = await prisma.wheel_players.findMany({ orderBy: { added_at: 'desc' } });
  return rows.map((r) => ({ username: r.username, addedAt: Number(r.added_at) }));
}

export async function addAdminWheelPlayer(usernameRaw: unknown): Promise<void> {
  const username = typeof usernameRaw === 'string' ? usernameRaw.trim() : '';
  if (!username) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Username required' });
  }
  const at = BigInt(Date.now());
  await prisma.wheel_players.upsert({
    where: { username },
    create: { username, added_at: at },
    update: { added_at: at }
  });
}
