import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapAdminMarketListing } from '../../../../../server/modules/admin/market-listings/services/market-listings.js';

describe('mapAdminMarketListing', () => {
  const base = {
    id: 'l1',
    user_id: 7,
    item_id: 'asic_1',
    price: 10.5,
    qty: 3,
    status: 'active',
    expires_at: 1_700_000_000_000,
    reserved_by: 9,
    reserved_until: 1_700_000_100_000
  };

  it('mapeia campos do AdminBlackMarket + lineTotal', () => {
    const dto = mapAdminMarketListing(base, { id: 7, username: 'alice', email: 'a@a.a' });
    expect(dto).toEqual({
      id: 'l1',
      sellerId: 7,
      sellerName: 'alice',
      itemId: 'asic_1',
      price: 10.5,
      qty: 3,
      lineTotal: 31.5,
      status: 'active',
      expiresAt: 1_700_000_000_000,
      reservedBy: 9,
      reservedUntil: 1_700_000_100_000
    });
    expect(dto).not.toHaveProperty('email');
    expect(dto).not.toHaveProperty('buyerPaidUsdc');
    expect(dto).not.toHaveProperty('buyer_paid_usdc');
  });

  it('sellerName cai para email; qty inválida vira 1; reservedUntil omitido se null', () => {
    const dto = mapAdminMarketListing(
      { ...base, qty: 0, reserved_by: null, reserved_until: null },
      { id: 7, username: '', email: 'x@y.com' }
    );
    expect(dto.sellerName).toBe('x@y.com');
    expect(dto.qty).toBe(1);
    expect(dto.lineTotal).toBe(10.5);
    expect(dto.reservedBy).toBeNull();
    expect(dto.reservedUntil).toBeUndefined();
  });
});

describe('listAdminMarketListings', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        player_listings: { findMany: vi.fn() },
        users: { findMany: vi.fn() }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('lista vazia: [] e não consulta users', async () => {
    prismaMock.prisma.player_listings.findMany.mockResolvedValue([]);
    const { listAdminMarketListings } = await import(
      '../../../../../server/modules/admin/market-listings/services/market-listings.js'
    );
    await expect(listAdminMarketListings()).resolves.toEqual([]);
    expect(prismaMock.prisma.users.findMany).not.toHaveBeenCalled();
    expect(prismaMock.prisma.player_listings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ status: 'asc' }, { item_id: 'asc' }]
      })
    );
  });

  it('listings válidos: junta vendedor e não pede email como campo de saída', async () => {
    prismaMock.prisma.player_listings.findMany.mockResolvedValue([
      {
        id: 'a',
        user_id: 1,
        item_id: 'z_item',
        price: 2,
        qty: 1,
        status: 'sold',
        expires_at: 10n,
        reserved_by: null,
        reserved_until: null
      }
    ]);
    prismaMock.prisma.users.findMany.mockResolvedValue([{ id: 1, username: 'bob', email: 'secret@x.com' }]);
    const { listAdminMarketListings } = await import(
      '../../../../../server/modules/admin/market-listings/services/market-listings.js'
    );
    const rows = await listAdminMarketListings();
    expect(rows).toHaveLength(1);
    expect(rows[0].sellerName).toBe('bob');
    expect(JSON.stringify(rows)).not.toContain('secret@x.com');
    expect(prismaMock.prisma.users.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      select: { id: true, username: true, email: true }
    });
  });

  it('erro de banco propaga', async () => {
    prismaMock.prisma.player_listings.findMany.mockRejectedValue(new Error('db down'));
    const { listAdminMarketListings } = await import(
      '../../../../../server/modules/admin/market-listings/services/market-listings.js'
    );
    await expect(listAdminMarketListings()).rejects.toThrow('db down');
  });
});
