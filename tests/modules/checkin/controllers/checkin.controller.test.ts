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

describe('registerCheckinModuleRoutes', () => {
  let premiumPolicy: Record<string, any>;
  let rewardPolicy: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    premiumPolicy = {
      loadCheckinPremiumPolicy: vi.fn().mockResolvedValue({ enabled: true, minUsdc: 195, intervalDays: 7 }),
      saveCheckinPremiumPolicy: vi.fn().mockResolvedValue({ enabled: false, minUsdc: 300, intervalDays: 14 })
    };
    rewardPolicy = {
      loadCheckinRewardPolicy: vi.fn().mockResolvedValue({ rewardType: 'hashrate', dailyRewardAmount: 1 }),
      saveCheckinRewardPolicy: vi.fn().mockResolvedValue({ rewardType: 'item', dailyRewardAmount: 2 })
    };
    vi.doMock('../../../../server/modules/checkin/services/premium-policy.js', () => premiumPolicy);
    vi.doMock('../../../../server/modules/checkin/services/reward-policy.js', () => rewardPolicy);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/checkin/services/premium-policy.js');
    vi.doUnmock('../../../../server/modules/checkin/services/reward-policy.js');
  });

  async function loadApp() {
    const { registerCheckinModuleRoutes } = await import('../../../../server/modules/checkin/controllers/checkin.controller.js');
    const app = fakeApp();
    registerCheckinModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/checkin/status']).toBeUndefined();
    expect(app.routes['POST /api/checkin']).toBeUndefined();
  });

  it('GET /api/admin/checkin-premium-policy devolve a política actual', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/checkin-premium-policy']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, enabled: true, minUsdc: 195, intervalDays: 7 });
  });

  it('POST /api/admin/checkin-premium-policy grava e devolve a política actualizada', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/checkin-premium-policy']({ headers: {}, body: { enabled: false, minUsdc: 300, intervalDays: 14 } }, res);
    expect(premiumPolicy.saveCheckinPremiumPolicy).toHaveBeenCalledWith({ enabled: false, minUsdc: 300, intervalDays: 14 });
    expect(res.body).toEqual({ ok: true, enabled: false, minUsdc: 300, intervalDays: 14 });
  });

  it('GET /api/admin/checkin-reward-policy devolve a política actual', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/checkin-reward-policy']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, rewardType: 'hashrate', dailyRewardAmount: 1 });
  });

  it('POST /api/admin/checkin-reward-policy grava e devolve a política actualizada', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/checkin-reward-policy']({ headers: {}, body: { rewardType: 'item', dailyRewardAmount: 2 } }, res);
    expect(rewardPolicy.saveCheckinRewardPolicy).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, rewardType: 'item', dailyRewardAmount: 2 });
  });
});
