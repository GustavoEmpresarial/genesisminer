import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const stacks: Record<string, any[]> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      stacks[`GET ${path}`] = fns;
    },
    post: (path: string, ...fns: any[]) => {
      stacks[`POST ${path}`] = fns;
    },
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

const PATH = '/api/admin/recall-all-players-items';

describe('registerAdminRecallAllModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let poolMock: { default: { connect: ReturnType<typeof vi.fn> } };
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});
  let clientQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    clientQuery = vi.fn(async (sql: string) => {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (/pg_advisory_/i.test(n)) return { rows: [] };
      if (/FROM placed_racks/i.test(n) && /^SELECT/i.test(n)) return { rows: [] };
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(n)) return { rows: [] };
      return { rows: [] };
    });
    poolMock = {
      default: {
        connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() }))
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
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/core/database/pool.js', () => poolMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminRecallAllModuleRoutes } = await import(
      '../../../../../server/modules/admin/recall-all/controllers/recall-all.controller.js'
    );
    const app = fakeApp();
    registerAdminRecallAllModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('só monta o POST destrutivo', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`POST ${PATH}`]).toHaveLength(2);
    expect(app.stacks['GET /api/admin/recall-scan']).toBeUndefined();
  });

  it('sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `POST ${PATH}`, { headers: {}, url: PATH, originalUrl: PATH, method: 'POST', body: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(poolMock.default.connect).not.toHaveBeenCalled();
  });

  it('não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${PATH}`,
      { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'POST', body: { userId: 1 } },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(poolMock.default.connect).not.toHaveBeenCalled();
  });

  it('admin não-super (mesmo com tab backup) → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"backup":true,"users":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `POST ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'POST' }, res);
    expect(res.statusCode).toBe(403);
    expect(poolMock.default.connect).not.toHaveBeenCalled();
  });

  it('super-admin → 200 { ok, report } contrato legado (vazio)', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `POST ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'POST' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report).toMatchObject({
      finalStatus: 'success',
      totalItemsMoved: 0,
      racksProcessed: 0,
      retries: 0
    });
    expect(Array.isArray(res.body.report.steps)).toBe(true);
    expect(res.body.report.steps[0]).toBe('Iniciando tentativa 1...');
  });

  it('500 seguro com ok:false e report, sem SQL no body', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    poolMock.default.connect.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `POST ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'POST' }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.report).toMatchObject({ finalStatus: 'pending', totalItemsMoved: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/INSERT INTO stock|placed_racks|DATABASE_URL/i);
  });
});
