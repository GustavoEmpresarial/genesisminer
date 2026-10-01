/**
 * Agregador de leitura pra `GET /api/upgrades/state` — catálogo de pacotes
 * admin visíveis pro utilizador + histórico de compras.
 *
 * Migrado de legacy/backend/modules/upgrades/upgradesState.service.ts (verbatim).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { loadAdminUpgradesForUser, type AdminUpgradePackRow } from './admin-upgrades-loader.js';
import { resolveUserAccessLevelIds } from './access-levels.js';
import { computeDiscountPercent, usdcDecimalFromRow } from './catalog.js';

const RECENT_PURCHASES_LIMIT = 30;
const USDC_DECIMALS = 6;
const PREVIEW_QTY_MIN = 1;
const PREVIEW_BASE_PRODUCTION_FALLBACK = 0;

export type PackageItemPreview = {
  rewardType: string;
  catalogId: string;
  quantity: number;
  label: string;
  imageUrl: string | null;
  baseProduction: number;
};

type StockItemCatalogMeta = {
  name: string;
  imageUrl: string | null;
  baseProduction: number;
};

function previewImageUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t ? t : null;
}

function previewBaseProduction(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : PREVIEW_BASE_PRODUCTION_FALLBACK;
}

function nonStockPreview(
  rewardType: string,
  catalogId: string,
  quantity: number,
  label: string
): PackageItemPreview {
  return {
    rewardType,
    catalogId,
    quantity,
    label,
    imageUrl: null,
    baseProduction: PREVIEW_BASE_PRODUCTION_FALLBACK
  };
}

/** Preview de conteúdo do pacote (imagem/nome/poder para STOCK_ITEM). */
export function buildPackageItemsPreview(
  stockById: Map<string, StockItemCatalogMeta>,
  boxNameById: Map<string, string>,
  row: AdminUpgradePackRow
): PackageItemPreview[] {
  const out: PackageItemPreview[] = [];
  for (const it of row.items || []) {
    const q = Math.max(PREVIEW_QTY_MIN, Math.floor(Number(it.qty) || 0));
    const meta = stockById.get(it.itemId);
    out.push({
      rewardType: 'STOCK_ITEM',
      catalogId: it.itemId,
      quantity: q,
      label: meta?.name || it.itemId,
      imageUrl: meta?.imageUrl ?? null,
      baseProduction: meta?.baseProduction ?? PREVIEW_BASE_PRODUCTION_FALLBACK
    });
  }
  for (const b of row.boxes || []) {
    const q = Math.max(PREVIEW_QTY_MIN, Math.floor(Number(b.qty) || 0));
    out.push(nonStockPreview('LOOT_BOX', b.boxId, q, boxNameById.get(b.boxId) || b.boxId));
  }
  for (const pid of row.passes || []) {
    out.push(nonStockPreview('SEASON_PASS', pid, 1, 'Season pass'));
  }
  for (const c of row.coins || []) {
    const amt = Number(c.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    out.push(nonStockPreview('MINED_COIN', c.coinId, amt, c.coinId));
  }
  const grant = Number(row.grantUsdc ?? 0);
  if (Number.isFinite(grant) && grant > 0) {
    out.push(nonStockPreview('USDC_GRANT', 'usdc', grant, 'USDC (bónus do pacote)'));
  }
  if (row.grantAccessLevelId) {
    out.push(nonStockPreview('ACCESS_LEVEL', row.grantAccessLevelId, 1, 'Nível de acesso'));
  }
  return out;
}

/** Sala/pacote sem restrição (lista vazia) é visível a todos; com restrição, precisa bater um dos níveis. */
function visibleToUser(p: AdminUpgradePackRow, levelIds: Set<string>): boolean {
  const v = p.visibleToAccessLevelIds || [];
  if (!v.length) return true;
  return v.some((id) => levelIds.has(String(id)));
}

export async function buildUpgradesStatePayload(userId: number, nowMs?: number): Promise<Record<string, unknown>> {
  const nowBi = BigInt(nowMs ?? Date.now());

  const [levelIds, gs, packsRaw, upgradeCatalog, lootRows, recentPurch] = await Promise.all([
    resolveUserAccessLevelIds(userId),
    prisma.game_states.findUnique({ where: { user_id: userId }, select: { usdc: true } }),
    loadAdminUpgradesForUser(userId),
    prisma.upgrades.findMany({ select: { id: true, name: true, image: true, base_production: true } }),
    prisma.loot_boxes.findMany({ select: { id: true, name: true } }),
    prisma.admin_upgrade_purchases.findMany({ where: { user_id: userId }, orderBy: { purchased_at: 'desc' }, take: RECENT_PURCHASES_LIMIT })
  ]);

  const purchIds = [...new Set(recentPurch.map((r) => r.upgrade_id))];
  const purchMeta = purchIds.length > 0 ? await prisma.admin_upgrades.findMany({ where: { id: { in: purchIds } }, select: { id: true, name: true, price_usdc: true } }) : [];
  const purchMetaById = new Map(purchMeta.map((x) => [x.id, x]));

  const packsVisible = packsRaw.filter((p) => visibleToUser(p, levelIds));

  const stockById = new Map(
    upgradeCatalog.map((u) => [
      u.id,
      {
        name: u.name,
        imageUrl: previewImageUrl(u.image),
        baseProduction: previewBaseProduction(u.base_production)
      } satisfies StockItemCatalogMeta
    ])
  );
  const boxNameById = new Map(lootRows.map((b) => [b.id, b.name]));

  const usdcBal = usdcDecimalFromRow(gs?.usdc ?? 0);
  const packs = packsVisible
    .map((p) => {
      const final = usdcDecimalFromRow(p.priceUsdc);
      const original = p.originalPriceUsdc != null && String(p.originalPriceUsdc).trim() !== '' ? new Prisma.Decimal(String(p.originalPriceUsdc)) : null;
      const discountPct = original ? computeDiscountPercent(original, final) : null;

      let unpurchasableReason: string | null = null;
      if (!p.isActive) unpurchasableReason = 'Pacote inativo.';
      else if (p.startsAt != null && nowBi < BigInt(p.startsAt)) unpurchasableReason = 'Venda ainda não iniciou.';
      else if (p.endsAt != null && nowBi > BigInt(p.endsAt)) unpurchasableReason = 'Oferta expirada.';
      else if (p.stockRemaining != null && p.stockRemaining <= 0) unpurchasableReason = 'Esgotado.';
      else if (usdcBal.lt(final)) unpurchasableReason = 'Insufficient USDC balance.';

      const isPurchasable = unpurchasableReason == null;

      return {
        id: p.id,
        slug: p.slug ?? null,
        name: p.name,
        description: p.description ?? null,
        imageUrl: p.imageUrl ?? null,
        category: p.category || 'PROMO_PACK',
        currency: 'USDC',
        finalPrice: final.toFixed(USDC_DECIMALS),
        originalPrice: original ? original.toFixed(USDC_DECIMALS) : null,
        discountPercent: discountPct,
        version: p.version ?? 1,
        isPurchasable,
        unpurchasableReason,
        stockRemaining: p.stockRemaining != null ? p.stockRemaining : null,
        maxPerUser: p.maxPerUser ?? 1,
        startsAt: p.startsAt ?? null,
        endsAt: p.endsAt ?? null,
        sortOrder: p.sortOrder ?? 0,
        alreadyOwned: !!p.alreadyOwned,
        itemsPreview: buildPackageItemsPreview(stockById, boxNameById, p)
      };
    })
    .sort((a, b) => {
      const pa = Number(a.finalPrice);
      const pb = Number(b.finalPrice);
      if (pa !== pb) return pa - pb;
      const oa = Number(a.sortOrder) || 0;
      const ob = Number(b.sortOrder) || 0;
      if (oa !== ob) return oa - ob;
      return String(a.name).localeCompare(String(b.name), 'pt', { sensitivity: 'base' });
    });

  const categories = Array.from(new Set(packs.map((p) => String(p.category || 'PROMO_PACK')))).sort();

  const purchaseHistory = recentPurch.map((r) => {
    const meta = purchMetaById.get(r.upgrade_id);
    return {
      upgradeId: r.upgrade_id,
      name: meta?.name ?? r.upgrade_id,
      paidUsdc: meta != null ? String(meta.price_usdc) : '',
      purchasedAt: Number(r.purchased_at)
    };
  });

  return {
    ok: true,
    title: 'Pacotes e upgrades',
    usdcBalance: usdcBal.toNumber(),
    categories,
    packages: packs,
    purchaseHistory,
    notice: 'Preços, descontos, stock e conteúdo são definidos no servidor. Envie apenas o id do pacote e idempotência na compra.'
  };
}
