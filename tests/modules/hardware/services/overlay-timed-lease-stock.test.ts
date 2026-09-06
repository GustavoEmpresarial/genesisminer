import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * overlayTimedLeaseStockCounts: qty autoritativa de ASICs timed =
 * COUNT leases status=stock AND expires_at > now; qty 0 → delete key.
 */
describe('overlayTimedLeaseStockCounts', () => {
  const TIMED_ITEM = 'asic.timed.a';
  const PERM_ITEM = 'gpu.basic';
  const LEASE_ONLY_TIMED = 'asic.timed.b';
  const TIMED_CFG = { amount: 7, unit: 'day' as const };
  const PERM_CFG = { amount: 0, unit: null };

  let asicLeaseMock: {
    loadAsicDurationConfig: ReturnType<typeof vi.fn>;
    isTimedAsicDuration: ReturnType<typeof vi.fn>;
    reconcileTimedAsicStockLeases: ReturnType<typeof vi.fn>;
    releaseAllEquippedLeasesOnRack: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    asicLeaseMock = {
      reconcileTimedAsicStockLeases: vi.fn().mockResolvedValue(undefined),
      releaseAllEquippedLeasesOnRack: vi.fn().mockResolvedValue(undefined),
      loadAsicDurationConfig: vi.fn(async (_client: unknown, itemId: string) => {
        if (itemId === TIMED_ITEM || itemId === LEASE_ONLY_TIMED) return TIMED_CFG;
        return PERM_CFG;
      }),
      isTimedAsicDuration: vi.fn((cfg: { amount: number; unit: string | null }) => cfg.amount > 0 && cfg.unit != null)
    };
    vi.doMock('../../../../server/modules/mining-engine/services/asic-lease.js', () => asicLeaseMock);
    vi.doMock('../../../../server/modules/hardware/services/semantic-sync.js', () => ({
      syncStoredBatterySemanticsForUser: vi.fn().mockResolvedValue(undefined)
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/mining-engine/services/asic-lease.js');
    vi.doUnmock('../../../../server/modules/hardware/services/semantic-sync.js');
  });

  it('overwrites timed stock qty from valid lease counts and deletes when zero', async () => {
    const { overlayTimedLeaseStockCounts } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    const stock: Record<string, number> = {
      [TIMED_ITEM]: 99,
      [PERM_ITEM]: 3
    };

    const client = {
      query: vi.fn(async (sqlRaw: string, params?: unknown[]) => {
        const sql = String(sqlRaw);
        if (sql.includes('SELECT DISTINCT item_id FROM player_asic_leases')) {
          return { rows: [{ item_id: LEASE_ONLY_TIMED }, { item_id: TIMED_ITEM }] };
        }
        if (sql.includes("status = 'stock'") && sql.includes('expires_at >')) {
          const itemId = String(params?.[1] ?? '');
          if (itemId === TIMED_ITEM) return { rows: [{ n: 2 }] };
          if (itemId === LEASE_ONLY_TIMED) return { rows: [{ n: 0 }] };
          return { rows: [{ n: 0 }] };
        }
        return { rows: [] };
      })
    } as unknown as PoolClient;

    await overlayTimedLeaseStockCounts(client, 42, stock);

    expect(stock[TIMED_ITEM]).toBe(2);
    expect(stock[PERM_ITEM]).toBe(3);
    expect(stock[LEASE_ONLY_TIMED]).toBeUndefined();
    expect(asicLeaseMock.loadAsicDurationConfig).toHaveBeenCalled();
    expect(asicLeaseMock.isTimedAsicDuration).toHaveBeenCalled();
  });
});
