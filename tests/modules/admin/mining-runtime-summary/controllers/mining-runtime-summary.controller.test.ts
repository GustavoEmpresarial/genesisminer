import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  const stacks: Record<string, any[]> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      stacks[`GET ${path}`] = fns;
      routes[`GET ${path}`] = fns[fns.length - 1];
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

const PATH = '/api/admin/mining-runtime-summary';

describe('registerAdminMiningRuntimeSummaryModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) }
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: () => void) => {
        next();
      })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
    vi.doUnmock('../../../../../server/modules/admin/mining-runtime-summary/services/mining-runtime-summary.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminMiningRuntimeSummaryModuleRoutes } = await import(
      '../../../../../server/modules/admin/mining-runtime-summary/controllers/mining-runtime-summary.controller.js'
    );
    const app = fakeApp();
    registerAdminMiningRuntimeSummaryModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('GET monta isAdmin', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`GET ${PATH}`][0].name).toBe('isAdmin');
    expect(app.stacks[`GET ${PATH}`]).toHaveLength(2);
  });

  it('sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
  });

  it('não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin sem tab reports → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"shops":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin com tab reports → 200 snapshot', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"reports":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      realActiveMiners: expect.any(Number),
      realNetworkHashrates: expect.any(Object),
      activeMinersByCoin: expect.any(Object)
    });
  });

  it('super-admin → 200', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.realActiveMiners).toBeTypeOf('number');
  });

  it('erro interno → 500 com { error }', async () => {
    vi.resetModules();
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
    vi.doMock('../../../../../server/modules/admin/mining-runtime-summary/services/mining-runtime-summary.js', () => ({
      getMiningRuntimeSummary: () => {
        throw new Error('store exploded');
      }
    }));
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminMiningRuntimeSummaryModuleRoutes } = await import(
      '../../../../../server/modules/admin/mining-runtime-summary/controllers/mining-runtime-summary.controller.js'
    );
    const app = fakeApp();
    registerAdminMiningRuntimeSummaryModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(JSON.stringify(res.body)).not.toMatch(/password|DATABASE_URL|stack/i);
  });
});
