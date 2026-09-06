import { beforeEach, describe, expect, it, vi } from 'vitest';

type RouteHandler = (req: any, res: any) => Promise<void> | void;

function fakeApp() {
  const routes: Record<string, RouteHandler> = {};
  return {
    post: (path: string, ...handlers: RouteHandler[]) => {
      routes[`POST ${path}`] = handlers[handlers.length - 1]!;
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

describe('registerAdminCoinEconomyModuleRoutes', () => {
  let prismaMock: { mining_coins: { updateMany: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      mining_coins: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => ({ prisma: prismaMock }));
  });

  async function load() {
    const { registerAdminCoinEconomyModuleRoutes } = await import(
      '../../../../../server/modules/admin/economy-stats/controllers/coin-economy.controller.js'
    );
    const app = fakeApp();
    const isAdmin = (_req: any, _res: any, next: () => void) => next();
    registerAdminCoinEconomyModuleRoutes(app as any, { isAdmin: isAdmin as any });
    return app;
  }

  it('POST /api/admin/economy-settings atualiza network_hashrate e block_reward', async () => {
    const app = await load();
    const res = fakeRes();
    await app.routes['POST /api/admin/economy-settings'](
      { body: { coinId: 'btc', networkHashrate: 2_000_000, blockReward: 0.5 } },
      res
    );
    expect(res.body).toMatchObject({ ok: true, coinId: 'btc', blockReward: 0.5 });
    expect(prismaMock.mining_coins.updateMany).toHaveBeenCalled();
  });

  it('POST /api/admin/economy-settings rejeita coinId inválido', async () => {
    const app = await load();
    const res = fakeRes();
    await app.routes['POST /api/admin/economy-settings']({ body: { coinId: '', networkHashrate: 1, blockReward: 1 } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/admin/mining-coins/sync-live-prices devolve 501 explícito', async () => {
    const app = await load();
    const res = fakeRes();
    await app.routes['POST /api/admin/mining-coins/sync-live-prices']({}, res);
    expect(res.statusCode).toBe(501);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/não está disponível/i);
  });
});
