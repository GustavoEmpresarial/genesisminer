import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadAdminUpgradesForUser', () => {
  let prismaMock: Record<string, any>;
  let dbMock: Record<string, any>;

  const PACK_ROW = {
    id: 'pack_1',
    name: 'Pacote 1',
    description: null,
    price_usdc: 10,
    grant_usdc: 0,
    grant_access_level_id: null,
    is_active: 1,
    version: 1,
    slug: null,
    category: 'PROMO_PACK',
    original_price_usdc: null,
    stock_remaining: null,
    max_per_user: 1,
    starts_at: null,
    ends_at: null,
    sort_order: 0,
    image_url: null
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: { users: { findUnique: vi.fn().mockResolvedValue({ is_admin: 0 }) } } };
    dbMock = {
      default: {
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          if (s.includes('FROM admin_upgrades')) return { rows: [PACK_ROW] };
          if (s.includes('FROM admin_upgrade_items')) return { rows: [{ upgrade_id: 'pack_1', item_id: 'gpu_1', qty: 2 }] };
          if (s.includes('FROM admin_upgrade_boxes')) return { rows: [] };
          if (s.includes('FROM admin_upgrade_passes')) return { rows: [] };
          if (s.includes('FROM admin_upgrade_coins')) return { rows: [] };
          if (s.includes('FROM admin_upgrade_visibility')) return { rows: [{ upgrade_id: 'pack_1', access_level_id: 'founder' }] };
          return { rows: [] };
        })
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/core/database/pool.js');
  });

  it('monta o pacote com items e visibilidade agregados', async () => {
    const { loadAdminUpgradesForUser } = await import('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
    const packs = await loadAdminUpgradesForUser(1);
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: 'pack_1', items: [{ itemId: 'gpu_1', qty: 2 }], visibleToAccessLevelIds: ['founder'] });
  });

  it('utilizador comum: query só pega pacotes activos', async () => {
    const { loadAdminUpgradesForUser } = await import('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
    await loadAdminUpgradesForUser(1);
    const call = dbMock.default.query.mock.calls.find(([sql]: [string]) => sql.includes('FROM admin_upgrades'));
    expect(call[0]).toContain('WHERE is_active = 1');
  });

  it('admin: query pega todos os pacotes (incluindo inactivos)', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1 });
    const { loadAdminUpgradesForUser } = await import('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
    await loadAdminUpgradesForUser(1);
    const call = dbMock.default.query.mock.calls.find(([sql]: [string]) => sql.includes('FROM admin_upgrades'));
    expect(call[0]).not.toContain('WHERE is_active');
  });

  it('sem userId: trata como não-admin, sem consultar users', async () => {
    const { loadAdminUpgradesForUser } = await import('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
    await loadAdminUpgradesForUser(undefined);
    expect(prismaMock.prisma.users.findUnique).not.toHaveBeenCalled();
  });
});
