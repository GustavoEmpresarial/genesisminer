import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listAdminUsers', () => {
  let dbMock: { default: { query: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.resetModules();
    dbMock = { default: { query: vi.fn() } };
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
  });

  it('lista vazia: total + levels + rooms, sem lookups extra', async () => {
    dbMock.default.query
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'normal', name: 'Normal' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'room_1', name: 'Sala 1' }] });

    const { listAdminUsers } = await import('../../../../../server/modules/admin/users/services/list.js');
    const out = await listAdminUsers({ page: '1', limit: '50' }, 1_000_000);
    expect(out.total).toBe(3);
    expect(out.pages).toBe(1);
    expect(out.users).toEqual([]);
    expect(out.levels).toEqual([{ id: 'normal', name: 'Normal' }]);
    expect(out.rooms).toEqual([{ id: 'room_1', name: 'Sala 1' }]);
    expect(dbMock.default.query).toHaveBeenCalledTimes(4);
  });

  it('mapeia row + referrals + game_states + níveis', async () => {
    dbMock.default.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            username: 'alice',
            email: 'a@b.c',
            is_admin: 0,
            is_super_admin: 0,
            polygon_wallet: '0x1',
            is_blocked: 0,
            access_level_id: 'normal',
            referral_code: 'AA',
            referred_by: null,
            last_active_at: '100',
            admin_permissions: '[]'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: 'normal', name: 'Normal' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 7, referred_username: 'bob' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: 7,
            last_updated_at: 50,
            total_usdc_deposited: 12,
            total_crypto_withdrawn: 3,
            black_market_balance: 0
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ user_id: 7, access_level_id: 'vip' }] });

    const { listAdminUsers } = await import('../../../../../server/modules/admin/users/services/list.js');
    const out = await listAdminUsers({}, 1_000_000);
    expect(out.users).toHaveLength(1);
    expect(out.users[0]).toMatchObject({
      id: 7,
      username: 'alice',
      email: 'a@b.c',
      isAdmin: false,
      isSuperAdmin: false,
      polygonWallet: '0x1',
      isBlocked: false,
      accessLevelId: 'normal',
      referrals: ['bob'],
      accessLevelIds: ['vip', 'normal'],
      lastActiveAt: 100,
      totalUsdcDeposited: 12,
      totalCryptoWithdrawn: 3
    });
  });
});
