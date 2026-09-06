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

const PATH = '/api/admin/recall-scan';

describe('registerAdminRecallScanModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    const failWrite = () => {
      throw new Error('WRITE_FORBIDDEN');
    };
    prismaMock = {
      prisma: {
        users: {
          findUnique: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
          update: vi.fn(failWrite),
          deleteMany: vi.fn(failWrite)
        },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) },
        placed_racks: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn(failWrite),
          updateMany: vi.fn(failWrite)
        },
        rack_slots: { groupBy: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(failWrite) },
        rack_multiplier_slots: { groupBy: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(failWrite) },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn(failWrite),
        $transaction: vi.fn(failWrite)
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
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminRecallScanModuleRoutes } = await import(
      '../../../../../server/modules/admin/recall-scan/controllers/recall-scan.controller.js'
    );
    const app = fakeApp();
    registerAdminRecallScanModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('só monta GET, sem POST recall-all', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`GET ${PATH}`]).toHaveLength(2);
    expect(app.stacks['POST /api/admin/recall-all-players-items']).toBeUndefined();
  });

  it('sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
    expect(prismaMock.prisma.users.count).not.toHaveBeenCalled();
  });

  it('não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin sem tab backup → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"reports":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('admin com backup → 200 { ok, summary, totalUsersChecked }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"backup":true}'
    });
    prismaMock.prisma.users.count.mockResolvedValue(4);
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, summary: [], totalUsersChecked: 4 });
    expect(prismaMock.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prismaMock.prisma.placed_racks.deleteMany).not.toHaveBeenCalled();
  });

  it('super-admin → 200', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('500 seguro', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.users.count.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/DATABASE_URL|placed_racks/i);
  });
});
