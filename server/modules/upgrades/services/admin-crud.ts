/**
 * CRUD admin de pacotes (`POST /api/admin-upgrades` upsert, `DELETE /api/admin-upgrades/:id`).
 *
 * Migrado de legacy/backend/server.ts:2764/2812. Corrige um achado ao portar:
 * o `DELETE` legado limpava as 4 tabelas-filha (`items`/`boxes`/`passes`/`coins`)
 * mas esquecia `admin_upgrade_visibility` — deixava linha órfã pra trás
 * (sem FK a impedir, não dava erro, só lixo). Aqui limpa as 5.
 */
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

export type AdminUpgradeUpsertInput = {
  id: string;
  name: string;
  description?: string | null;
  priceUsdc: number;
  grantUsdc?: number;
  grantAccessLevelId?: string | null;
  isActive?: unknown;
  items?: Array<{ itemId: string; qty: number }>;
  boxes?: Array<{ boxId: string; qty: number }>;
  /** Legado aceitava tanto `string[]` (ids) quanto `{passId, qty}[]` — `qty` nunca é lido no grant (`services/grant.ts`), só existe pela coluna `NOT NULL` da tabela. */
  passes?: Array<string | { passId: string; qty?: number }>;
  coins?: Array<{ coinId: string; amount: number }>;
  visibleToAccessLevelIds?: string[];
};

const DEFAULT_PASS_QTY = 1;
const TX_TIMEOUT_MS = 60_000;
const TX_MAX_WAIT_MS = 10_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

function normalizePassEntry(p: string | { passId: string; qty?: number }): { pass_id: string; qty: number } | null {
  if (typeof p === 'string') {
    const passId = p.trim();
    return passId ? { pass_id: passId, qty: DEFAULT_PASS_QTY } : null;
  }
  const passId = String(p?.passId ?? '').trim();
  if (!passId) return null;
  const qty = Math.max(1, Math.floor(Number(p.qty) || DEFAULT_PASS_QTY));
  return { pass_id: passId, qty };
}

export async function upsertAdminUpgrade(u: AdminUpgradeUpsertInput): Promise<void> {
  const id = String(u.id ?? '').trim();
  if (!id) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'id do pacote é obrigatório.' });
  }

  await prisma.$transaction(
    async (tx) => {
      const existing = await tx.admin_upgrades.findUnique({ where: { id }, select: { version: true } });
      await tx.admin_upgrades.upsert({
        where: { id },
        create: {
          id,
          name: u.name,
          description: u.description ?? null,
          price_usdc: Number(u.priceUsdc) || 0,
          grant_usdc: Number(u.grantUsdc) || 0,
          grant_access_level_id: u.grantAccessLevelId || null,
          is_active: u.isActive ? 1 : 0,
          created_at: BigInt(Date.now())
        },
        update: {
          name: u.name,
          description: u.description ?? null,
          price_usdc: Number(u.priceUsdc) || 0,
          grant_usdc: Number(u.grantUsdc) || 0,
          grant_access_level_id: u.grantAccessLevelId || null,
          is_active: u.isActive ? 1 : 0,
          version: (existing?.version ?? 0) + 1
        }
      });

      await tx.admin_upgrade_items.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_boxes.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_passes.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_coins.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_visibility.deleteMany({ where: { upgrade_id: id } });

      const items = Array.isArray(u.items) ? u.items : [];
      if (items.length > 0) {
        await tx.admin_upgrade_items.createMany({ data: items.map((i) => ({ upgrade_id: id, item_id: i.itemId, qty: Number(i.qty) || 0 })) });
      }
      const boxes = Array.isArray(u.boxes) ? u.boxes : [];
      if (boxes.length > 0) {
        await tx.admin_upgrade_boxes.createMany({ data: boxes.map((b) => ({ upgrade_id: id, box_id: b.boxId, qty: Number(b.qty) || 0 })) });
      }
      const passes = (Array.isArray(u.passes) ? u.passes : []).map(normalizePassEntry).filter((p): p is { pass_id: string; qty: number } => p != null);
      if (passes.length > 0) {
        await tx.admin_upgrade_passes.createMany({ data: passes.map((p) => ({ upgrade_id: id, pass_id: p.pass_id, qty: p.qty })) });
      }
      const coins = Array.isArray(u.coins) ? u.coins : [];
      if (coins.length > 0) {
        await tx.admin_upgrade_coins.createMany({ data: coins.map((c) => ({ upgrade_id: id, coin_id: c.coinId, amount: Number(c.amount) || 0 })) });
      }
      const visibility = Array.isArray(u.visibleToAccessLevelIds) ? u.visibleToAccessLevelIds : [];
      if (visibility.length > 0) {
        await tx.admin_upgrade_visibility.createMany({ data: visibility.map((vid) => ({ upgrade_id: id, access_level_id: vid })) });
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
  );
}

export async function deleteAdminUpgrade(id: string): Promise<void> {
  const purchased = await prisma.admin_upgrade_purchases.findFirst({ where: { upgrade_id: id }, select: { user_id: true } });
  if (purchased) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Este upgrade já foi comprado por usuários e não pode ser excluído.' });
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.admin_upgrade_items.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_boxes.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_passes.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_coins.deleteMany({ where: { upgrade_id: id } });
      await tx.admin_upgrade_visibility.deleteMany({ where: { upgrade_id: id } });

      const del = await tx.admin_upgrades.deleteMany({ where: { id } });
      if (del.count === 0) {
        throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Upgrade não encontrado' });
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS }
  );
}
