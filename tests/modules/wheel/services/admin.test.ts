import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('modules/wheel/services/admin', () => {
  let prismaMock: Record<string, any>;
  let txMock: { wheel_prizes: { deleteMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.resetModules();
    txMock = { wheel_prizes: { deleteMany: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue(undefined) } };
    prismaMock = {
      prisma: {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $transaction: vi.fn((cb: any) => cb(txMock)),
        wheel_config: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined) },
        wheel_players: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue(undefined) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  async function load() {
    return import('../../../../server/modules/wheel/services/admin.js');
  }

  describe('fetchWheelPrizesForAdminWheelEditor', () => {
    it('mapeia linhas cruas, com defaults pra is_active/tier ausentes', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ id: 'p1', label: 'X', weight: 3, color: '#fff', item_id: null, is_active: null, tier: null }]);
      const { fetchWheelPrizesForAdminWheelEditor } = await load();
      const rows = await fetchWheelPrizesForAdminWheelEditor();
      expect(rows).toEqual([{ id: 'p1', label: 'X', color: '#fff', weight: 3, itemId: '', isActive: 1, tier: 'BASIC' }]);
    });
  });

  describe('replaceWheelPrizesCatalog', () => {
    it('apaga tudo e recria cada item, is_active default 1', async () => {
      const { replaceWheelPrizesCatalog } = await load();
      await replaceWheelPrizesCatalog([{ id: 'p1', label: 'X', weight: 2, color: '#fff' }]);
      expect(txMock.wheel_prizes.deleteMany).toHaveBeenCalledWith({});
      expect(txMock.wheel_prizes.create).toHaveBeenCalledWith({
        data: { id: 'p1', label: 'X', weight: 2, color: '#fff', item_id: null, is_active: 1, tier: 'BASIC' }
      });
    });

    it('isActive false/0: grava is_active 0', async () => {
      const { replaceWheelPrizesCatalog } = await load();
      await replaceWheelPrizesCatalog([{ id: 'p1', label: 'X', weight: 1, color: '#fff', isActive: false }]);
      expect(txMock.wheel_prizes.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ is_active: 0 }) }));
    });

    it('itemId vazio/whitespace vira null', async () => {
      const { replaceWheelPrizesCatalog } = await load();
      await replaceWheelPrizesCatalog([{ id: 'p1', label: 'X', weight: 1, color: '#fff', itemId: '   ' }]);
      expect(txMock.wheel_prizes.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ item_id: null }) }));
    });
  });

  describe('getAdminWheelRuntimeConfig', () => {
    it('não configurado: lança HttpControlledError 404', async () => {
      const { getAdminWheelRuntimeConfig } = await load();
      await expect(getAdminWheelRuntimeConfig()).rejects.toMatchObject({ statusCode: 404 });
    });

    it('mapeia a linha para DTO', async () => {
      prismaMock.prisma.wheel_config.findUnique.mockResolvedValue({
        spin_price_usdc: 1.5,
        min_spin_price_usdc: 0.5,
        currency: 'USDC',
        is_enabled: 1,
        max_spins_per_request: 3,
        daily_limit: 10,
        cooldown_seconds: 5,
        starts_at: 100n,
        ends_at: 200n,
        updated_at: 300n
      });
      const { getAdminWheelRuntimeConfig } = await load();
      const cfg = await getAdminWheelRuntimeConfig();
      expect(cfg).toEqual({
        spinPriceUsdc: 1.5,
        minSpinPriceUsdc: 0.5,
        currency: 'USDC',
        isEnabled: true,
        maxSpinsPerRequest: 3,
        dailyLimit: 10,
        cooldownSeconds: 5,
        startsAtMs: '100',
        endsAtMs: '200',
        updatedAtMs: '300'
      });
    });
  });

  describe('upsertAdminWheelRuntimeConfig', () => {
    it('spinPriceUsdc ausente: lança HttpControlledError 400', async () => {
      const { upsertAdminWheelRuntimeConfig } = await load();
      await expect(upsertAdminWheelRuntimeConfig({})).rejects.toMatchObject({ statusCode: 400 });
      expect(prismaMock.prisma.wheel_config.upsert).not.toHaveBeenCalled();
    });

    it('preço abaixo do mínimo (0.10): lança HttpControlledError 422', async () => {
      const { upsertAdminWheelRuntimeConfig } = await load();
      await expect(upsertAdminWheelRuntimeConfig({ spinPriceUsdc: 0.05 })).rejects.toMatchObject({ statusCode: 422 });
    });

    it('caminho feliz: upsert com defaults sãos', async () => {
      const { upsertAdminWheelRuntimeConfig } = await load();
      await upsertAdminWheelRuntimeConfig({ spinPriceUsdc: 1 });
      expect(prismaMock.prisma.wheel_config.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          update: expect.objectContaining({ is_enabled: 1, max_spins_per_request: 1, daily_limit: null, cooldown_seconds: 0 })
        })
      );
    });

    it('dailyLimit vazio/null: grava null; número: floor+clamp em 0', async () => {
      const { upsertAdminWheelRuntimeConfig } = await load();
      await upsertAdminWheelRuntimeConfig({ spinPriceUsdc: 1, dailyLimit: -5.7 });
      expect(prismaMock.prisma.wheel_config.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ daily_limit: 0 }) }));
    });
  });

  describe('listAdminWheelPlayers / addAdminWheelPlayer', () => {
    it('lista mapeando added_at pra number', async () => {
      prismaMock.prisma.wheel_players.findMany.mockResolvedValue([{ username: 'alice', added_at: 1000n }]);
      const { listAdminWheelPlayers } = await load();
      expect(await listAdminWheelPlayers()).toEqual([{ username: 'alice', addedAt: 1000 }]);
    });

    it('username vazio: lança HttpControlledError 400', async () => {
      const { addAdminWheelPlayer } = await load();
      await expect(addAdminWheelPlayer('   ')).rejects.toMatchObject({ statusCode: 400 });
      expect(prismaMock.prisma.wheel_players.upsert).not.toHaveBeenCalled();
    });

    it('caminho feliz: upsert com o username normalizado', async () => {
      const { addAdminWheelPlayer } = await load();
      await addAdminWheelPlayer('  bob  ');
      expect(prismaMock.prisma.wheel_players.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { username: 'bob' } }));
    });
  });
});
