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

const PATH = '/api/admin/market/listings';

describe('registerAdminMarketListingsModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) },
        player_listings: { findMany: vi.fn().mockResolvedValue([]) }
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
    const { registerAdminMarketListingsModuleRoutes } = await import(
      '../../../../../server/modules/admin/market-listings/controllers/market-listings.controller.js'
    );
    const app = fakeApp();
    registerAdminMarketListingsModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
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
    expect(prismaMock.prisma.player_listings.findMany).not.toHaveBeenCalled();
  });

  it('não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.player_listings.findMany).not.toHaveBeenCalled();
  });

  it('admin sem tab shops → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"users":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.player_listings.findMany).not.toHaveBeenCalled();
  });

  it('admin com tab shops → 200 array', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"shops":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('super-admin → 200', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.player_listings.findMany.mockResolvedValue([
      {
        id: 'l1',
        user_id: 2,
        item_id: 'i',
        price: 1,
        qty: 1,
        status: 'active',
        expires_at: 1,
        reserved_by: null,
        reserved_until: null
      }
    ]);
    prismaMock.prisma.users.findMany.mockResolvedValue([{ id: 2, username: 's', email: null }]);
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body[0].id).toBe('l1');
    expect(res.body[0].sellerName).toBe('s');
  });

  it('erro interno → 500 com { error }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.player_listings.findMany.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(JSON.stringify(res.body)).not.toMatch(/password|DATABASE_URL/i);
  });
});
