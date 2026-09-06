import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeRecallItemCount } from '../../../../../server/modules/admin/recall-scan/services/recall-scan.js';

describe('computeRecallItemCount', () => {
  it('só rigs vazios: total = número de racks', () => {
    expect(
      computeRecallItemCount(
        [{ id: 'r1', user_id: 1, wiring_id: null, battery_id: null }],
        new Map(),
        new Map()
      )
    ).toBe(1);
  });

  it('wiring + battery + slots + multipliers', () => {
    const n = computeRecallItemCount(
      [
        { id: 'a', user_id: 1, wiring_id: 'w', battery_id: 'b' },
        { id: 'c', user_id: 1, wiring_id: null, battery_id: '' }
      ],
      new Map([
        ['a', 2],
        ['c', 1]
      ]),
      new Map([['a', 3]])
    );
    // 2 racks + wiring + battery + 2 slots + 1 slot + 3 multi = 10 (battery '' é falsy)
    expect(n).toBe(10);
  });
});

function writeForbiddenPrisma() {
  const fail = (op: string) => vi.fn(async () => {
    throw new Error(`WRITE_FORBIDDEN:${op}`);
  });
  return {
    users: {
      count: vi.fn(),
      create: fail('users.create'),
      update: fail('users.update'),
      delete: fail('users.delete'),
      deleteMany: fail('users.deleteMany'),
      updateMany: fail('users.updateMany'),
      upsert: fail('users.upsert')
    },
    placed_racks: {
      findMany: vi.fn(),
      create: fail('placed_racks.create'),
      update: fail('placed_racks.update'),
      delete: fail('placed_racks.delete'),
      deleteMany: fail('placed_racks.deleteMany'),
      updateMany: fail('placed_racks.updateMany'),
      upsert: fail('placed_racks.upsert')
    },
    rack_slots: {
      groupBy: vi.fn(),
      create: fail('rack_slots.create'),
      update: fail('rack_slots.update'),
      delete: fail('rack_slots.delete'),
      deleteMany: fail('rack_slots.deleteMany'),
      updateMany: fail('rack_slots.updateMany')
    },
    rack_multiplier_slots: {
      groupBy: vi.fn(),
      create: fail('rack_multiplier_slots.create'),
      deleteMany: fail('rack_multiplier_slots.deleteMany'),
      updateMany: fail('rack_multiplier_slots.updateMany')
    },
    $queryRaw: vi.fn(),
    $executeRaw: fail('$executeRaw'),
    $executeRawUnsafe: fail('$executeRawUnsafe'),
    $transaction: fail('$transaction')
  };
}

describe('scanRecallInstalledItems', () => {
  let prismaMock: { prisma: ReturnType<typeof writeForbiddenPrisma> };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: writeForbiddenPrisma() };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('sem racks: summary [] e totalUsersChecked = COUNT users', async () => {
    prismaMock.prisma.users.count.mockResolvedValue(12);
    prismaMock.prisma.$queryRaw.mockResolvedValue([]);
    const { scanRecallInstalledItems } = await import(
      '../../../../../server/modules/admin/recall-scan/services/recall-scan.js'
    );
    await expect(scanRecallInstalledItems()).resolves.toEqual({
      ok: true,
      summary: [],
      totalUsersChecked: 12
    });
    expect(prismaMock.prisma.placed_racks.findMany).not.toHaveBeenCalled();
  });

  it('agrega itens; um user por linha (GROUP BY); ordem do queryRaw', async () => {
    prismaMock.prisma.users.count.mockResolvedValue(3);
    prismaMock.prisma.$queryRaw.mockResolvedValue([
      { user_id: 2, username: 'bob', racks_count: '1' },
      { user_id: 1, username: 'alice', racks_count: '2' }
    ]);
    prismaMock.prisma.placed_racks.findMany.mockResolvedValue([
      { id: 'r-b', user_id: 2, wiring_id: 'w', battery_id: null },
      { id: 'r-a1', user_id: 1, wiring_id: null, battery_id: 'bat' },
      { id: 'r-a2', user_id: 1, wiring_id: null, battery_id: null }
    ]);
    prismaMock.prisma.rack_slots.groupBy.mockResolvedValue([
      { rack_id: 'r-a1', _count: { _all: 2 } },
      { rack_id: 'r-b', _count: { _all: 1 } }
    ]);
    prismaMock.prisma.rack_multiplier_slots.groupBy.mockResolvedValue([{ rack_id: 'r-a2', _count: { _all: 1 } }]);

    const { scanRecallInstalledItems } = await import(
      '../../../../../server/modules/admin/recall-scan/services/recall-scan.js'
    );
    const out = await scanRecallInstalledItems();
    expect(out.ok).toBe(true);
    expect(out.totalUsersChecked).toBe(3);
    expect(out.summary.map((s) => s.userId)).toEqual([2, 1]);
    expect(out.summary[0]).toEqual({ userId: 2, username: 'bob', racksCount: 1, totalItems: 1 + 1 + 1 });
    expect(out.summary[1]).toEqual({ userId: 1, username: 'alice', racksCount: 2, totalItems: 2 + 1 + 2 + 1 });
    expect(prismaMock.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prismaMock.prisma.placed_racks.update).not.toHaveBeenCalled();
  });

  it('erro de banco propaga; writes nunca são o caminho feliz', async () => {
    prismaMock.prisma.users.count.mockRejectedValue(new Error('db down'));
    prismaMock.prisma.$queryRaw.mockResolvedValue([]);
    const { scanRecallInstalledItems } = await import(
      '../../../../../server/modules/admin/recall-scan/services/recall-scan.js'
    );
    await expect(scanRecallInstalledItems()).rejects.toThrow('db down');
  });
});
