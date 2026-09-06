import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRA_ROOM_ID, ROOM_INITIAL_ID } from '../../../../../server/modules/mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../../../../server/modules/mining-engine/services/room-kind.js';

describe('normalizeAdminStockSnapshot', () => {
  it('omite qty inválida / id inválido / n≤0 e só aceita ids SAFE', async () => {
    const { normalizeAdminStockSnapshot } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    expect(
      normalizeAdminStockSnapshot({
        'gpu.basic': 3,
        'rack.ok': 0,
        bad: -1,
        'also.bad': Number.NaN,
        'x y': 2,
        '': 5,
        nested: { a: 1 }
      })
    ).toEqual({ 'gpu.basic': 3 });
  });

  it('aceita números em string finitos > 0', async () => {
    const { normalizeAdminStockSnapshot } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    expect(normalizeAdminStockSnapshot({ a: '4', b: '0', c: 'x' })).toEqual({ a: 4 });
  });

  it('não-object → mapa vazio', async () => {
    const { normalizeAdminStockSnapshot } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    expect(normalizeAdminStockSnapshot(null)).toEqual({});
    expect(normalizeAdminStockSnapshot([])).toEqual({});
    expect(normalizeAdminStockSnapshot('x')).toEqual({});
  });
});

const HARDWARE_CLIENT_PATH = '../../../../../server/modules/hardware/services/hardware-client.js';
const WALLET_CLIENT_PATH = '../../../../../server/modules/wallet/services/wallet-worker-client.js';

describe('applyAdminSaveGameOverride', () => {
  let prismaMock: Record<string, unknown>;
  let persistMock: Record<string, unknown>;
  let progressMock: { computeProgressForUser: ReturnType<typeof vi.fn> };
  let callWalletAdminSaveGameBalances: ReturnType<typeof vi.fn>;
  let client: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let pool: { connect: ReturnType<typeof vi.fn> };
  let prevHardwareUrl: string | undefined;
  let prevWalletUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    prevWalletUrl = process.env.GENESIS_WALLET_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    process.env.GENESIS_WALLET_URL = 'http://wallet.test';
    callWalletAdminSaveGameBalances = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock(HARDWARE_CLIENT_PATH, () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwarePersist: vi.fn().mockResolvedValue({ ok: true })
    }));
    vi.doMock(WALLET_CLIENT_PATH, () => ({
      callWalletAdminSaveGameBalances,
      isWalletWorkerError: (e: unknown) =>
        e instanceof Error && (e as { name?: string }).name === 'WalletWorkerError'
    }));
    client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn()
    };
    pool = { connect: vi.fn().mockResolvedValue(client) };
    prismaMock = {
      prisma: {
        users: {
          findUnique: vi.fn().mockResolvedValue({ id: 10 }),
          findFirst: vi.fn()
        },
        game_states: { findUnique: vi.fn() },
        coin_balances: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };
    persistMock = {
      persistStockStoredBatteriesPlacedRacks: vi.fn().mockResolvedValue(undefined),
      loadUserStock: vi.fn().mockResolvedValue({ 'gpu.basic': 2 }),
      loadUserPlacedRacksWithSlots: vi.fn().mockResolvedValue([]),
      loadUserStoredBatteries: vi.fn()
    };
    progressMock = {
      computeProgressForUser: vi.fn().mockResolvedValue({ ok: true })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/hardware/services/persistence.js', () => persistMock);
    vi.doMock('../../../../../server/modules/servers/services/state-snapshot.js', () => ({
      buildServersAuthoritativeStateDto: vi.fn()
    }));
    vi.doMock('../../../../../server/modules/mining-engine/services/progress-computer.js', () => progressMock);
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    if (prevWalletUrl === undefined) delete process.env.GENESIS_WALLET_URL;
    else process.env.GENESIS_WALLET_URL = prevWalletUrl;
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/hardware/services/persistence.js');
    vi.doUnmock('../../../../../server/modules/servers/services/state-snapshot.js');
    vi.doUnmock('../../../../../server/modules/mining-engine/services/progress-computer.js');
    vi.doUnmock(HARDWARE_CLIENT_PATH);
    vi.doUnmock(WALLET_CLIENT_PATH);
  });

  async function load() {
    return import('../../../../../server/modules/admin/users/services/admin-game-state.js');
  }

  it('alvo inexistente → 404', async () => {
    (prismaMock.prisma as { users: { findUnique: ReturnType<typeof vi.fn> } }).users.findUnique.mockResolvedValue(
      null
    );
    const { applyAdminSaveGameOverride } = await load();
    await expect(
      applyAdminSaveGameOverride({
        targetUserId: 99,
        actorUserId: 1,
        changes: { stock: { a: 1 } },
        pool: pool as never
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(progressMock.computeProgressForUser).not.toHaveBeenCalled();
  });

  it('liquida progresso antes de pool.connect', async () => {
    const { applyAdminSaveGameOverride } = await load();
    const callOrder: string[] = [];
    progressMock.computeProgressForUser.mockImplementation(async () => {
      callOrder.push('progress');
      return { ok: true };
    });
    pool.connect.mockImplementation(async () => {
      callOrder.push('connect');
      return client;
    });
    await applyAdminSaveGameOverride({
      targetUserId: 10,
      actorUserId: 1,
      changes: { stock: { 'gpu.basic': 1 } },
      pool: pool as never
    });
    expect(progressMock.computeProgressForUser).toHaveBeenCalledWith(pool, 10, expect.any(Number), true);
    expect(callOrder).toEqual(['progress', 'connect']);
  });

  it('progress.ok false → 503 e não abre TX', async () => {
    progressMock.computeProgressForUser.mockResolvedValue({ ok: false });
    const { applyAdminSaveGameOverride } = await load();
    await expect(
      applyAdminSaveGameOverride({
        targetUserId: 10,
        actorUserId: 1,
        changes: { stock: { 'gpu.basic': 1 } },
        pool: pool as never
      })
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('coinBalances via wallet worker após COMMIT; sem SQL coin_balances no Node', async () => {
    const { applyAdminSaveGameOverride } = await load();
    await applyAdminSaveGameOverride({
      targetUserId: 10,
      actorUserId: 1,
      changes: { coinBalances: { btc: 1.5, eth: 0 } },
      pool: pool as never
    });
    const upsertCalls = client.query.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO coin_balances')
    );
    expect(upsertCalls.length).toBe(0);
    expect(callWalletAdminSaveGameBalances).toHaveBeenCalledWith({
      userId: 10,
      coinBalances: { btc: 1.5, eth: 0 },
      serverNowMs: expect.any(Number)
    });
  });

  it('GENESIS_HARDWARE_URL: persist via callHardwarePersist; USDC via wallet', async () => {
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    const callHardwarePersist = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock(HARDWARE_CLIENT_PATH, () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwarePersist
    }));
    const { applyAdminSaveGameOverride } = await load();
    const out = await applyAdminSaveGameOverride({
      targetUserId: 10,
      actorUserId: 1,
      changes: { stock: { 'gpu.basic': 5, gone: 0 }, usdc: 12.5 },
      reason: 'test',
      pool: pool as never
    });
    expect(out).toMatchObject({ ok: true, stock: { 'gpu.basic': 2 } });
    expect(callHardwarePersist).toHaveBeenCalledTimes(1);
    expect(callHardwarePersist).toHaveBeenCalledWith({
      userId: 10,
      stock: { 'gpu.basic': 5 },
      stockMode: 'merge'
    });
    expect(
      (persistMock.persistStockStoredBatteriesPlacedRacks as ReturnType<typeof vi.fn>)
    ).not.toHaveBeenCalled();
    const stockSql = client.query.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && /INSERT INTO stock|INSERT INTO placed_racks/i.test(String(c[0]))
    );
    expect(stockSql).toHaveLength(0);
    const usdcSql = client.query.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('UPDATE game_states SET usdc')
    );
    expect(usdcSql).toHaveLength(0);
    expect(callWalletAdminSaveGameBalances).toHaveBeenCalledWith({
      userId: 10,
      usdc: 12.5,
      serverNowMs: expect.any(Number)
    });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('GENESIS_HARDWARE_URL: persist throw → ROLLBACK sem wallet money', async () => {
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    const callHardwarePersist = vi.fn().mockRejectedValue(new Error('hardware persist failed'));
    vi.doMock(HARDWARE_CLIENT_PATH, () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwarePersist
    }));
    const { applyAdminSaveGameOverride } = await load();
    await expect(
      applyAdminSaveGameOverride({
        targetUserId: 10,
        actorUserId: 1,
        changes: { stock: { 'gpu.basic': 5 }, usdc: 12.5 },
        pool: pool as never
      })
    ).rejects.toThrow('hardware persist failed');
    expect(
      (persistMock.persistStockStoredBatteriesPlacedRacks as ReturnType<typeof vi.fn>)
    ).not.toHaveBeenCalled();
    expect(callWalletAdminSaveGameBalances).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

describe('loadAdminGameStateByEmail', () => {
  let prismaMock: Record<string, any>;
  let snapshotMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 7 }),
          findUnique: vi.fn()
        },
        game_states: {
          findUnique: vi.fn().mockResolvedValue({
            start_time: 100,
            claimed_referrals: 2,
            referral_bonus_claimed: 1,
            black_market_balance: 3
          })
        },
        coin_balances: {
          findMany: vi.fn().mockResolvedValue([{ coin_id: 'btc', amount: 0.5 }])
        },
        unopened_boxes: {
          findMany: vi.fn().mockResolvedValue([
            { box_id: 'box_a', qty: 2 },
            { box_id: 'box_b', qty: 1 }
          ])
        },
        user_rig_rooms: {
          findMany: vi.fn().mockResolvedValue([{ room_id: 'room_extra' }])
        }
      }
    };
    snapshotMock = {
      buildServersAuthoritativeStateDto: vi.fn().mockResolvedValue({
        usdc: 9,
        serverUpdatedAt: 999,
        stock: { a: 1 },
        storedBatteries: [],
        placedRacks: [{ id: 'r1', roomId: 'room_nft' }],
        asicLeaseDetails: [{ leaseId: 'L1' }]
      })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/servers/services/state-snapshot.js', () => snapshotMock);
    vi.doMock('../../../../../server/modules/hardware/services/persistence.js', () => ({}));
    vi.doMock('../../../../../server/modules/mining-engine/services/progress-computer.js', () => ({
      computeProgressForUser: vi.fn()
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/servers/services/state-snapshot.js');
    vi.doUnmock('../../../../../server/modules/hardware/services/persistence.js');
    vi.doUnmock('../../../../../server/modules/mining-engine/services/progress-computer.js');
  });

  it('404 se email não existe (nunca cria user)', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const { loadAdminGameStateByEmail } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    await expect(loadAdminGameStateByEmail('ghost@x.com')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('adminEdit limpa leases e preenche defaults GameState', async () => {
    const { loadAdminGameStateByEmail } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    const out = await loadAdminGameStateByEmail('a@b.c', { adminEdit: true });
    expect(out).toMatchObject({
      usdc: 9,
      startTime: 100,
      stock: { a: 1 },
      coinBalances: { btc: 0.5 },
      claimedReferrals: 2,
      referralBonusClaimed: true,
      blackMarketBalance: 3,
      unopenedBoxes: { box_a: 2, box_b: 1 },
      claimedBoxes: [],
      playerListings: [],
      dailyActions: {},
      asicLeases: [],
      asicLeaseDetails: [],
      serverUpdatedAt: 999,
      ownedRoomIds: [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID, 'room_extra', 'room_nft']
    });
    expect(snapshotMock.buildServersAuthoritativeStateDto).toHaveBeenCalledWith(7, { skipProgress: true });
    expect(prismaMock.prisma.unopened_boxes.findMany).toHaveBeenCalledWith({
      where: { user_id: 7 },
      select: { box_id: true, qty: true }
    });
    expect(prismaMock.prisma.users.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'a@b.c', mode: 'insensitive' } },
      select: { id: true }
    });
  });

  it('sem adminEdit não passa skipProgress true', async () => {
    const { loadAdminGameStateByEmail } = await import(
      '../../../../../server/modules/admin/users/services/admin-game-state.js'
    );
    await loadAdminGameStateByEmail('a@b.c');
    expect(snapshotMock.buildServersAuthoritativeStateDto).toHaveBeenCalledWith(7, undefined);
  });
});
