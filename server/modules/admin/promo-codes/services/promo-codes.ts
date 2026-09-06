/**
 * CRUD admin de `promo_codes` (list/create/delete/toggle/bulk-delete).
 *
 * Migrado de `legacy/backend/server.ts`. Create não concede itens/moedas —
 * só INSERT/UPSERT na tabela de códigos. Resgate continua no módulo wheel.
 *
 * GET lista: 3 consultas (códigos + counts + últimos 5), não N+1.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;
const MAX_EXPIRES_YEARS = 10;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const MAX_BULK_DELETE = 2000;
const CODE_RE = /^[A-Z0-9_-]{4,40}$/;
const LAST_REDEMPTIONS_LIMIT = 5;

export type PromoLastRedemptionDto = {
  userName: string | null;
  redeemedAt: number;
};

export type PromoCodeAdminDto = {
  code: string;
  loot_box_id: string | null;
  upgrade_id: string | null;
  admin_upgrade_id: string | null;
  type: string;
  is_active: number | null;
  created_at: number;
  expires_at: number | null;
  lootBoxId: string | null;
  upgradeId: string | null;
  adminUpgradeId: string | null;
  isActive: boolean;
  createdAt: number;
  expiresAt?: number;
  redemptionsCount: number;
  lastRedemptions: PromoLastRedemptionDto[];
};

export type PromoCodeRow = {
  code: string;
  loot_box_id: string | null;
  upgrade_id: string | null;
  admin_upgrade_id: string | null;
  type: string;
  is_active: number | null;
  created_at: unknown;
  expires_at: unknown;
};

export type CreatePromoPlan = {
  code: string;
  lootBoxId: string | null;
  upgradeId: string | null;
  adminUpgradeId: string | null;
  type: string;
  createdAt: number;
  expiresAt: number | null;
};

export function planCreatePromoCode(body: unknown, now = Date.now()): CreatePromoPlan {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = b.code;
  const lootBoxId = b.lootBoxId;
  const upgradeId = b.upgradeId;
  const adminUpgradeId = b.adminUpgradeId;
  if (!code || (!lootBoxId && !upgradeId && !adminUpgradeId)) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, {
      error: 'Faltam campos (é necessário uma caixa, um upgrade ou um pacote)'
    });
  }
  let expMs: number | null = null;
  const expiresAt = b.expiresAt;
  if (expiresAt != null && expiresAt !== '') {
    const n = typeof expiresAt === 'number' ? expiresAt : parseInt(String(expiresAt), 10);
    if (Number.isFinite(n) && n > now) {
      const max = now + MAX_EXPIRES_YEARS * MS_PER_YEAR;
      expMs = Math.min(Math.floor(n), Math.floor(max));
    }
  }
  return {
    code: String(code),
    lootBoxId: lootBoxId ? String(lootBoxId) : null,
    upgradeId: upgradeId ? String(upgradeId) : null,
    adminUpgradeId: adminUpgradeId ? String(adminUpgradeId) : null,
    type: b.type ? String(b.type) : 'per_player',
    createdAt: now,
    expiresAt: expMs
  };
}

export function planBulkDeleteCodes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Lista de códigos vazia ou inválida.' });
  }
  const codes = raw
    .map((c) => String(c || '').trim().toUpperCase())
    .filter((c) => CODE_RE.test(c));
  if (codes.length === 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Nenhum código válido para apagar.' });
  }
  if (codes.length > MAX_BULK_DELETE) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Máximo 2000 códigos por pedido.' });
  }
  return codes;
}

export function mapPromoExpiresAt(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return undefined;
}

export function mapPromoCodeAdminDto(
  p: PromoCodeRow,
  redemptionsCount: number,
  lastRedemptions: PromoLastRedemptionDto[]
): PromoCodeAdminDto {
  const createdAt = Number(p.created_at);
  const expiresAt = mapPromoExpiresAt(p.expires_at);
  const dto: PromoCodeAdminDto = {
    code: p.code,
    loot_box_id: p.loot_box_id,
    upgrade_id: p.upgrade_id,
    admin_upgrade_id: p.admin_upgrade_id,
    type: p.type,
    is_active: p.is_active,
    created_at: createdAt,
    expires_at: p.expires_at == null ? null : Number(p.expires_at),
    lootBoxId: p.loot_box_id,
    upgradeId: p.upgrade_id,
    adminUpgradeId: p.admin_upgrade_id,
    isActive: !!p.is_active,
    createdAt,
    redemptionsCount,
    lastRedemptions
  };
  if (expiresAt !== undefined) dto.expiresAt = expiresAt;
  return dto;
}

export async function listPromoCodes(): Promise<PromoCodeAdminDto[]> {
  const rows = await prisma.promo_codes.findMany({ orderBy: { created_at: 'desc' } });
  if (rows.length === 0) return [];

  const codes = rows.map((r) => r.code);
  const [counts, lastRows] = await Promise.all([
    prisma.promo_code_redemptions.groupBy({
      by: ['code'],
      where: { code: { in: codes } },
      _count: { _all: true }
    }),
    prisma.$queryRaw<Array<{ code: string; user_name: string | null; redeemed_at: unknown }>>`
      SELECT code, user_name, redeemed_at FROM (
        SELECT r.code, u.username AS user_name, r.redeemed_at,
          ROW_NUMBER() OVER (PARTITION BY r.code ORDER BY r.redeemed_at DESC) AS rn
        FROM promo_code_redemptions r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.code IN (${Prisma.join(codes)})
      ) x
      WHERE rn <= ${LAST_REDEMPTIONS_LIMIT}
    `
  ]);

  const countByCode = new Map<string, number>();
  for (const c of counts) countByCode.set(c.code, c._count._all);

  const lastByCode = new Map<string, PromoLastRedemptionDto[]>();
  for (const r of lastRows) {
    const list = lastByCode.get(r.code) || [];
    list.push({ userName: r.user_name, redeemedAt: Number(r.redeemed_at) });
    lastByCode.set(r.code, list);
  }
  for (const [code, list] of lastByCode) {
    list.sort((a, b) => b.redeemedAt - a.redeemedAt);
    lastByCode.set(code, list.slice(0, LAST_REDEMPTIONS_LIMIT));
  }

  return rows.map((p) =>
    mapPromoCodeAdminDto(p, countByCode.get(p.code) || 0, lastByCode.get(p.code) || [])
  );
}

export async function upsertPromoCode(body: unknown, now = Date.now()): Promise<{ ok: true }> {
  const plan = planCreatePromoCode(body, now);
  await prisma.promo_codes.upsert({
    where: { code: plan.code },
    create: {
      code: plan.code,
      loot_box_id: plan.lootBoxId,
      upgrade_id: plan.upgradeId,
      admin_upgrade_id: plan.adminUpgradeId,
      type: plan.type,
      is_active: 1,
      created_at: plan.createdAt,
      expires_at: plan.expiresAt
    },
    update: {
      loot_box_id: plan.lootBoxId,
      upgrade_id: plan.upgradeId,
      admin_upgrade_id: plan.adminUpgradeId,
      type: plan.type,
      ...(plan.expiresAt != null ? { expires_at: plan.expiresAt } : {})
    }
  });
  return { ok: true };
}

export async function deletePromoCode(code: string): Promise<{ ok: true }> {
  await prisma.$transaction([
    prisma.promo_code_redemptions.deleteMany({ where: { code } }),
    prisma.promo_codes.deleteMany({ where: { code } })
  ]);
  return { ok: true };
}

export async function togglePromoCode(code: string, isActive: unknown): Promise<{ ok: true }> {
  await prisma.promo_codes.updateMany({
    where: { code },
    data: { is_active: isActive ? 1 : 0 }
  });
  return { ok: true };
}

export async function bulkDeletePromoCodes(rawCodes: unknown): Promise<{ ok: true; deleted: number }> {
  const codes = planBulkDeleteCodes(rawCodes);
  const deleted = await prisma.$transaction(async (tx) => {
    await tx.promo_code_redemptions.deleteMany({ where: { code: { in: codes } } });
    const del = await tx.promo_codes.deleteMany({ where: { code: { in: codes } } });
    return del.count;
  });
  return { ok: true, deleted };
}
