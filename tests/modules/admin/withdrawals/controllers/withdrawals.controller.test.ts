import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  const stacks: Record<string, any[]> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      stacks[`GET ${path}`] = fns;
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    post: (path: string, ...fns: any[]) => {
      stacks[`POST ${path}`] = fns;
      routes[`POST ${path}`] = fns[fns.length - 1];
    },
    routes,
    stacks
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
    },
  };
  return res;
}

async function dispatch(app: ReturnType<typeof fakeApp>, key: string, req: any, res: any) {
  const fns = app.stacks[key];
  for (let i = 0; i < fns.length; i++) {
    let nextCalled = false;
    await new Promise<void>((resolve, reject) => {
      const next = (err?: unknown) => {
        nextCalled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      Promise.resolve(fns[i](req, res, next)).then(() => {
        if (!nextCalled) resolve();
      }, reject);
    });
    if (!nextCalled) return;
  }
}

describe('registerAdminWithdrawalsModuleRoutes', () => {
  let dbMock: Record<string, any>;
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  let callWalletAdminWithdrawalStatus: ReturnType<typeof vi.fn>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    dbMock = {
      default: {
        connect: vi.fn(),
        query: vi.fn().mockResolvedValue({ rows: [] })
      }
    };
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn() },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) }
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: () => void) => {
        next();
      })
    };
    callWalletAdminWithdrawalStatus = vi.fn().mockResolvedValue({
      ok: true,
      message: 'Solicitação marcada como concluída.'
    });
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
    vi.doMock('../../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletAdminWithdrawalStatus,
      isWalletWorkerError: (e: unknown) =>
        Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'WalletWorkerError')
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
    vi.doUnmock('../../../../../server/modules/wallet/services/wallet-worker-client.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminWithdrawalsModuleRoutes } = await import(
      '../../../../../server/modules/admin/withdrawals/controllers/withdrawals.controller.js'
    );
    const app = fakeApp();
    registerAdminWithdrawalsModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('monta isAdmin como único guard (sem catch-all permissivo)', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks['GET /api/admin/withdrawals']).toHaveLength(2);
    expect(app.stacks['POST /api/admin/withdrawals/status']).toHaveLength(2);
    expect(app.stacks['GET /api/admin/withdrawals'][0].name).toBe('isAdmin');
    expect(app.stacks['POST /api/admin/withdrawals/status'][0].name).toBe('isAdmin');
  });

  it('GET sem autenticação → 401 e não consulta withdrawals', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, 'GET /api/admin/withdrawals', { headers: {}, url: '/api/admin/withdrawals', originalUrl: '/api/admin/withdrawals', method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
    expect(dbMock.default.query).not.toHaveBeenCalled();
  });

  it('GET com utilizador não-admin → 403 e não consulta', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'GET /api/admin/withdrawals',
      { headers: {}, userId: 9, url: '/api/admin/withdrawals', originalUrl: '/api/admin/withdrawals', method: 'GET' },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(dbMock.default.query).not.toHaveBeenCalled();
  });

  it('GET com admin de aba (não super) → 403, rota é super', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '{"users":true}' });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'GET /api/admin/withdrawals',
      { headers: {}, userId: 9, url: '/api/admin/withdrawals', originalUrl: '/api/admin/withdrawals', method: 'GET' },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Permissão insuficiente para esta operação.' });
    expect(dbMock.default.query).not.toHaveBeenCalled();
  });

  it('GET com super-admin → 200 array', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    dbMock.default.query.mockResolvedValue({
      rows: [
        {
          id: 'wd-1',
          user_id: 7,
          username: 'alice',
          email: 'a@a.a',
          coin_id: 'btc',
          coin_symbol: 'BTC',
          amount_crypto: 1,
          amount_usdc: 50,
          fee_amount: 0,
          net_amount: 1,
          wallet_address: '0xabc',
          status: 'pending',
          tx_hash: null,
          created_at: 1,
          processed_at: null
        }
      ]
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'GET /api/admin/withdrawals',
      { headers: {}, userId: 1, url: '/api/admin/withdrawals', originalUrl: '/api/admin/withdrawals', method: 'GET' },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe('wd-1');
    expect(res.body[0].username).toBe('alice');
  });

  it('POST sem autenticação → 401 e não chama wallet worker', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'POST /api/admin/withdrawals/status',
      {
        headers: {},
        url: '/api/admin/withdrawals/status',
        originalUrl: '/api/admin/withdrawals/status',
        method: 'POST',
        body: { requestId: 'wd-1', status: 'completed' }
      },
      res
    );
    expect(res.statusCode).toBe(401);
    expect(callWalletAdminWithdrawalStatus).not.toHaveBeenCalled();
  });

  it('POST com utilizador não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'POST /api/admin/withdrawals/status',
      {
        headers: {},
        userId: 9,
        url: '/api/admin/withdrawals/status',
        originalUrl: '/api/admin/withdrawals/status',
        method: 'POST',
        body: { requestId: 'wd-1', status: 'completed' }
      },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(callWalletAdminWithdrawalStatus).not.toHaveBeenCalled();
  });

  it('POST payload inválido → 400', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'POST /api/admin/withdrawals/status',
      {
        headers: {},
        userId: 1,
        url: '/api/admin/withdrawals/status',
        originalUrl: '/api/admin/withdrawals/status',
        method: 'POST',
        body: { requestId: 'wd-1', status: 'nope' }
      },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Dados inválidos' });
    expect(callWalletAdminWithdrawalStatus).not.toHaveBeenCalled();
  });

  it('POST withdrawal inexistente → 404 legado', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const err = Object.assign(new Error('Solicitação não encontrada'), {
      name: 'WalletWorkerError',
      statusCode: 404,
      jsonBody: { ok: false, error: 'Solicitação não encontrada', code: 'NOT_FOUND' }
    });
    callWalletAdminWithdrawalStatus.mockRejectedValue(err);
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'POST /api/admin/withdrawals/status',
      {
        headers: {},
        userId: 1,
        url: '/api/admin/withdrawals/status',
        originalUrl: '/api/admin/withdrawals/status',
        method: 'POST',
        body: { requestId: 'missing', status: 'completed' }
      },
      res
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'Solicitação não encontrada', code: 'NOT_FOUND' });
  });

  it('POST super-admin completed → { ok: true }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      'POST /api/admin/withdrawals/status',
      {
        headers: {},
        userId: 1,
        url: '/api/admin/withdrawals/status',
        originalUrl: '/api/admin/withdrawals/status',
        method: 'POST',
        body: { requestId: 'wd-1', status: 'completed', txHash: '0xhash' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('concluída');
    expect(callWalletAdminWithdrawalStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'wd-1',
        status: 'completed',
        txHash: '0xhash'
      })
    );
  });
});
