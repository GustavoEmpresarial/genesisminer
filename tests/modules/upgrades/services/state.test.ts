import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PACK_VISIBLE = {
  id: 'pack_open',
  name: 'Pacote Aberto',
  description: null,
  priceUsdc: 10,
  grantUsdc: 0,
  grantAccessLevelId: null,
  isActive: true,
  items: [],
  boxes: [],
  passes: [],
  coins: [],
  visibleToAccessLevelIds: [],
  alreadyOwned: false,
  version: 1,
  slug: null,
  category: 'PROMO_PACK',
  originalPriceUsdc: null,
  stockRemaining: null,
  maxPerUser: 1,
  startsAt: null,
  endsAt: null,
  sortOrder: 0,
  imageUrl: null
};

const PACK_FOUNDER_ONLY = { ...PACK_VISIBLE, id: 'pack_founder', name: 'Pacote Founder', visibleToAccessLevelIds: ['founder'] };

describe('buildUpgradesStatePayload', () => {
  let prismaMock: Record<string, any>;
  let accessLevelsMock: Record<string, any>;
  let loaderMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        game_states: { findUnique: vi.fn().mockResolvedValue({ usdc: 100 }) },
        upgrades: { findMany: vi.fn().mockResolvedValue([]) },
        loot_boxes: { findMany: vi.fn().mockResolvedValue([]) },
        admin_upgrade_purchases: { findMany: vi.fn().mockResolvedValue([]) },
        admin_upgrades: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };
    accessLevelsMock = { resolveUserAccessLevelIds: vi.fn().mockResolvedValue(new Set<string>()) };
    loaderMock = { loadAdminUpgradesForUser: vi.fn().mockResolvedValue([PACK_VISIBLE, PACK_FOUNDER_ONLY]) };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/upgrades/services/access-levels.js', () => accessLevelsMock);
    vi.doMock('../../../../server/modules/upgrades/services/admin-upgrades-loader.js', () => loaderMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/upgrades/services/access-levels.js');
    vi.doUnmock('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
  });

  it('filtra pacotes restritos que o utilizador não tem nível pra ver', async () => {
    const { buildUpgradesStatePayload } = await import('../../../../server/modules/upgrades/services/state.js');
    const payload = await buildUpgradesStatePayload(1);
    const packs = payload.packages as Array<{ id: string }>;
    expect(packs.map((p) => p.id)).toEqual(['pack_open']);
  });

  it('mostra pacote restrito quando o utilizador tem o nível', async () => {
    accessLevelsMock.resolveUserAccessLevelIds.mockResolvedValue(new Set(['founder']));
    const { buildUpgradesStatePayload } = await import('../../../../server/modules/upgrades/services/state.js');
    const payload = await buildUpgradesStatePayload(1);
    const packs = payload.packages as Array<{ id: string }>;
    expect(packs.map((p) => p.id).sort()).toEqual(['pack_founder', 'pack_open']);
  });

  it('marca unpurchasableReason por saldo insuficiente', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({ usdc: 1 });
    const { buildUpgradesStatePayload } = await import('../../../../server/modules/upgrades/services/state.js');
    const payload = await buildUpgradesStatePayload(1);
    const packs = payload.packages as Array<{ id: string; isPurchasable: boolean; unpurchasableReason: string | null }>;
    expect(packs[0].isPurchasable).toBe(false);
    expect(packs[0].unpurchasableReason).toBe('Insufficient USDC balance.');
  });

  it('calcula desconto quando há originalPriceUsdc', async () => {
    loaderMock.loadAdminUpgradesForUser.mockResolvedValue([{ ...PACK_VISIBLE, priceUsdc: 75, originalPriceUsdc: '100' }]);
    const { buildUpgradesStatePayload } = await import('../../../../server/modules/upgrades/services/state.js');
    const payload = await buildUpgradesStatePayload(1);
    const packs = payload.packages as Array<{ discountPercent: number | null }>;
    expect(packs[0].discountPercent).toBe(25);
  });
});
