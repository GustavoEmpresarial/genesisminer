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
    delete: (path: string, ...fns: any[]) => {
      stacks[`DELETE ${path}`] = fns;
      routes[`DELETE ${path}`] = fns[fns.length - 1];
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

const STATS = '/api/admin/security/stats';
const BL_POST = '/api/admin/security/blacklist';
const BL_DEL = '/api/admin/security/blacklist/:ip';

describe('registerAdminSecurityStatsModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let dbMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    dbMock = { default: { connect: vi.fn(async () => client), query: vi.fn() } };
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn() },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined), findMany: vi.fn().mockResolvedValue([]) },
        ip_blacklist: {
          findMany: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 })
        }
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: () => void) => {
        next();
      })
    };
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminSecurityStatsModuleRoutes } = await import(
      '../../../../../server/modules/admin/security-stats/controllers/security-stats.controller.js'
    );
    const app = fakeApp();
    registerAdminSecurityStatsModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('monta isAdmin nas três rotas', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`GET ${STATS}`][0].name).toBe('isAdmin');
    expect(app.stacks[`POST ${BL_POST}`][0].name).toBe('isAdmin');
    expect(app.stacks[`DELETE ${BL_DEL}`][0].name).toBe('isAdmin');
  });

  it('GET sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${STATS}`, { headers: {}, url: STATS, originalUrl: STATS, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(dbMock.default.connect).not.toHaveBeenCalled();
  });

  it('GET não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `GET ${STATS}`,
      { headers: {}, userId: 9, url: STATS, originalUrl: STATS, method: 'GET', query: {} },
      res
    );
    expect(res.statusCode).toBe(403);
  });

  it('GET admin sem tab security → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"users":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `GET ${STATS}`,
      { headers: {}, userId: 9, url: STATS, originalUrl: STATS, method: 'GET', query: {} },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(dbMock.default.connect).not.toHaveBeenCalled();
  });

  it('GET admin tab security → 200 contrato', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"security":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `GET ${STATS}`,
      { headers: {}, userId: 9, url: STATS, originalUrl: STATS, method: 'GET', query: { section: 'accessLogs' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        multiAccounts: [],
        accessLogs: [],
        blacklist: [],
        blockedUsers: []
      })
    );
  });

  it('POST blacklist sem auth → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BL_POST}`,
      { headers: {}, url: BL_POST, originalUrl: BL_POST, method: 'POST', body: { ip: '1.1.1.1' } },
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('POST blacklist super-admin + IP em falta → 400', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BL_POST}`,
      { headers: {}, userId: 1, url: BL_POST, originalUrl: BL_POST, method: 'POST', body: {} },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'IP requerido' });
    expect(prismaMock.prisma.ip_blacklist.upsert).not.toHaveBeenCalled();
  });

  it('POST blacklist admin security → { ok: true }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"security":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BL_POST}`,
      {
        headers: {},
        userId: 9,
        url: BL_POST,
        originalUrl: BL_POST,
        method: 'POST',
        body: { ip: '203.0.113.8', reason: 'test' }
      },
      res
    );
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE blacklist super-admin → { ok: true }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `DELETE ${BL_DEL}`,
      {
        headers: {},
        userId: 1,
        url: '/api/admin/security/blacklist/203.0.113.8',
        originalUrl: '/api/admin/security/blacklist/203.0.113.8',
        method: 'DELETE',
        params: { ip: '203.0.113.8' }
      },
      res
    );
    expect(res.body).toEqual({ ok: true });
    expect(prismaMock.prisma.ip_blacklist.deleteMany).toHaveBeenCalled();
  });
});
