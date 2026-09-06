import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolveUserAccessLevelIds', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn().mockResolvedValue({ access_level_id: 'founder' }) },
        user_access_levels: { findMany: vi.fn().mockResolvedValue([{ access_level_id: 'partner' }]) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  it('combina access_level_id actual com os grants extras de user_access_levels', async () => {
    const { resolveUserAccessLevelIds } = await import('../../../../server/modules/upgrades/services/access-levels.js');
    const ids = await resolveUserAccessLevelIds(1);
    expect([...ids].sort()).toEqual(['founder', 'partner']);
  });

  it('sem access_level_id nem grants: conjunto vazio', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ access_level_id: null });
    prismaMock.prisma.user_access_levels.findMany.mockResolvedValue([]);
    const { resolveUserAccessLevelIds } = await import('../../../../server/modules/upgrades/services/access-levels.js');
    const ids = await resolveUserAccessLevelIds(1);
    expect(ids.size).toBe(0);
  });
});
