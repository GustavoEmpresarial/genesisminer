import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (routePath: string, ...fns: any[]) => {
      routes[`GET ${routePath}`] = fns[fns.length - 1];
    },
    post: (routePath: string, ...fns: any[]) => {
      routes[`POST ${routePath}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    sent: undefined as string | undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    send(b: string) {
      res.sent = b;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

describe('registerAdminReferralModuleRoutes', () => {
  let reportMock: Record<string, any>;
  let networkMock: Record<string, any>;
  let deleteUserMock: Record<string, any>;
  let prismaMock: Record<string, any>;
  let poolClientMock: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    reportMock = {
      buildReferralSummary: vi.fn().mockResolvedValue({ ok: true, stats: {} }),
      listReferralCommissions: vi.fn().mockResolvedValue({ ok: true, page: 1, limit: 50, total: 0, rows: [] }),
      listReferralLinks: vi.fn().mockResolvedValue({ ok: true, page: 1, limit: 50, total: 0, rows: [] }),
      buildReferralCommissionsCsv: vi.fn().mockResolvedValue('id,created_at_iso\n')
    };
    networkMock = {
      parseLookupQueries: (v: unknown) => (v ? [String(v)] : []),
      findUserByLookupToken: vi.fn().mockResolvedValue({ id: 1, username: 'alice', email: 'alice@x.com', referral_code: 'A1', referred_by: null }),
      resolveReferrerUser: vi.fn().mockResolvedValue(null),
      buildReferrerChain: vi.fn().mockResolvedValue([]),
      getReferredNetworkStats: vi.fn().mockResolvedValue({ rows: [], linkCount: 0, resolvableCount: 0, orphanLinkCount: 0 }),
      toReferralUserBrief: (r: any) => (r ? { id: r.id, username: r.username, email: r.email, referralCode: r.referral_code } : null),
      blockReferralNetwork: vi.fn().mockResolvedValue({ ok: true, blockedCount: 2, referredLinkCount: 1, resolvableCount: 1, orphanLinkCount: 0, referrer: null, referred: [] }),
      resolveNetworkTarget: vi.fn().mockResolvedValue({ id: 1, username: 'alice', email: 'alice@x.com', referral_code: 'A1', referred_by: null }),
      listAllReferredUsers: vi.fn().mockResolvedValue([]),
      NETWORK_ROWS_PREVIEW_MAX: 100
    };
    deleteUserMock = {
      deleteUserByEmail: vi.fn().mockResolvedValue({ ok: true })
    };
    prismaMock = {
      prisma: {
        $queryRaw: vi.fn().mockResolvedValue([])
      }
    };
    poolClientMock = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    poolMock = { default: { connect: vi.fn().mockResolvedValue(poolClientMock) } };
    vi.doMock('../../../../../server/modules/admin/referral/services/report.js', () => reportMock);
    vi.doMock('../../../../../server/modules/admin/referral/services/network.js', () => networkMock);
    vi.doMock('../../../../../server/modules/admin/referral/services/delete-user.js', () => deleteUserMock);
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/core/database/pool.js', () => poolMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/referral/services/report.js');
    vi.doUnmock('../../../../../server/modules/admin/referral/services/network.js');
    vi.doUnmock('../../../../../server/modules/admin/referral/services/delete-user.js');
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/core/database/pool.js');
  });

  async function loadApp() {
    const { registerAdminReferralModuleRoutes } = await import('../../../../../server/modules/admin/referral/controllers/referral.controller.js');
    const app = fakeApp();
    registerAdminReferralModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('GET .../summary devolve o resumo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/summary']({ headers: {} }, res);
    expect(res.body.ok).toBe(true);
  });

  it('GET .../commissions repassa filtros e devolve a página', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/commissions']({ headers: {}, query: { page: '2', limit: '10' } }, res);
    expect(reportMock.listReferralCommissions).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 10 }));
    expect(res.body.ok).toBe(true);
  });

  it('GET .../links devolve a página', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/links']({ headers: {}, query: {} }, res);
    expect(res.body.ok).toBe(true);
  });

  it('GET .../export.csv seta headers CSV e envia o conteúdo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/export.csv']({ headers: {}, query: {} }, res);
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.headers['Content-Disposition']).toContain('referral-commissions-');
    expect(res.sent).toBe('id,created_at_iso\n');
  });

  it('GET .../lookup sem q: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/lookup']({ headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET .../lookup caminho feliz: devolve results/notFound', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/lookup']({ headers: {}, query: { q: 'alice' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.notFound).toEqual([]);
  });

  it('GET .../lookup query não encontrada: vai pra notFound', async () => {
    networkMock.findUserByLookupToken.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/lookup']({ headers: {}, query: { q: 'nao-existe' } }, res);
    expect(res.body.results).toEqual([]);
    expect(res.body.notFound).toEqual(['nao-existe']);
  });

  it('POST .../network-block: utilizador não encontrado devolve 404', async () => {
    networkMock.blockReferralNetwork.mockResolvedValue({ ok: false, error: 'Utilizador não encontrado.' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-block']({ headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST .../network-block caminho feliz: devolve blockedCount', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-block']({ headers: {}, body: { userId: '1' } }, res);
    expect(res.body).toMatchObject({ ok: true, blockedCount: 2 });
  });

  it('POST .../network-delete: utilizador não encontrado devolve 404', async () => {
    networkMock.resolveNetworkTarget.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-delete']({ headers: {}, body: {}, isSuperAdmin: true, userId: 9 }, res);
    expect(res.statusCode).toBe(404);
    expect(deleteUserMock.deleteUserByEmail).not.toHaveBeenCalled();
  });

  it('POST .../network-delete caminho feliz: apaga indicados e o indicador, dentro de uma transação', async () => {
    networkMock.listAllReferredUsers.mockResolvedValue([{ id: 2, username: 'bob', email: 'bob@x.com', referral_code: null, referred_by: 'alice' }]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-delete']({ headers: {}, body: { userId: '1' }, isSuperAdmin: true, userId: 9 }, res);

    expect(poolClientMock.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(deleteUserMock.deleteUserByEmail).toHaveBeenCalledWith('bob@x.com', poolClientMock);
    expect(deleteUserMock.deleteUserByEmail).toHaveBeenCalledWith('alice@x.com', poolClientMock);
    expect(poolClientMock.query).toHaveBeenCalledWith('COMMIT');
    expect(poolClientMock.release).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, deletedCount: 2, referredDeleted: 1, failed: [] });
  });

  it('POST .../network-delete: não-super-admin tentando apagar outro admin devolve 403 sem tocar na BD', async () => {
    prismaMock.prisma.$queryRaw.mockResolvedValue([{ id: 1 }]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-delete']({ headers: {}, body: { userId: '1' }, isSuperAdmin: false, userId: 42 }, res);
    expect(res.statusCode).toBe(403);
    expect(deleteUserMock.deleteUserByEmail).not.toHaveBeenCalled();
  });

  it('POST .../network-delete: falha ao apagar o indicador principal faz rollback e devolve 400', async () => {
    deleteUserMock.deleteUserByEmail.mockResolvedValue({ ok: false, error: 'Utilizador não encontrado.' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/referrals/network-delete']({ headers: {}, body: { userId: '1' }, isSuperAdmin: true, userId: 9 }, res);
    expect(res.statusCode).toBe(400);
    expect(poolClientMock.query).toHaveBeenCalledWith('ROLLBACK');
    expect(poolClientMock.release).toHaveBeenCalled();
  });

  it('erro inesperado no summary: 500 genérico', async () => {
    reportMock.buildReferralSummary.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/referrals/summary']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
