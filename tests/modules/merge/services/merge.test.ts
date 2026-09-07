import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MERGE_SETTINGS = {
  enabled: true,
  enabledMachine: true,
  enabledMultiplier: true,
  enabledInfrastructure: true,
  gainPercent: 5,
  costPctByRarity: { common: 10, uncommon: 15, rare: 20, epic: 25, legendary: 30 },
  rackHsBonusPctByRarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, supreme: 0 }
};

describe('merge services/merge', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let dbMock: Record<string, unknown>;
  let settingsMock: Record<string, unknown>;
  let auditMock: Record<string, unknown>;
  let callMergeExecute: ReturnType<typeof vi.fn>;
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    vi.resetModules();
    callMergeExecute = vi.fn().mockImplementation(async (payload: { credit: Array<{ itemId: string; qty: number }>; count: number }) => {
      const creditId = payload.credit[0]?.itemId ?? 'merge_result';
      const qty = payload.credit[0]?.qty ?? 1;
      return { ok: true, newUsdc: 990, stock: { gpu_1: 8, [creditId]: qty }, resultQty: qty };
    });
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callMergeExecute,
      isHardwareMarketError: () => false
    }));
    client = {
      query: vi.fn(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    dbMock = {
      default: {
        connect: vi.fn(async () => client),
        query: vi.fn().mockResolvedValue({ rows: [] })
      }
    };
    settingsMock = { loadMergeSettings: vi.fn().mockResolvedValue(MERGE_SETTINGS), isMergeTypeEnabled: vi.fn().mockReturnValue(true), anyMergeTypeEnabled: vi.fn().mockReturnValue(true) };
    auditMock = { recordInventoryMovement: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../server/modules/merge/services/settings.js', () => settingsMock);
    vi.doMock('../../../../server/shared/audit/inventory-movement.js', () => auditMock);
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/modules/merge/services/settings.js');
    vi.doUnmock('../../../../server/shared/audit/inventory-movement.js');
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
  });

  describe('getMergePublicConfig', () => {
    it('monta config pública com raridades e tipos permitidos', async () => {
      const { getMergePublicConfig } = await import('../../../../server/modules/merge/services/merge.js');
      const cfg = await getMergePublicConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.allowedTypes).toEqual(['machine', 'multiplier', 'infrastructure']);
      expect(cfg.rarities.length).toBe(6);
    });
  });

  describe('executeMerge', () => {
    function mockRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'gpu_1',
        name: 'GPU X',
        category: 'gpu',
        type: 'machine',
        rarity: 'common',
        base_cost: 100,
        base_production: 10,
        power_consumption: 200,
        multiplier: null,
        slots_capacity: null,
        ai_slots_capacity: null,
        description: '',
        icon: '📦',
        image: null,
        status: 'normal',
        is_nft: 0,
        ...overrides
      };
    }

    function successClientMocks() {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FOR SHARE')) return { rows: [mockRow()] };
        if (s.includes('INNER JOIN upgrades u ON u.id = s.item_id')) return { rows: [{ ...mockRow(), item_id: 'gpu_1', qty: 10 }] };
        if (s.includes('FROM game_states WHERE user_id = $1')) return { rows: [{ usdc: 1000 }] };
        if (s.includes('SELECT id, base_cost') && s.includes('FROM upgrades')) return { rows: [] };
        if (s.startsWith('SELECT id FROM upgrades WHERE id = $1')) return { rows: [] };
        return { rows: [] };
      });
    }

    it('itemId vazio: BAD_ITEM, sem tocar na BD', async () => {
      const { executeMerge, MergeError } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, '', 1).catch((e) => e);
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('BAD_ITEM');
      expect(client.query).not.toHaveBeenCalled();
    });

    it('merge desactivado globalmente: MERGE_DISABLED', async () => {
      (settingsMock.loadMergeSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MERGE_SETTINGS, enabled: false });
      const { executeMerge, MergeError } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'gpu_1', 1).catch((e) => e);
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('MERGE_DISABLED');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('item de catálogo não encontrado: NOT_FOUND', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FROM upgrades WHERE id = $1 FOR SHARE')) return { rows: [] };
        return { rows: [] };
      });
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'nao_existe', 1).catch((e) => e);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('item NFT/proibido: ITEM_FORBIDDEN', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FOR SHARE')) return { rows: [mockRow({ is_nft: 1 })] };
        return { rows: [] };
      });
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'gpu_1', 1).catch((e) => e);
      expect(err.code).toBe('ITEM_FORBIDDEN');
    });

    it('raridade Supreme: SUPREME', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FOR SHARE')) return { rows: [mockRow({ rarity: 'supreme' })] };
        return { rows: [] };
      });
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'gpu_1', 1).catch((e) => e);
      expect(err.code).toBe('SUPREME');
    });

    it('stock insuficiente (< 2 unidades): INSUFFICIENT_STOCK', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FOR SHARE')) return { rows: [mockRow()] };
        if (s.includes('INNER JOIN upgrades u ON u.id = s.item_id')) return { rows: [{ ...mockRow(), item_id: 'gpu_1', qty: 1 }] };
        return { rows: [] };
      });
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'gpu_1', 1).catch((e) => e);
      expect(err.code).toBe('INSUFFICIENT_STOCK');
    });

    it('USDC insuficiente: INSUFFICIENT_USDC', async () => {
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
        if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
        if (s.includes('FOR SHARE')) return { rows: [mockRow()] };
        if (s.includes('INNER JOIN upgrades u ON u.id = s.item_id')) return { rows: [{ ...mockRow(), item_id: 'gpu_1', qty: 10 }] };
        if (s.includes('FROM game_states WHERE user_id = $1')) return { rows: [{ usdc: 1 }] };
        return { rows: [] };
      });
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const err = await executeMerge(1, 'gpu_1', 1).catch((e) => e);
      expect(err.code).toBe('INSUFFICIENT_USDC');
      expect(callMergeExecute).not.toHaveBeenCalled();
    });

    it('sucesso: callMergeExecute (fee+adjust+history worker), sem SQL USDC/history', async () => {
      successClientMocks();
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const result = await executeMerge(1, 'gpu_1', 1);
      expect(result.ok).toBe(true);
      expect(result.sourceRarity).toBe('common');
      expect(result.resultRarity).toBe('uncommon');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(callMergeExecute).toHaveBeenCalledTimes(1);
      expect(callMergeExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          sourceItemId: 'gpu_1',
          count: 1,
          debit: [{ itemId: 'gpu_1', qty: 2 }],
          credit: [{ itemId: expect.any(String), qty: 1 }]
        })
      );
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE game_states SET usdc'))).toBe(false);
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO merge_history'))).toBe(false);
      expect(auditMock.recordInventoryMovement).toHaveBeenCalledTimes(2);
    });

    it('count=3: envia historyTimestamps com 3 valores distintos ao worker', async () => {
      successClientMocks();
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const result = await executeMerge(1, 'gpu_1', 3);
      expect(result.ok).toBe(true);
      expect(callMergeExecute).toHaveBeenCalledTimes(1);
      const timestamps = callMergeExecute.mock.calls[0][0].historyTimestamps as number[];
      expect(timestamps).toHaveLength(3);
      expect(new Set(timestamps).size).toBe(3);
    });

    it('GENESIS_HARDWARE_URL: consume+craft via callMergeExecute — sem SQL stock', async () => {
      successClientMocks();
      const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
      const result = await executeMerge(1, 'gpu_1', 1);
      expect(result.ok).toBe(true);
      expect(result.resultQty).toBe(1);
      expect(result.sourceQty).toBe(8);
      expect(callMergeExecute).toHaveBeenCalledTimes(1);
      const stockMutations = client.query.mock.calls.filter(([sql]: unknown[]) => {
        const s = String(sql);
        return s.includes('DELETE FROM stock') || s.includes('UPDATE stock SET') || s.includes('INSERT INTO stock');
      });
      expect(stockMutations).toHaveLength(0);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(auditMock.recordInventoryMovement).toHaveBeenCalledTimes(2);
    });
  });

  describe('listMergeHistory', () => {
    it('agrega totais e devolve summary/recent', async () => {
      (dbMock.default as { query: ReturnType<typeof vi.fn> }).query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('COUNT(*)::text AS total')) return { rows: [{ total: '5', fee_total: 12.5 }] };
        if (s.includes('GROUP BY h.source_item_id')) return { rows: [] };
        if (s.includes('ORDER BY h.created_at DESC')) return { rows: [] };
        return { rows: [] };
      });
      const { listMergeHistory } = await import('../../../../server/modules/merge/services/merge.js');
      const hist = await listMergeHistory(1);
      expect(hist.totalMerges).toBe(5);
      expect(hist.feeTotalUsdc).toBe(12.5);
    });
  });
});
