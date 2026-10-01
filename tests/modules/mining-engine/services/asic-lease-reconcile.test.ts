/**
 * reconcileTimedAsicStockLeases: mint only when allowMint && target > COUNT(stock);
 * sync writes qty = COUNT real.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { reconcileTimedAsicStockLeases } from '../../../../server/modules/mining-engine/services/asic-lease.js';

const USER_ID = 42;
const ITEM_ID = 'asic_timed_reconcile';
const NOW_MS = 1_700_000_000_000;
const TARGET_QTY = 10;
const STOCK_LEASE_COUNT = 3;
const TRIM_DELETED_LEASE_IDS = [
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
] as const;

const TIMED_UPGRADE_ROW = {
  type: 'machine',
  category: 'asic',
  id: ITEM_ID,
  asic_duration_amount: 7,
  asic_duration_unit: 'day',
  asic_duration_kind: 'timed'
};

function isUpgradeLookup(sql: string): boolean {
  return sql.includes('FROM upgrades WHERE id');
}

function isStockLeaseCount(sql: string): boolean {
  return sql.includes('COUNT(*)') && sql.includes("status = 'stock'") && sql.includes('expires_at >');
}

describe('reconcileTimedAsicStockLeases', () => {
  it('does not mint leases when allowMint=false and target > stock lease count; sync writes qty = count', async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    let stockLeaseCountReads = 0;

    const client = {
      query: vi.fn(async (sqlRaw: string, params?: unknown[]) => {
        const sql = String(sqlRaw);
        queries.push({ sql, params });

        if (isUpgradeLookup(sql)) {
          return { rows: [TIMED_UPGRADE_ROW] };
        }

        if (isStockLeaseCount(sql)) {
          stockLeaseCountReads += 1;
          return { rows: [{ n: STOCK_LEASE_COUNT }] };
        }

        if (sql.includes('INSERT INTO stock')) {
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('INSERT INTO player_asic_leases')) {
          throw new Error('unexpected lease mint INSERT during reconcile');
        }

        if (sql.includes('DELETE FROM player_asic_leases')) {
          throw new Error('unexpected lease DELETE when target > current');
        }

        return { rows: [] };
      })
    } as unknown as PoolClient;

    const ok = await reconcileTimedAsicStockLeases(client, USER_ID, ITEM_ID, TARGET_QTY, NOW_MS, false);

    expect(ok).toBe(true);
    expect(queries.some((q) => q.sql.includes('INSERT INTO player_asic_leases'))).toBe(false);
    expect(stockLeaseCountReads).toBeGreaterThanOrEqual(2);

    const stockUpsert = queries.find((q) => q.sql.includes('INSERT INTO stock'));
    expect(stockUpsert).toBeDefined();
    expect(stockUpsert!.params).toEqual([USER_ID, ITEM_ID, STOCK_LEASE_COUNT]);
  });

  it('mints (target - current) leases when allowMint=true and target > current', async () => {
    const toMint = TARGET_QTY - STOCK_LEASE_COUNT;
    let leaseCountPhase = 0;
    let leaseInserts = 0;

    const client = {
      query: vi.fn(async (sqlRaw: string, _params?: unknown[]) => {
        const sql = String(sqlRaw);

        if (isUpgradeLookup(sql)) {
          return { rows: [TIMED_UPGRADE_ROW] };
        }

        if (isStockLeaseCount(sql)) {
          leaseCountPhase += 1;
          const n = leaseCountPhase === 1 ? STOCK_LEASE_COUNT : TARGET_QTY;
          return { rows: [{ n }] };
        }

        if (sql.includes('INSERT INTO player_asic_leases')) {
          leaseInserts += 1;
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('INSERT INTO item_instances')) {
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('INSERT INTO stock')) {
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('DELETE FROM player_asic_leases')) {
          throw new Error('unexpected lease DELETE when minting');
        }

        return { rows: [] };
      })
    } as unknown as PoolClient;

    const ok = await reconcileTimedAsicStockLeases(client, USER_ID, ITEM_ID, TARGET_QTY, NOW_MS, true);
    expect(ok).toBe(true);
    expect(leaseInserts).toBe(toMint);
    const stockUpsert = (client.query as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO stock')
    );
    expect(stockUpsert?.[1]).toEqual([USER_ID, ITEM_ID, TARGET_QTY]);
  });

  it('deletes excess stock leases when target < current', async () => {
    const TARGET = 1;
    const CURRENT = 3;
    let leaseCountPhase = 0;

    const client = {
      query: vi.fn(async (sqlRaw: string, params?: unknown[]) => {
        const sql = String(sqlRaw);

        if (isUpgradeLookup(sql)) {
          return { rows: [TIMED_UPGRADE_ROW] };
        }

        if (sql.includes('COUNT(*)') && sql.includes("status = 'stock'")) {
          leaseCountPhase += 1;
          // After DELETE, sync sees TARGET remaining.
          const n = leaseCountPhase === 1 ? CURRENT : TARGET;
          return { rows: [{ n }] };
        }

        if (sql.includes('DELETE FROM player_asic_leases')) {
          expect(params?.[3]).toBe(CURRENT - TARGET);
          return {
            rows: TRIM_DELETED_LEASE_IDS.map((id) => ({ id })),
            rowCount: CURRENT - TARGET
          };
        }

        if (sql.includes('UPDATE item_instances') && sql.includes('ANY($1')) {
          return { rows: [], rowCount: CURRENT - TARGET };
        }

        if (sql.includes('INSERT INTO stock')) {
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes('INSERT INTO player_asic_leases')) {
          throw new Error('unexpected lease mint INSERT during trim reconcile');
        }

        return { rows: [] };
      })
    } as unknown as PoolClient;

    const ok = await reconcileTimedAsicStockLeases(client, USER_ID, ITEM_ID, TARGET, NOW_MS);
    expect(ok).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM player_asic_leases'),
      [USER_ID, ITEM_ID, NOW_MS, CURRENT - TARGET]
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE item_instances SET status = $2 WHERE id = ANY($1::uuid[])'),
      [[...TRIM_DELETED_LEASE_IDS], 'consumed']
    );
    const stockUpsert = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO stock')
    );
    expect(stockUpsert?.[1]).toEqual([USER_ID, ITEM_ID, TARGET]);
    expect(
      (client.query as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        /DELETE\s+FROM\s+item_instances/i.test(String(c[0]))
      )
    ).toBe(false);
  });
});
