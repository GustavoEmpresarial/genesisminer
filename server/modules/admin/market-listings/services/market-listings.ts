/**
 * GET /api/admin/market/listings — leitura para AdminBlackMarket.
 *
 * Shape do legado (`legacy/backend/server.ts`): todas as linhas de
 * `player_listings`, vendedor via `users.username || users.email`.
 * Sem query params. Não usa `mapListingForClient` (lá `reservedBy` é o
 * username do reservador; aqui é o user id, como o tipo admin).
 */
import { prisma } from '../../../../core/database/prisma.js';

export type AdminMarketListingDto = {
  id: string;
  sellerId: number;
  sellerName: string;
  itemId: string;
  price: number;
  qty: number;
  lineTotal: number;
  status: string | null;
  expiresAt: number;
  reservedBy: number | null;
  reservedUntil?: number;
};

export type AdminListingRow = {
  id: string;
  user_id: number;
  item_id: string;
  price: unknown;
  qty: unknown;
  status: string | null;
  expires_at: unknown;
  reserved_by: number | null;
  reserved_until: unknown;
};

export type AdminSellerRow = {
  id: number;
  username: string | null;
  email: string | null;
};

export function mapAdminMarketListing(l: AdminListingRow, seller: AdminSellerRow | undefined): AdminMarketListingDto {
  const q = Math.max(1, parseInt(String(l.qty ?? 1), 10) || 1);
  const unit = Number(l.price);
  const dto: AdminMarketListingDto = {
    id: l.id,
    sellerId: l.user_id,
    sellerName: (seller?.username || seller?.email) ?? '',
    itemId: l.item_id,
    price: unit,
    qty: q,
    lineTotal: unit * q,
    status: l.status,
    expiresAt: Number(l.expires_at),
    reservedBy: l.reserved_by
  };
  if (l.reserved_until != null) {
    dto.reservedUntil = Number(l.reserved_until);
  }
  return dto;
}

export async function listAdminMarketListings(): Promise<AdminMarketListingDto[]> {
  const listings = await prisma.player_listings.findMany({
    orderBy: [{ status: 'asc' }, { item_id: 'asc' }],
    select: {
      id: true,
      user_id: true,
      item_id: true,
      price: true,
      qty: true,
      status: true,
      expires_at: true,
      reserved_by: true,
      reserved_until: true
    }
  });
  const sellerIds = [...new Set(listings.map((l) => l.user_id))];
  const sellers =
    sellerIds.length === 0
      ? []
      : await prisma.users.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, username: true, email: true }
        });
  const sellerMap = new Map(sellers.map((u) => [u.id, u]));
  return listings.map((l) => mapAdminMarketListing(l, sellerMap.get(l.user_id)));
}
