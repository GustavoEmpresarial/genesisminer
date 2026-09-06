import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('computeAdminDashboardStatsUncached — topWithdrawalsByCoin', () => {
  let dbMock: { default: { query: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.resetModules();
    dbMock = {
      default: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('COUNT(*)') && sql.includes('is_blocked')) {
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('COUNT(DISTINCT s.user_id)')) {
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('SUM(gs.total_usdc_deposited)')) {
            return { rows: [{ total: 0 }] };
          }
          if (sql.includes('SUM(amount_usdc)')) {
            return { rows: [{ total: 0 }] };
          }
          if (sql.includes('ORDER BY id DESC LIMIT 10')) {
            return { rows: [] };
          }
          if (sql.includes('total_usdc_deposited > 0')) {
            return { rows: [] };
          }
          if (sql.includes('user_power')) {
            return { rows: [] };
          }
          if (sql.includes('ranking_excluded')) {
            return { rows: [] };
          }
          if (sql.includes('FROM mining_coins ORDER BY name')) {
            return {
              rows: [
                { id: 'btc', name: 'Bitcoin' },
                { id: 'eth', name: 'Ethereum' }
              ]
            };
          }
          if (sql.includes('ROW_NUMBER()') && sql.includes('withdrawal_requests')) {
            return {
              rows: [
                { coin_id: 'btc', coin_name: 'Bitcoin', username: 'a', email: 'a@a.a', total: 10 },
                { coin_id: 'btc', coin_name: 'Bitcoin', username: 'b', email: 'b@b.b', total: 5 },
                { coin_id: 'eth', coin_name: 'Ethereum', username: 'c', email: 'c@c.c', total: 3 }
              ]
            };
          }
          return { rows: [] };
        })
      }
    };
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
  });

  it('agrupa top saques por moeda sem N+1 (uma query window)', async () => {
    const { computeAdminDashboardStatsUncached } = await import(
      '../../../../../server/modules/admin/dashboard/services/dashboard-stats.js'
    );
    const payload = await computeAdminDashboardStatsUncached();
    const windowCalls = dbMock.default.query.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('ROW_NUMBER()')
    );
    expect(windowCalls).toHaveLength(1);
    expect(payload.topWithdrawalsByCoin).toEqual([
      {
        coinId: 'btc',
        coinName: 'Bitcoin',
        top: [
          { username: 'a', email: 'a@a.a', total: 10 },
          { username: 'b', email: 'b@b.b', total: 5 }
        ]
      },
      {
        coinId: 'eth',
        coinName: 'Ethereum',
        top: [{ username: 'c', email: 'c@c.c', total: 3 }]
      }
    ]);
    expect(payload.miningCoins).toEqual([
      { id: 'btc', name: 'Bitcoin' },
      { id: 'eth', name: 'Ethereum' }
    ]);
  });
});
