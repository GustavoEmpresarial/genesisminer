/**
 * OCC / catalogRevision no merge — bump só em INSERT real.
 */
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

describe('merge catalogRevision OCC (T6)', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let dbMock: Record<string, unknown>;
  let settingsMock: Record<string, unknown>;
  let auditMock: Record<string, unknown>;
  let questMock: Record<string, unknown>;
  let metaRevision: number;
  let prevHardwareUrl: string | undefined;

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

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callMergeExecute: vi.fn().mockImplementation(async (payload: { credit: Array<{ itemId: string; qty: number }> }) => {
        const creditId = payload.credit[0]?.itemId ?? 'merge_result';
        const qty = payload.credit[0]?.qty ?? 1;
        return { ok: true, newUsdc: 990, stock: { gpu_1: 8, [creditId]: qty }, resultQty: qty };
      }),
      isHardwareMarketError: () => false
    }));
    vi.resetModules();
    metaRevision = 10;
    client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn()
    };
    dbMock = {
      default: {
        connect: vi.fn(async () => client),
        query: vi.fn().mockResolvedValue({ rows: [] })
      }
    };
    settingsMock = {
      loadMergeSettings: vi.fn().mockResolvedValue(MERGE_SETTINGS),
      isMergeTypeEnabled: vi.fn().mockReturnValue(true),
      anyMergeTypeEnabled: vi.fn().mockReturnValue(true)
    };
    auditMock = { recordInventoryMovement: vi.fn().mockResolvedValue(undefined) };
    questMock = { bumpQuestProgress: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../server/modules/merge/services/settings.js', () => settingsMock);
    vi.doMock('../../../../server/shared/audit/inventory-movement.js', () => auditMock);
    vi.doMock('../../../../server/modules/quests/services/quest.js', () => questMock);
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/modules/merge/services/settings.js');
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
    vi.doUnmock('../../../../server/shared/audit/inventory-movement.js');
    vi.doUnmock('../../../../server/modules/quests/services/quest.js');
  });

  function baseMergeMocks(opts: { insertRowCount: number; existingByStats?: boolean; dupById?: boolean }) {
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('SET LOCAL lock_timeout')) return { rows: [] };
      if (s.includes('SELECT is_blocked FROM users')) return { rows: [{ is_blocked: 0 }] };
      if (s.includes('FOR SHARE')) return { rows: [mockRow()] };
      if (s.includes('INNER JOIN upgrades u ON u.id = s.item_id')) {
        return { rows: [{ ...mockRow(), item_id: 'gpu_1', qty: 10 }] };
      }
      if (s.startsWith('SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2 FOR UPDATE')) {
        return { rows: [{ qty: 10 }] };
      }
      if (s.includes('FROM game_states WHERE user_id = $1')) return { rows: [{ usdc: 1000 }] };
      if (s.includes('SELECT id, base_cost') && s.includes('FROM upgrades')) {
        if (opts.existingByStats) {
          return {
            rows: [
              {
                id: 'merge_gpu_1_uncommon_existing',
                base_cost: 100,
                base_production: 10.5,
                power_consumption: 200,
                multiplier: null,
                slots_capacity: null,
                ai_slots_capacity: null
              }
            ]
          };
        }
        return { rows: [] };
      }
      if (s.startsWith('SELECT id FROM upgrades WHERE id = $1')) {
        return opts.dupById ? { rows: [{ id: 'merge_dup' }] } : { rows: [] };
      }
      if (/upgrades_catalog_meta/i.test(s)) {
        if (/\bINSERT\b/i.test(s)) return { rows: [] };
        if (/\bUPDATE\b/i.test(s) && /revision\s*\+/i.test(s)) {
          metaRevision += 1;
          return { rows: [{ revision: metaRevision }] };
        }
        if (/\bSELECT\b/i.test(s) && /FOR UPDATE/i.test(s)) return { rows: [{ revision: metaRevision }] };
        return { rows: [{ revision: metaRevision }] };
      }
      if (/\bINSERT INTO upgrades\b/i.test(s)) {
        return { rows: opts.insertRowCount > 0 ? [{ id: 'merge_new' }] : [], rowCount: opts.insertRowCount };
      }
      if (s.includes('INSERT INTO upgrade_compat_racks') || s.includes('DELETE FROM upgrade_compat_racks')) {
        return { rows: [] };
      }
      if (s.includes('INSERT INTO merge_history')) return { rows: [] };
      if (s.includes('INSERT INTO stock') || s.includes('UPDATE stock') || s.includes('DELETE FROM stock')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });
  }

  it('7) merge novo (INSERT real) locka meta e bumpa revision', async () => {
    baseMergeMocks({ insertRowCount: 1 });
    const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
    const result = await executeMerge(1, 'gpu_1', 1);
    expect(result.ok).toBe(true);
    const lock = client.query.mock.calls.some(
      ([sql]) => /upgrades_catalog_meta/i.test(String(sql)) && /FOR UPDATE/i.test(String(sql))
    );
    const bump = client.query.mock.calls.some(
      ([sql]) => /upgrades_catalog_meta/i.test(String(sql)) && /revision\s*=\s*revision\s*\+\s*1/i.test(String(sql))
    );
    const insert = client.query.mock.calls.some(([sql]) => /\bINSERT INTO upgrades\b/i.test(String(sql)));
    expect(lock).toBe(true);
    expect(insert).toBe(true);
    expect(bump).toBe(true);
    expect(metaRevision).toBe(11);
  });

  it('8) merge existente (ON CONFLICT DO NOTHING / rowCount 0) não bumpa revision', async () => {
    baseMergeMocks({ insertRowCount: 0 });
    const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
    await executeMerge(1, 'gpu_1', 1);
    const bump = client.query.mock.calls.some(
      ([sql]) => /upgrades_catalog_meta/i.test(String(sql)) && /revision\s*=\s*revision\s*\+\s*1/i.test(String(sql))
    );
    expect(bump).toBe(false);
    expect(metaRevision).toBe(10);
  });

  it('reuse por statsMatchExisting: sem INSERT upgrades e sem bump', async () => {
    // statsMatchExisting exige igualdade exacta de números — devolve preview stats via compute.
    // Se a query de existing devolver row que não matcha, cai no INSERT path.
    // Aqui simulamos dup por id (SKU já existe): sem INSERT, sem bump.
    baseMergeMocks({ insertRowCount: 1, dupById: true });
    const { executeMerge } = await import('../../../../server/modules/merge/services/merge.js');
    await executeMerge(1, 'gpu_1', 1);
    const insert = client.query.mock.calls.some(([sql]) => /\bINSERT INTO upgrades\b/i.test(String(sql)));
    const bump = client.query.mock.calls.some(
      ([sql]) => /upgrades_catalog_meta/i.test(String(sql)) && /revision\s*=\s*revision\s*\+\s*1/i.test(String(sql))
    );
    expect(insert).toBe(false);
    expect(bump).toBe(false);
  });
});
