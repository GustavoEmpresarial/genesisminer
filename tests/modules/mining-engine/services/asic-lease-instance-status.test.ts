/**
 * Node no-URL fallback: after each lease status write, same TX mirrors item_instances.
 * Never DELETE instance rows.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  expireUserAsicLeases,
  markLeaseEquipped,
  releaseEquippedAsicLease,
  releaseEquippedAsicLeaseById
} from '../../../../server/modules/mining-engine/services/asic-lease.js';
import { MS_PER_MINUTE } from '../../../../server/shared/utils/time.js';

const USER_ID = 42;
const LEASE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = 'asic_timed_a';
const RACK_ID = 'rack1';
const SLOT_INDEX = 0;
const ACQUIRED_AT = 1_000_000;
const EXPIRES_AT = 2_000_000;
const NOW_MS = 2_000_100;
const FUTURE_EXPIRES_AT = NOW_MS + MS_PER_MINUTE;

const ASIC_LEASE_STATUS_STOCK = 'stock';
const ASIC_LEASE_STATUS_EQUIPPED = 'equipped';
const ASIC_LEASE_STATUS_EXPIRED = 'expired';

function instanceMirrorCalls(query: ReturnType<typeof vi.fn>): unknown[][] {
  return query.mock.calls.filter((c) => String(c[0]).includes('UPDATE item_instances'));
}

describe('asic-lease instance status mirror', () => {
  it('expireUserAsicLeases mirrors expired + clears rack/slot', async () => {
    const client = {
      query: vi.fn(async (sqlRaw: string) => {
        const sql = String(sqlRaw);
        if (sql.includes('expires_at <=') && sql.includes('FOR UPDATE')) {
          return {
            rows: [
              {
                id: LEASE_ID,
                item_id: ITEM_ID,
                status: ASIC_LEASE_STATUS_EQUIPPED,
                rack_id: RACK_ID,
                slot_index: SLOT_INDEX,
                acquired_at: ACQUIRED_AT,
                expires_at: EXPIRES_AT
              }
            ]
          };
        }
        if (sql.includes('INSERT INTO mining_eligibility_events')) {
          return { rows: [{ id: '1' }], rowCount: 1 };
        }
        if (sql.includes('SELECT DISTINCT item_id')) {
          return { rows: [{ item_id: ITEM_ID }] };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ n: 0 }] };
        }
        return { rows: [], rowCount: 1 };
      })
    } as unknown as PoolClient;

    const n = await expireUserAsicLeases(client, USER_ID, NOW_MS);
    expect(n).toBe(1);
    expect(instanceMirrorCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
      [
        expect.stringContaining('UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1'),
        [LEASE_ID, ASIC_LEASE_STATUS_EXPIRED, null, null]
      ]
    ]);
  });

  it('markLeaseEquipped mirrors equipped + rack + slot', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 }))
    } as unknown as PoolClient;

    await markLeaseEquipped(client, LEASE_ID, USER_ID, RACK_ID, SLOT_INDEX);
    expect(instanceMirrorCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
      [
        expect.stringContaining('UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1'),
        [LEASE_ID, ASIC_LEASE_STATUS_EQUIPPED, RACK_ID, SLOT_INDEX]
      ]
    ]);
  });

  it('releaseEquippedAsicLeaseById mirrors stock + clears rack/slot', async () => {
    const client = {
      query: vi.fn(async (sqlRaw: string) => {
        const sql = String(sqlRaw);
        if (sql.includes('FROM player_asic_leases WHERE id = $1 AND user_id = $2')) {
          return {
            rows: [
              {
                id: LEASE_ID,
                item_id: ITEM_ID,
                expires_at: FUTURE_EXPIRES_AT,
                acquired_at: ACQUIRED_AT,
                status: ASIC_LEASE_STATUS_EQUIPPED,
                rack_id: RACK_ID,
                slot_index: SLOT_INDEX
              }
            ]
          };
        }
        if (sql.includes('INSERT INTO mining_eligibility_events')) {
          return { rows: [{ id: '1' }], rowCount: 1 };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ n: 1 }] };
        }
        return { rows: [], rowCount: 1 };
      })
    } as unknown as PoolClient;

    const ok = await releaseEquippedAsicLeaseById(client, USER_ID, LEASE_ID, ITEM_ID, NOW_MS);
    expect(ok).toBe(true);
    expect(instanceMirrorCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
      [
        expect.stringContaining('UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1'),
        [LEASE_ID, ASIC_LEASE_STATUS_STOCK, null, null]
      ]
    ]);
  });

  it('releaseEquippedAsicLease mirrors stock when lease is still valid', async () => {
    const client = {
      query: vi.fn(async (sqlRaw: string) => {
        const sql = String(sqlRaw);
        if (sql.includes('SELECT machine_item_id, machine_lease_id FROM rack_slots')) {
          return { rows: [{ machine_item_id: ITEM_ID, machine_lease_id: LEASE_ID }] };
        }
        if (sql.includes('FROM player_asic_leases WHERE id = $1 AND user_id = $2')) {
          return {
            rows: [
              {
                id: LEASE_ID,
                item_id: ITEM_ID,
                expires_at: FUTURE_EXPIRES_AT,
                acquired_at: ACQUIRED_AT,
                status: ASIC_LEASE_STATUS_EQUIPPED
              }
            ]
          };
        }
        if (sql.includes('INSERT INTO mining_eligibility_events')) {
          return { rows: [{ id: '1' }], rowCount: 1 };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ n: 1 }] };
        }
        return { rows: [], rowCount: 1 };
      })
    } as unknown as PoolClient;

    await releaseEquippedAsicLease(client, USER_ID, RACK_ID, SLOT_INDEX, NOW_MS);
    expect(instanceMirrorCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
      [
        expect.stringContaining('UPDATE item_instances SET status = $2, rack_id = $3, slot_index = $4 WHERE id = $1'),
        [LEASE_ID, ASIC_LEASE_STATUS_STOCK, null, null]
      ]
    ]);
  });

  it('never DELETE item_instances on expire / release / equip', async () => {
    const seen: string[] = [];
    const client = {
      query: vi.fn(async (sqlRaw: string) => {
        const sql = String(sqlRaw);
        seen.push(sql);
        if (sql.includes('expires_at <=') && sql.includes('FOR UPDATE')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT machine_item_id, machine_lease_id FROM rack_slots')) {
          return { rows: [] };
        }
        if (sql.includes('FROM player_asic_leases WHERE id = $1')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      })
    } as unknown as PoolClient;

    await expireUserAsicLeases(client, USER_ID, NOW_MS);
    await markLeaseEquipped(client, LEASE_ID, USER_ID, RACK_ID, SLOT_INDEX);
    await releaseEquippedAsicLease(client, USER_ID, RACK_ID, SLOT_INDEX, NOW_MS);
    await releaseEquippedAsicLeaseById(client, USER_ID, LEASE_ID, ITEM_ID, NOW_MS);
    expect(seen.some((sql) => /DELETE\s+FROM\s+item_instances/i.test(sql))).toBe(false);
  });
});
