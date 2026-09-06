import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    put: (path: string, ...fns: any[]) => {
      routes[`PUT ${path}`] = fns[fns.length - 1];
    },
    post: (path: string, ...fns: any[]) => {
      routes[`POST ${path}`] = fns[fns.length - 1];
    },
    delete: (path: string, ...fns: any[]) => {
      routes[`DELETE ${path}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();
const authenticateToken = (_req: any, _res: any, next: any) => next();
const parseCookies = (req: any) => ({ sid: req?.cookiesSid ?? 'sid-test' });
const issueJwtAuthCookies = vi.fn().mockResolvedValue(undefined);

describe('registerAdminUsersModuleRoutes', () => {
  let walletHistoryMock: Record<string, any>;
  let impersonateMock: Record<string, any>;
  let gameStateMock: Record<string, any>;
  let ownedRoomsMock: Record<string, any>;
  const pool = { connect: vi.fn() };

  beforeEach(() => {
    vi.resetModules();
    issueJwtAuthCookies.mockClear();
    walletHistoryMock = {
      loadAdminUserWalletHistory: vi.fn().mockResolvedValue({
        currentWallet: {
          address: '0xabc',
          network: 'polygon',
          connectedAt: null,
          status: 'connected'
        },
        history: []
      })
    };
    impersonateMock = {
      startAdminImpersonate: vi.fn().mockResolvedValue({ targetUserId: 20 }),
      stopAdminImpersonate: vi.fn().mockResolvedValue({ adminUserId: 1 })
    };
    gameStateMock = {
      applyAdminSaveGameOverride: vi.fn().mockResolvedValue({
        ok: true,
        stock: { a: 1 },
        serverUpdatedAt: 42
      })
    };
    ownedRoomsMock = {
      applyAdminOwnedRooms: vi.fn().mockResolvedValue({
        ok: true,
        ownedRoomIds: ['room_initial', 'room_extra'],
        removedRackCount: 2
      })
    };
    vi.doMock('../../../../../server/modules/admin/users/services/wallet-history.js', () => walletHistoryMock);
    vi.doMock('../../../../../server/modules/admin/users/services/impersonate.js', () => impersonateMock);
    vi.doMock('../../../../../server/modules/admin/users/services/admin-game-state.js', () => gameStateMock);
    vi.doMock('../../../../../server/modules/admin/users/services/owned-rooms.js', () => ownedRoomsMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/users/services/wallet-history.js');
    vi.doUnmock('../../../../../server/modules/admin/users/services/impersonate.js');
    vi.doUnmock('../../../../../server/modules/admin/users/services/admin-game-state.js');
    vi.doUnmock('../../../../../server/modules/admin/users/services/owned-rooms.js');
  });

  async function loadApp() {
    const { registerAdminUsersModuleRoutes } = await import(
      '../../../../../server/modules/admin/users/controllers/users.controller.js'
    );
    const app = fakeApp();
    registerAdminUsersModuleRoutes(app as any, {
      isAdmin,
      authenticateToken,
      pool: pool as any,
      parseCookies,
      issueJwtAuthCookies
    });
    return app;
  }

  it('não registra as leftovers portadas para o genesis-api', async () => {
    const app = await loadApp();
    expect(Object.keys(app.routes)).not.toContain('GET /api/users');
    expect(Object.keys(app.routes)).not.toContain('PUT /api/users/block');
    expect(Object.keys(app.routes)).not.toContain('PUT /api/user');
    expect(Object.keys(app.routes)).not.toContain('DELETE /api/user/:email');
    expect(Object.keys(app.routes)).not.toContain('GET /api/game-state/:email');
  });

  it('mantém as rotas sob /api/admin', async () => {
    const app = await loadApp();
    expect(Object.keys(app.routes)).toEqual(
      expect.arrayContaining([
        'GET /api/admin/users/:userId/wallet-history',
        'POST /api/admin/impersonate',
        'POST /api/admin/stop-impersonate',
        'POST /api/admin/users/:userId/save-game-override',
        'PUT /api/admin/users/:userId/rooms'
      ])
    );
  });

  it('GET /api/admin/users/:userId/wallet-history 200 currentWallet + history', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/wallet-history'](
      { headers: {}, userId: 7, params: { userId: '10' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      currentWallet: { address: '0xabc', network: 'polygon', connectedAt: null, status: 'connected' },
      history: []
    });
    expect(walletHistoryMock.loadAdminUserWalletHistory).toHaveBeenCalledWith('10');
  });

  it('GET /api/admin/users/:userId/wallet-history usa o id do path, não req.userId', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/wallet-history'](
      { headers: {}, userId: 7, params: { userId: '99' } },
      res
    );
    expect(walletHistoryMock.loadAdminUserWalletHistory).toHaveBeenCalledWith('99');
    expect(walletHistoryMock.loadAdminUserWalletHistory).not.toHaveBeenCalledWith(7);
    expect(walletHistoryMock.loadAdminUserWalletHistory).not.toHaveBeenCalledWith('7');
  });

  it('GET /api/admin/users/:userId/wallet-history id inválido: 400', async () => {
    const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
    walletHistoryMock.loadAdminUserWalletHistory.mockRejectedValue(
      new HttpControlledError(400, { error: 'Invalid user id.', code: 'VALIDATION' })
    );
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/wallet-history'](
      { headers: {}, userId: 7, params: { userId: 'abc' } },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/admin/users/:userId/wallet-history inexistente: 404', async () => {
    const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
    walletHistoryMock.loadAdminUserWalletHistory.mockRejectedValue(
      new HttpControlledError(404, { error: 'User not found.', code: 'NOT_FOUND' })
    );
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/wallet-history'](
      { headers: {}, userId: 7, params: { userId: '404' } },
      res
    );
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/impersonate emite JWT do alvo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    const req = { headers: {}, userId: 1, body: { targetEmail: 'player@x.com' }, cookiesSid: 'sid-1' };
    await app.routes['POST /api/admin/impersonate'](req, res);
    expect(res.body).toEqual({ ok: true });
    expect(impersonateMock.startAdminImpersonate).toHaveBeenCalledWith({
      adminUserId: 1,
      sessionId: 'sid-1',
      targetEmail: 'player@x.com'
    });
    expect(issueJwtAuthCookies).toHaveBeenCalledWith(res, 20, req);
  });

  it('POST /api/admin/stop-impersonate emite JWT do admin restaurado', async () => {
    const app = await loadApp();
    const res = fakeRes();
    const req = { headers: {}, userId: 20, cookiesSid: 'sid-1' };
    await app.routes['POST /api/admin/stop-impersonate'](req, res);
    expect(res.body).toEqual({ ok: true });
    expect(impersonateMock.stopAdminImpersonate).toHaveBeenCalledWith({ sessionId: 'sid-1' });
    expect(issueJwtAuthCookies).toHaveBeenCalledWith(res, 1, req);
  });

  it('POST /api/admin/users/:userId/save-game-override delega changes', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/:userId/save-game-override'](
      {
        headers: {},
        userId: 1,
        params: { userId: '10' },
        body: { changes: { stock: { a: 1 }, usdc: 3 }, reason: 'admin_users_panel' }
      },
      res
    );
    expect(res.body).toEqual({ ok: true, stock: { a: 1 }, serverUpdatedAt: 42 });
    expect(gameStateMock.applyAdminSaveGameOverride).toHaveBeenCalledWith({
      targetUserId: 10,
      actorUserId: 1,
      changes: { stock: { a: 1 }, usdc: 3 },
      reason: 'admin_users_panel',
      pool
    });
  });

  it('POST save-game-override userId inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/:userId/save-game-override'](
      { headers: {}, userId: 1, params: { userId: 'abc' }, body: { changes: {} } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(gameStateMock.applyAdminSaveGameOverride).not.toHaveBeenCalled();
  });

  it('PUT /api/admin/users/:userId/rooms userId inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/users/:userId/rooms'](
      { headers: {}, userId: 1, params: { userId: 'abc' }, body: { roomIds: ['room_extra'] } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(ownedRoomsMock.applyAdminOwnedRooms).not.toHaveBeenCalled();
  });

  it('PUT /api/admin/users/:userId/rooms delega roomIds ao serviço', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/users/:userId/rooms'](
      {
        headers: {},
        userId: 1,
        params: { userId: '10' },
        body: { roomIds: ['room_initial', 'room_extra'] }
      },
      res
    );
    expect(res.body).toEqual({
      ok: true,
      ownedRoomIds: ['room_initial', 'room_extra'],
      removedRackCount: 2
    });
    expect(ownedRoomsMock.applyAdminOwnedRooms).toHaveBeenCalledWith({
      userId: 10,
      roomIds: ['room_initial', 'room_extra'],
      pool
    });
  });
});

describe('resolveAdminUsersRateLimitMax', () => {
  it('default 600; floor 120; ceiling 5000', async () => {
    const {
      resolveAdminUsersRateLimitMax,
      ADMIN_USERS_RATE_LIMIT_DEFAULT,
      ADMIN_USERS_RATE_LIMIT_FLOOR,
      ADMIN_USERS_RATE_LIMIT_CEILING
    } = await import('../../../../../server/modules/admin/users/controllers/users.controller.js');
    expect(resolveAdminUsersRateLimitMax({})).toBe(ADMIN_USERS_RATE_LIMIT_DEFAULT);
    expect(resolveAdminUsersRateLimitMax({ ADMIN_USERS_RATE_LIMIT_MAX: 'abc' })).toBe(
      ADMIN_USERS_RATE_LIMIT_DEFAULT
    );
    expect(resolveAdminUsersRateLimitMax({ ADMIN_USERS_RATE_LIMIT_MAX: '50' })).toBe(
      ADMIN_USERS_RATE_LIMIT_FLOOR
    );
    expect(resolveAdminUsersRateLimitMax({ ADMIN_USERS_RATE_LIMIT_MAX: '99999' })).toBe(
      ADMIN_USERS_RATE_LIMIT_CEILING
    );
    expect(resolveAdminUsersRateLimitMax({ ADMIN_USERS_RATE_LIMIT_MAX: '800' })).toBe(800);
  });
});
