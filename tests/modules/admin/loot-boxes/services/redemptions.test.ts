import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin loot-boxes services/redemptions', () => {
  let prismaMock: {
    prisma: {
      promo_codes: { findMany: ReturnType<typeof vi.fn> };
      promo_code_redemptions: { findMany: ReturnType<typeof vi.fn> };
      users: { findMany: ReturnType<typeof vi.fn> };
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        promo_codes: { findMany: vi.fn().mockResolvedValue([]) },
        promo_code_redemptions: { findMany: vi.fn().mockResolvedValue([]) },
        users: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('sem promo codes da caixa: array vazio e não consulta redemptions', async () => {
    const { listLootBoxRedemptions } = await import(
      '../../../../../server/modules/admin/loot-boxes/services/redemptions.js'
    );
    await expect(listLootBoxRedemptions('box_a')).resolves.toEqual([]);
    expect(prismaMock.prisma.promo_codes.findMany).toHaveBeenCalledWith({
      where: { loot_box_id: 'box_a' },
      select: { code: true, type: true }
    });
    expect(prismaMock.prisma.promo_code_redemptions.findMany).not.toHaveBeenCalled();
  });

  it('mapeia resgates com username; fallback email e user_id', async () => {
    prismaMock.prisma.promo_codes.findMany.mockResolvedValue([
      { code: 'AAA', type: 'per_player' },
      { code: 'BBB', type: 'global_once' }
    ]);
    prismaMock.prisma.promo_code_redemptions.findMany.mockResolvedValue([
      { code: 'AAA', user_id: 1, redeemed_at: 300n },
      { code: 'BBB', user_id: 2, redeemed_at: 200n },
      { code: 'AAA', user_id: 3, redeemed_at: 100n }
    ]);
    prismaMock.prisma.users.findMany.mockResolvedValue([
      { id: 1, username: 'alice', email: 'a@x.com' },
      { id: 2, username: '   ', email: 'bob@x.com' },
      { id: 3, username: '', email: '' }
    ]);

    const { listLootBoxRedemptions } = await import(
      '../../../../../server/modules/admin/loot-boxes/services/redemptions.js'
    );
    const out = await listLootBoxRedemptions('box_a');

    expect(prismaMock.prisma.promo_code_redemptions.findMany).toHaveBeenCalledWith({
      where: { code: { in: ['AAA', 'BBB'] } },
      orderBy: { redeemed_at: 'desc' },
      select: { code: true, user_id: true, redeemed_at: true }
    });
    expect(out).toEqual([
      { code: 'AAA', type: 'per_player', username: 'alice', redeemedAt: 300 },
      { code: 'BBB', type: 'global_once', username: 'bob@x.com', redeemedAt: 200 },
      { code: 'AAA', type: 'per_player', username: 'user_3', redeemedAt: 100 }
    ]);
  });

  it('códigos sem resgates: array vazio sem consultar users', async () => {
    prismaMock.prisma.promo_codes.findMany.mockResolvedValue([{ code: 'AAA', type: 'per_player' }]);
    prismaMock.prisma.promo_code_redemptions.findMany.mockResolvedValue([]);

    const { listLootBoxRedemptions } = await import(
      '../../../../../server/modules/admin/loot-boxes/services/redemptions.js'
    );
    await expect(listLootBoxRedemptions('box_a')).resolves.toEqual([]);
    expect(prismaMock.prisma.users.findMany).not.toHaveBeenCalled();
  });
});
