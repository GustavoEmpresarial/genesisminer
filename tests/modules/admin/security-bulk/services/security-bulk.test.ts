import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/security-bulk services/security-bulk', () => {
  let prismaMock: Record<string, any>;
  let settingsMock: Record<string, any>;
  let authBcrypt: { hash: ReturnType<typeof vi.fn> };
  let callAuthSessionDeleteByUser: ReturnType<typeof vi.fn>;

  const AUTH_WORKER = '../../../../../server/modules/auth/services/auth-worker-client.js';

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        $queryRaw: vi.fn().mockResolvedValue([{ count: 0 }]),
        $executeRaw: vi.fn().mockResolvedValue(0),
        users: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }
      }
    };
    settingsMock = {
      getSettingValue: vi.fn().mockResolvedValue(null),
      upsertSettingsEntries: vi.fn().mockResolvedValue(undefined)
    };
    authBcrypt = { hash: vi.fn().mockResolvedValue('hashed') };
    callAuthSessionDeleteByUser = vi.fn().mockResolvedValue({ ok: true, deletedCount: 0 });
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/shared/settings/settings-repository.js', () => settingsMock);
    vi.doMock(AUTH_WORKER, async () => {
      const actual = await vi.importActual<typeof import('../../../../../server/modules/auth/services/auth-worker-client.js')>(
        AUTH_WORKER
      );
      return { ...actual, authWorkerBcrypt: authBcrypt, callAuthSessionDeleteByUser };
    });
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/shared/settings/settings-repository.js');
    vi.doUnmock(AUTH_WORKER);
  });

  describe('parseInactiveDays', () => {
    it('aceita inteiros entre 1 e 3650', async () => {
      const { parseInactiveDays } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(parseInactiveDays(90)).toBe(90);
      expect(parseInactiveDays('30')).toBe(30);
      expect(parseInactiveDays(1)).toBe(1);
      expect(parseInactiveDays(3650)).toBe(3650);
    });

    it('rejeita fora do intervalo ou não numérico', async () => {
      const { parseInactiveDays } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(parseInactiveDays(0)).toBeNull();
      expect(parseInactiveDays(3651)).toBeNull();
      expect(parseInactiveDays('lixo')).toBeNull();
      expect(parseInactiveDays(undefined)).toBeNull();
    });
  });

  describe('readInactiveBlockConfig / saveInactiveBlockConfig', () => {
    it('sem settings gravados: usa defaults (90 dias, auto desligado)', async () => {
      const { readInactiveBlockConfig } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await readInactiveBlockConfig()).toEqual({ inactiveBlockDays: 90, autoBlockEnabled: false });
    });

    it('lê os settings gravados', async () => {
      settingsMock.getSettingValue.mockImplementation(async (key: string) => (key === 'security_inactive_block_days' ? '30' : '1'));
      const { readInactiveBlockConfig } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await readInactiveBlockConfig()).toEqual({ inactiveBlockDays: 30, autoBlockEnabled: true });
    });

    it('saveInactiveBlockConfig grava as duas entradas', async () => {
      const { saveInactiveBlockConfig } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      await saveInactiveBlockConfig(45, true);
      expect(settingsMock.upsertSettingsEntries).toHaveBeenCalledWith([
        { key: 'security_inactive_block_days', value: '45' },
        { key: 'security_inactive_auto_block_enabled', value: '1' }
      ]);
    });
  });

  describe('countInactiveUsers / blockInactiveUsersByDays', () => {
    it('countInactiveUsers devolve a contagem da query', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ count: 42 }]);
      const { countInactiveUsers } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await countInactiveUsers(90)).toBe(42);
    });

    it('blockInactiveUsersByDays sem inativos: devolve 0 sem chamar updateMany/deleteMany', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([]);
      const { blockInactiveUsersByDays } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await blockInactiveUsersByDays(90)).toBe(0);
      expect(prismaMock.prisma.users.updateMany).not.toHaveBeenCalled();
      expect(callAuthSessionDeleteByUser).not.toHaveBeenCalled();
    });

    it('blockInactiveUsersByDays bloqueia os ids inativos, apaga as sessões deles e devolve a contagem', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
      const { blockInactiveUsersByDays } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      const n = await blockInactiveUsersByDays(90);
      expect(n).toBe(3);
      expect(prismaMock.prisma.users.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2, 3] } }, data: { is_blocked: 1 } });
      expect(callAuthSessionDeleteByUser).toHaveBeenCalledWith({ userIds: [1, 2, 3] });
    });
  });

  describe('countPasswordResetTargets / forcePasswordResetForPlayers', () => {
    it('countPasswordResetTargets devolve a contagem da query', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ count: 7 }]);
      const { countPasswordResetTargets } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await countPasswordResetTargets()).toBe(7);
    });

    it('sem alvos: devolve 0 sem gerar hash nem tocar na BD de update', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([]);
      const { forcePasswordResetForPlayers } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await forcePasswordResetForPlayers()).toBe(0);
      expect(authBcrypt.hash).not.toHaveBeenCalled();
      expect(prismaMock.prisma.$executeRaw).not.toHaveBeenCalled();
      expect(callAuthSessionDeleteByUser).not.toHaveBeenCalled();
    });

    it('com alvos: gera 1 hash só, actualiza users e apaga sessões deles', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
      prismaMock.prisma.$executeRaw.mockResolvedValue(5);
      const { forcePasswordResetForPlayers } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      const n = await forcePasswordResetForPlayers();
      expect(n).toBe(5);
      expect(authBcrypt.hash).toHaveBeenCalledTimes(1);
      expect(prismaMock.prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(callAuthSessionDeleteByUser).toHaveBeenCalledWith({ userIds: [1, 2, 3, 4, 5] });
    });

    it('$executeRaw devolve 0 (driver não reporta rowCount): cai no fallback do targetCount', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
      prismaMock.prisma.$executeRaw.mockResolvedValue(0);
      const { forcePasswordResetForPlayers } = await import('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
      expect(await forcePasswordResetForPlayers()).toBe(5);
    });
  });
});
