import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('computePlayerGameHeaderSnapshot', () => {
  let prismaMock: Record<string, any>;
  let checkinMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        game_states: { findUnique: vi.fn() },
        coin_balances: { findMany: vi.fn().mockResolvedValue([]) },
        upgrades: { findMany: vi.fn().mockResolvedValue([]) },
        placed_racks: { findMany: vi.fn().mockResolvedValue([]) },
        rack_slots: { findMany: vi.fn().mockResolvedValue([]) },
        rack_multiplier_slots: { findMany: vi.fn().mockResolvedValue([]) },
        rig_rooms: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([])
      }
    };
    checkinMock = { isCheckinFrozenForUser: vi.fn().mockResolvedValue(false) };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/checkin/services/checkin.js', () => checkinMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/checkin/services/checkin.js');
  });

  it('sem game_state: devolve payload zerado', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue(null);
    const { computePlayerGameHeaderSnapshot } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap).toMatchObject({
      coinBalances: {},
      usdc: 0,
      hashByCoinId: {},
      totalHash: 0,
      rigsTotal: 0,
      rigsOnline: 0
    });
  });

  it('checkin frozen: não lê racks, hash total fica 0', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({
      usdc: 5,
      server_updated_at: 1000,
      last_checkin_at_ms: 500,
      checkin_bonus_hps: 0
    });
    checkinMock.isCheckinFrozenForUser.mockResolvedValue(true);
    const { computePlayerGameHeaderSnapshot, resetUpgradesCatalogCacheForTests } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    resetUpgradesCatalogCacheForTests();
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap.usdc).toBe(5);
    expect(snap.totalHash).toBe(0);
    expect(prismaMock.prisma.placed_racks.findMany).not.toHaveBeenCalled();
  });

  it('rig ligada, com wiring/bateria e moeda selecionada: soma hash na moeda', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({
      usdc: 0,
      server_updated_at: 1000,
      last_checkin_at_ms: null,
      checkin_bonus_hps: 0
    });
    prismaMock.prisma.upgrades.findMany.mockResolvedValue([
      { id: 'gpu_1', base_production: 10, multiplier: 0, power_capacity: null, type: 'machine', category: null, nft_mining_coin_id: null }
    ]);
    prismaMock.prisma.placed_racks.findMany.mockResolvedValue([
      { id: 'rack_1', item_id: null, is_on: 1, wiring_id: 'w1', battery_id: 'b1', selected_coin_id: 'btc', room_id: 'sala_1' }
    ]);
    prismaMock.prisma.rack_slots.findMany.mockResolvedValue([{ rack_id: 'rack_1', slot_index: 0, machine_item_id: 'gpu_1' }]);

    const { computePlayerGameHeaderSnapshot, resetUpgradesCatalogCacheForTests } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    resetUpgradesCatalogCacheForTests();
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap.hashByCoinId.btc).toBe(10);
    expect(snap.totalHash).toBe(10);
    expect(snap.rigsTotal).toBe(1);
    expect(snap.rigsOnline).toBe(1);
  });

  it('Sala ASICs: hashByCoinId inclui poder; totalHash não', async () => {
    const { ASIC_ROOM_ID } = await import('../../../../server/modules/mining-engine/services/room-kind.js');
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({
      usdc: 0,
      server_updated_at: 1000,
      last_checkin_at_ms: null,
      checkin_bonus_hps: 0
    });
    prismaMock.prisma.upgrades.findMany.mockResolvedValue([
      { id: 'gpu_1', base_production: 10, multiplier: 0, power_capacity: null, type: 'machine', category: null, nft_mining_coin_id: null }
    ]);
    prismaMock.prisma.placed_racks.findMany.mockResolvedValue([
      { id: 'rack_1', item_id: null, is_on: 1, wiring_id: 'w1', battery_id: 'b1', selected_coin_id: 'btc', room_id: ASIC_ROOM_ID }
    ]);
    prismaMock.prisma.rack_slots.findMany.mockResolvedValue([{ rack_id: 'rack_1', slot_index: 0, machine_item_id: 'gpu_1' }]);

    const { computePlayerGameHeaderSnapshot, resetUpgradesCatalogCacheForTests } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    resetUpgradesCatalogCacheForTests();
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap.hashByCoinId.btc).toBe(10);
    expect(snap.totalHash).toBe(0);
  });

  it('rig desligada não contribui hash', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({
      usdc: 0,
      server_updated_at: 1000,
      last_checkin_at_ms: null,
      checkin_bonus_hps: 0
    });
    prismaMock.prisma.placed_racks.findMany.mockResolvedValue([
      { id: 'rack_1', item_id: null, is_on: 0, wiring_id: 'w1', battery_id: 'b1', selected_coin_id: 'btc', room_id: 'sala_1' }
    ]);
    const { computePlayerGameHeaderSnapshot, resetUpgradesCatalogCacheForTests } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    resetUpgradesCatalogCacheForTests();
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap.totalHash).toBe(0);
  });

  it('estCoinsPerSec = hash × yield_per_hash do histórico', async () => {
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({
      usdc: 0,
      server_updated_at: 1000,
      last_checkin_at_ms: null,
      checkin_bonus_hps: 0
    });
    prismaMock.prisma.upgrades.findMany.mockResolvedValue([
      { id: 'gpu_1', base_production: 10, multiplier: 0, power_capacity: null, type: 'machine', category: null, nft_mining_coin_id: null }
    ]);
    prismaMock.prisma.placed_racks.findMany.mockResolvedValue([
      { id: 'rack_1', item_id: null, is_on: 1, wiring_id: 'w1', battery_id: 'b1', selected_coin_id: 'btc', room_id: 'sala_1' }
    ]);
    prismaMock.prisma.rack_slots.findMany.mockResolvedValue([{ rack_id: 'rack_1', slot_index: 0, machine_item_id: 'gpu_1' }]);
    prismaMock.prisma.$queryRaw.mockResolvedValue([{ coin_id: 'btc', yield_per_hash: 0.002 }]);

    const { computePlayerGameHeaderSnapshot, resetUpgradesCatalogCacheForTests } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    resetUpgradesCatalogCacheForTests();
    const snap = await computePlayerGameHeaderSnapshot(1);
    expect(snap.hashByCoinId.btc).toBe(10);
    expect(snap.estCoinsPerSecByCoinId.btc).toBe(0.02);
    expect(snap.liveAccrualAnchorMs).toBeGreaterThan(0);
  });

  it('estimateCoinsPerSecByCoinId ignora hash ou yield inválidos', async () => {
    const { estimateCoinsPerSecByCoinId } = await import(
      '../../../../server/modules/mining-engine/services/player-game-header-snapshot.js'
    );
    expect(
      estimateCoinsPerSecByCoinId({ btc: 50, eth: 0, doge: 10 }, { btc: 0.001, eth: 1, doge: 0 })
    ).toEqual({ btc: 0.05 });
  });
});
