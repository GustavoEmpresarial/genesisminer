import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
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

describe('registerRankingModuleRoutes', () => {
  let rankingMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    rankingMock = {
      getAdminMiningRankingPayload: vi.fn().mockResolvedValue({ timestamp: 1, ranking: [], coins: [] })
    };
    vi.doMock('../../../../server/modules/ranking/services/mining-ranking.js', () => rankingMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/ranking/services/mining-ranking.js');
  });

  async function loadApp() {
    const { registerRankingModuleRoutes } = await import('../../../../server/modules/ranking/controllers/ranking.controller.js');
    const app = fakeApp();
    registerRankingModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/ranking/public']).toBeUndefined();
    expect(app.routes['GET /api/ranking/me']).toBeUndefined();
  });

  it('GET /api/admin/ranking devolve o payload admin', async () => {
    rankingMock.getAdminMiningRankingPayload.mockResolvedValue({
      timestamp: 1,
      ranking: [{ user_id: 1, username: 'a', coins: {}, generalCoins: {}, balances: {} }],
      coins: []
    });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/ranking']({ headers: {} }, res);
    expect(res.body.ranking).toHaveLength(1);
  });

  it('GET /api/admin/ranking erro inesperado: 500', async () => {
    rankingMock.getAdminMiningRankingPayload.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/ranking']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
