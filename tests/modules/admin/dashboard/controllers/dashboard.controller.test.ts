import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    post: (path: string, ...fns: any[]) => {
      routes[`POST ${path}`] = fns[fns.length - 1];
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

describe('registerAdminDashboardModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let dbMock: Record<string, any>;
  let statsMock: Record<string, any>;
  let metricsMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: {
          findFirst: vi.fn(),
          update: vi.fn().mockResolvedValue({})
        }
      }
    };
    dbMock = { default: { query: vi.fn().mockResolvedValue({ rows: [] }) } };
    statsMock = {
      getAdminDashboardStatsCached: vi.fn().mockResolvedValue({
        totalUsers: 1,
        deactivatedUsers: 0,
        onlineUsers: 0,
        totalDeposited: 0,
        totalWithdrawn: 0,
        last10: [],
        topDeposits: [],
        topWithdrawalsByCoin: [],
        globalPower: 0,
        topMiners: [],
        rankingExcluded: [],
        miningCoins: []
      }),
      invalidateAdminDashboardStatsCache: vi.fn()
    };
    metricsMock = {
      computeAdminSiteMetrics: vi.fn().mockResolvedValue({
        generatedAtMs: 1,
        registeredUsers: 10,
        deactivatedUsers: 0,
        onlineUsers: 1,
        dau: 2,
        wau: 3,
        mau: 4,
        signupsToday: 0,
        signupsThisWeek: 0,
        signupsThisMonth: 0,
        totalAccounts: 10,
        adminAccounts: 0,
        usersWithWallet: 1,
        usersMiningNow: 0,
        dailySeries: []
      })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../../server/modules/admin/dashboard/services/dashboard-stats.js', () => statsMock);
    vi.doMock('../../../../../server/modules/admin/dashboard/services/site-metrics.js', () => metricsMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/modules/admin/dashboard/services/dashboard-stats.js');
    vi.doUnmock('../../../../../server/modules/admin/dashboard/services/site-metrics.js');
  });

  async function loadApp() {
    const { registerAdminDashboardModuleRoutes } = await import(
      '../../../../../server/modules/admin/dashboard/controllers/dashboard.controller.js'
    );
    const app = fakeApp();
    registerAdminDashboardModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('GET /api/admin/dashboard-stats devolve payload cached', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/dashboard-stats']({ headers: {} }, res);
    expect(res.body).toMatchObject({ totalUsers: 1 });
    expect(statsMock.getAdminDashboardStatsCached).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/dashboard-stats erro: 500', async () => {
    statsMock.getAdminDashboardStatsCached.mockRejectedValue(new Error('db down'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/dashboard-stats']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });

  it('GET /api/admin/metrics devolve snapshot', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/metrics']({ headers: {} }, res);
    expect(res.body).toMatchObject({ registeredUsers: 10, dau: 2 });
    expect(metricsMock.computeAdminSiteMetrics).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/metrics erro: 500', async () => {
    metricsMock.computeAdminSiteMetrics.mockRejectedValue(new Error('db down'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/metrics']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });

  it('POST /api/admin/ranking-exclusion sem email: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/ranking-exclusion']({ headers: {}, body: { excluded: true } }, res);
    expect(res.statusCode).toBe(400);
    expect(prismaMock.prisma.users.findFirst).not.toHaveBeenCalled();
  });

  it('POST /api/admin/ranking-exclusion user inexistente: 404', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/ranking-exclusion'](
      { headers: {}, body: { email: 'x@y.z', excluded: true } },
      res
    );
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/ranking-exclusion caminho feliz invalida cache', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 9, email: 'a@b.c', username: 'alice' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/ranking-exclusion'](
      { headers: {}, userId: 1, body: { email: 'a@b.c', excluded: true } },
      res
    );
    expect(res.body).toEqual({ ok: true });
    expect(prismaMock.prisma.users.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { ranking_excluded: 1 }
    });
    expect(statsMock.invalidateAdminDashboardStatsCache).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/users/map devolve rows', async () => {
    dbMock.default.query.mockResolvedValue({
      rows: [{ id: 1, username: 'u', polygonWallet: null, email: 'e@e.e' }]
    });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/map']({ headers: {} }, res);
    expect(res.body).toEqual([{ id: 1, username: 'u', polygonWallet: null, email: 'e@e.e' }]);
  });
});
