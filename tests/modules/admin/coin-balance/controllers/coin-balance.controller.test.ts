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
      return res;
    }
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

const SET_PATH = '/api/admin/update-coin-balance';
const BULK_PATH = '/api/admin/bulk-update-coin-balance';

function adminReq(path: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    headers: {},
    url: path,
    originalUrl: path,
    method: 'POST',
    body,
    ...extra
  };
}

describe('registerAdminCoinBalanceModuleRoutes', () => {
  let dbMock: Record<string, any>;
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  let callWalletAdminSetCoinBalance: ReturnType<typeof vi.fn>;
  let prevWalletUrl: string | undefined;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prevWalletUrl = process.env.GENESIS_WALLET_URL;
    process.env.GENESIS_WALLET_URL = 'http://wallet.test';
    client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    dbMock = {
      default: {
        connect: vi.fn(async () => client),
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
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
    callWalletAdminSetCoinBalance = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
    vi.doMock('../../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletAdminSetCoinBalance,
      isWalletWorkerError: (e: unknown) =>
        Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'WalletWorkerError')
    }));
  });

  afterEach(() => {
    if (prevWalletUrl === undefined) delete process.env.GENESIS_WALLET_URL;
    else process.env.GENESIS_WALLET_URL = prevWalletUrl;
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
    vi.doUnmock('../../../../../server/modules/wallet/services/wallet-worker-client.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminCoinBalanceModuleRoutes } = await import(
      '../../../../../server/modules/admin/coin-balance/controllers/coin-balance.controller.js'
    );
    const app = fakeApp();
    registerAdminCoinBalanceModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('monta isAdmin em ambas as rotas (sem catch-all)', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`POST ${SET_PATH}`][0].name).toBe('isAdmin');
    expect(app.stacks[`POST ${BULK_PATH}`][0].name).toBe('isAdmin');
    expect(app.stacks[`POST ${SET_PATH}`]).toHaveLength(2);
    expect(app.stacks[`POST ${BULK_PATH}`]).toHaveLength(2);
  });

  describe('POST /api/admin/update-coin-balance', () => {
    it('sem autenticação → 401 e não escreve', async () => {
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { userId: 7, coinId: 'btc', amount: 1 }), res);
      expect(res.statusCode).toBe(401);
      expect(dbMock.default.query).not.toHaveBeenCalled();
    });

    it('não-admin → 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { userId: 7, coinId: 'btc', amount: 1 }, { userId: 9 }), res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Access denied' });
      expect(dbMock.default.query).not.toHaveBeenCalled();
    });

    it('admin sem tab users → 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({
        is_admin: 1,
        is_super_admin: 0,
        admin_permissions: '{"reports":true}'
      });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { userId: 7, coinId: 'btc', amount: 1 }, { userId: 9 }), res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Permissão insuficiente para esta operação.' });
      expect(dbMock.default.query).not.toHaveBeenCalled();
    });

    it('admin com tab users → { ok: true }', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({
        is_admin: 1,
        is_super_admin: 0,
        admin_permissions: '{"users":true}'
      });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { userId: 7, coinId: 'btc', amount: 12 }, { userId: 9 }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(callWalletAdminSetCoinBalance).toHaveBeenCalledWith({
        userId: 7,
        coinId: 'btc',
        amount: 12
      });
      expect(dbMock.default.query).not.toHaveBeenCalled();
    });

    it('super-admin → { ok: true }', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { userId: 7, coinId: 'btc', amount: 0 }, { userId: 1 }), res);
      expect(res.body).toEqual({ ok: true });
      expect(callWalletAdminSetCoinBalance).toHaveBeenCalled();
    });

    it('payload inválido → 400', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${SET_PATH}`, adminReq(SET_PATH, { coinId: 'btc', amount: 1 }, { userId: 1 }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Missing fields: userId, coinId, amount' });
      expect(dbMock.default.query).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/bulk-update-coin-balance', () => {
    it('sem autenticação → 401', async () => {
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${BULK_PATH}`, adminReq(BULK_PATH, { coinId: 'btc', amount: 1 }), res);
      expect(res.statusCode).toBe(401);
      expect(dbMock.default.connect).not.toHaveBeenCalled();
    });

    it('não-admin → 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${BULK_PATH}`, adminReq(BULK_PATH, { coinId: 'btc', amount: 1 }, { userId: 9 }), res);
      expect(res.statusCode).toBe(403);
      expect(dbMock.default.connect).not.toHaveBeenCalled();
    });

    it('admin sem tab users → 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({
        is_admin: 1,
        is_super_admin: 0,
        admin_permissions: '{"games":true}'
      });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${BULK_PATH}`, adminReq(BULK_PATH, { coinId: 'btc', amount: 1 }, { userId: 9 }), res);
      expect(res.statusCode).toBe(403);
      expect(dbMock.default.connect).not.toHaveBeenCalled();
    });

    it('payload vazio/inválido → 400', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${BULK_PATH}`, adminReq(BULK_PATH, {}, { userId: 1 }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Campos ausentes: coinId, amount' });
      expect(dbMock.default.connect).not.toHaveBeenCalled();
    });

    it('super-admin todos válidos → { ok, count }', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('FROM placed_racks')) return { rows: [{ user_id: 7 }, { user_id: 8 }] };
        return { rows: [], rowCount: 2 };
      });
      const app = await loadGuardedApp();
      const res = fakeRes();
      await dispatch(app, `POST ${BULK_PATH}`, adminReq(BULK_PATH, { coinId: 'btc', amount: 2 }, { userId: 1 }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true, count: 2 });
    });
  });
});
