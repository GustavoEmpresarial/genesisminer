import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EconomyCoinRow } from '../../../../../server/modules/admin/economy-stats/services/economy-stats.js';

describe('listEconomyStats', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        mining_coins: { findMany: vi.fn() },
        upgrades: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
        rack_slots: { findMany: vi.fn() },
        rack_multiplier_slots: { findMany: vi.fn() }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('consulta em paralelo e agrega; ausência de dados → zeros', async () => {
    const coin: EconomyCoinRow = {
      id: 'btc',
      name: 'Bitcoin',
      symbol: 'BTC',
      description: '',
      network_hashrate: 1,
      block_reward: 1,
      block_time: 600,
      price_usd: 1,
      algorithm: '',
      difficulty: 1,
      multiplier: 1,
      color: '#fff',
      min_proportion: 0,
      usdc_rate: 1,
      is_active: 1,
      target_daily_usd: 0,
      show_in_exchange: 1,
      nft_room_only: 0
    };
    prismaMock.prisma.mining_coins.findMany.mockResolvedValue([coin]);
    prismaMock.prisma.upgrades.findMany.mockResolvedValue([]);
    prismaMock.prisma.$queryRaw.mockResolvedValue([]);
    prismaMock.prisma.rack_slots.findMany.mockResolvedValue([]);
    prismaMock.prisma.rack_multiplier_slots.findMany.mockResolvedValue([]);

    const { listEconomyStats } = await import(
      '../../../../../server/modules/admin/economy-stats/services/economy-stats.js'
    );
    await expect(listEconomyStats()).resolves.toEqual([{ ...coin, realActiveMiners: 0, realTotalHashrate: 0 }]);
    expect(prismaMock.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('erro de banco propaga', async () => {
    prismaMock.prisma.mining_coins.findMany.mockRejectedValue(new Error('db down'));
    prismaMock.prisma.upgrades.findMany.mockResolvedValue([]);
    prismaMock.prisma.$queryRaw.mockResolvedValue([]);
    prismaMock.prisma.rack_slots.findMany.mockResolvedValue([]);
    prismaMock.prisma.rack_multiplier_slots.findMany.mockResolvedValue([]);

    const { listEconomyStats } = await import(
      '../../../../../server/modules/admin/economy-stats/services/economy-stats.js'
    );
    await expect(listEconomyStats()).rejects.toThrow('db down');
  });
});
