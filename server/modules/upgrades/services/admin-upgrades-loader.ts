/**
 * Catálogo bruto de pacotes admin (`admin_upgrades` + tabelas de conteúdo/visibilidade).
 *
 * Migrado de legacy/backend/lib/meUpgradeShopBundlePayload.ts — só
 * `loadAdminUpgradesForUser` (o resto do arquivo é o "bundle" de season
 * passes/salas/loot-boxes, cortado quando `modules/profile` migrou — ver
 * docs/architecture/DECISIONS.md item #6/#8).
 */
import db from '../../../core/database/pool.js';
import { prisma } from '../../../core/database/prisma.js';

export type AdminUpgradePackRow = {
  id: string;
  name: string;
  description: string | null;
  priceUsdc: unknown;
  grantUsdc: unknown;
  grantAccessLevelId: string | null;
  isActive: boolean;
  items: { itemId: string; qty: number }[];
  boxes: { boxId: string; qty: number }[];
  passes: string[];
  coins: { coinId: string; amount: unknown }[];
  visibleToAccessLevelIds: string[];
  alreadyOwned: boolean;
  version: number;
  slug: string | null;
  category: string;
  originalPriceUsdc: string | null;
  stockRemaining: number | null;
  maxPerUser: number;
  startsAt: number | null;
  endsAt: number | null;
  sortOrder: number;
  imageUrl: string | null;
};

/** Igual a `GET /api/admin-upgrades` do legado (userId pode ser undefined → só ativos). */
export async function loadAdminUpgradesForUser(userId: number | undefined): Promise<AdminUpgradePackRow[]> {
  let isAdminUser = false;
  if (userId) {
    const uRow = await prisma.users.findUnique({ where: { id: userId }, select: { is_admin: true } });
    if (uRow?.is_admin) isAdminUser = true;
  }

  const query = isAdminUser
    ? 'SELECT * FROM admin_upgrades ORDER BY COALESCE(sort_order, 0) ASC, created_at DESC'
    : 'SELECT * FROM admin_upgrades WHERE is_active = 1 ORDER BY COALESCE(sort_order, 0) ASC, created_at DESC';
  const upsRes = await db.query(query);
  const itemsRes = await db.query('SELECT * FROM admin_upgrade_items');
  const boxesRes = await db.query('SELECT * FROM admin_upgrade_boxes');
  const passesRes = await db.query('SELECT * FROM admin_upgrade_passes');
  const coinsRes = await db.query('SELECT * FROM admin_upgrade_coins');
  const visibilityRes = await db.query('SELECT * FROM admin_upgrade_visibility');

  const itemsMap = itemsRes.rows.reduce<Record<string, { itemId: string; qty: number }[]>>((acc, r) => {
    (acc[r.upgrade_id] = acc[r.upgrade_id] || []).push({ itemId: r.item_id, qty: r.qty });
    return acc;
  }, {});
  const boxesMap = boxesRes.rows.reduce<Record<string, { boxId: string; qty: number }[]>>((acc, r) => {
    (acc[r.upgrade_id] = acc[r.upgrade_id] || []).push({ boxId: r.box_id, qty: r.qty });
    return acc;
  }, {});
  const passesMap = passesRes.rows.reduce<Record<string, string[]>>((acc, r) => {
    (acc[r.upgrade_id] = acc[r.upgrade_id] || []).push(r.pass_id);
    return acc;
  }, {});
  const coinsMap = coinsRes.rows.reduce<Record<string, { coinId: string; amount: unknown }[]>>((acc, r) => {
    (acc[r.upgrade_id] = acc[r.upgrade_id] || []).push({ coinId: r.coin_id, amount: r.amount });
    return acc;
  }, {});
  const visibilityMap = visibilityRes.rows.reduce<Record<string, string[]>>((acc, r) => {
    (acc[r.upgrade_id] = acc[r.upgrade_id] || []).push(r.access_level_id);
    return acc;
  }, {});

  return upsRes.rows.map((u: Record<string, unknown>) => ({
    id: String(u.id),
    name: String(u.name),
    description: u.description != null ? String(u.description) : null,
    priceUsdc: u.price_usdc,
    grantUsdc: u.grant_usdc,
    grantAccessLevelId: u.grant_access_level_id != null ? String(u.grant_access_level_id) : null,
    isActive: !!u.is_active,
    items: itemsMap[String(u.id)] || [],
    boxes: boxesMap[String(u.id)] || [],
    passes: passesMap[String(u.id)] || [],
    coins: coinsMap[String(u.id)] || [],
    visibleToAccessLevelIds: visibilityMap[String(u.id)] || [],
    alreadyOwned: false,
    version: u.version != null ? Number(u.version) : 1,
    slug: u.slug != null ? String(u.slug) : null,
    category: u.category != null ? String(u.category) : 'PROMO_PACK',
    originalPriceUsdc: u.original_price_usdc != null && String(u.original_price_usdc).trim() !== '' ? String(u.original_price_usdc) : null,
    stockRemaining: u.stock_remaining != null ? Number(u.stock_remaining) : null,
    maxPerUser: u.max_per_user != null ? Number(u.max_per_user) : 1,
    startsAt: u.starts_at != null ? Number(u.starts_at) : null,
    endsAt: u.ends_at != null ? Number(u.ends_at) : null,
    sortOrder: u.sort_order != null ? Number(u.sort_order) : 0,
    imageUrl: u.image_url != null ? String(u.image_url) : null
  }));
}
