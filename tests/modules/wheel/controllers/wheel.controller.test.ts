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

describe('registerWheelModuleRoutes', () => {
  let adminMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    adminMock = {
      fetchWheelPrizesForAdminWheelEditor: vi.fn().mockResolvedValue([]),
      replaceWheelPrizesCatalog: vi.fn().mockResolvedValue(undefined),
      getAdminWheelRuntimeConfig: vi.fn().mockResolvedValue({
        spinPriceUsdc: 1,
        minSpinPriceUsdc: 1,
        currency: 'USDC',
        isEnabled: true,
        maxSpinsPerRequest: 1,
        dailyLimit: null,
        cooldownSeconds: 0,
        startsAtMs: null,
        endsAtMs: null,
        updatedAtMs: '0'
      }),
      upsertAdminWheelRuntimeConfig: vi.fn().mockResolvedValue(undefined),
      listAdminWheelPlayers: vi.fn().mockResolvedValue([]),
      addAdminWheelPlayer: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../server/modules/wheel/services/admin.js', () => adminMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/wheel/services/admin.js');
  });

  async function loadApp() {
    const { registerWheelModuleRoutes } = await import('../../../../server/modules/wheel/controllers/wheel.controller.js');
    const app = fakeApp();
    registerWheelModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/wheel/state']).toBeUndefined();
    expect(app.routes['POST /api/wheel/spin']).toBeUndefined();
    expect(app.routes['GET /api/roleta/pending-code']).toBeUndefined();
  });

  describe('editor admin', () => {
    it('GET /api/admin/wheel/config devolve o catálogo completo', async () => {
      adminMock.fetchWheelPrizesForAdminWheelEditor.mockResolvedValue([
        { id: 'p1', label: 'X', color: '#fff', weight: 1, itemId: '', isActive: 1, tier: 'BASIC' }
      ]);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/wheel/config']({ headers: {} }, res);
      expect(res.body).toEqual([
        { id: 'p1', label: 'X', color: '#fff', weight: 1, itemId: '', isActive: 1, tier: 'BASIC' }
      ]);
    });

    it('POST /api/admin/wheel/config: body não-array devolve 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/wheel/config']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(adminMock.replaceWheelPrizesCatalog).not.toHaveBeenCalled();
    });

    it('POST /api/admin/wheel/config caminho feliz', async () => {
      const app = await loadApp();
      const res = fakeRes();
      const items = [{ id: 'p1', label: 'X', weight: 1, color: '#fff' }];
      await app.routes['POST /api/admin/wheel/config']({ headers: {}, body: items }, res);
      expect(adminMock.replaceWheelPrizesCatalog).toHaveBeenCalledWith(items);
      expect(res.body).toEqual({ ok: true });
    });

    it('GET /api/admin/wheel/runtime-config: propaga 404 controlado quando não configurado', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminMock.getAdminWheelRuntimeConfig.mockRejectedValue(
        new HttpControlledError(404, { error: 'wheel_config não encontrada' })
      );
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/wheel/runtime-config']({ headers: {} }, res);
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/admin/wheel/runtime-config caminho feliz', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/wheel/runtime-config']({ headers: {} }, res);
      expect(res.body).toMatchObject({ spinPriceUsdc: 1 });
    });

    it('POST /api/admin/wheel/runtime-config: propaga 422 controlado (preço abaixo do mínimo)', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminMock.upsertAdminWheelRuntimeConfig.mockRejectedValue(
        new HttpControlledError(422, { error: 'Preço mínimo permitido: 0.10 USDC' })
      );
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/wheel/runtime-config']({ headers: {}, body: { spinPriceUsdc: 0.01 } }, res);
      expect(res.statusCode).toBe(422);
    });

    it('POST /api/admin/wheel/runtime-config caminho feliz', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/wheel/runtime-config']({ headers: {}, body: { spinPriceUsdc: 1 } }, res);
      expect(res.body).toEqual({ ok: true });
    });

    it('GET /api/admin/wheel/players devolve added_at em snake_case (compat com o painel)', async () => {
      adminMock.listAdminWheelPlayers.mockResolvedValue([{ username: 'alice', addedAt: 1000 }]);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/wheel/players']({ headers: {} }, res);
      expect(res.body).toEqual([{ username: 'alice', added_at: 1000 }]);
    });

    it('POST /api/admin/wheel/players: username em falta propaga 400 controlado', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminMock.addAdminWheelPlayer.mockRejectedValue(new HttpControlledError(400, { error: 'Username required' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/wheel/players']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/admin/wheel/players caminho feliz', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/wheel/players']({ headers: {}, body: { username: 'bob' } }, res);
      expect(adminMock.addAdminWheelPlayer).toHaveBeenCalledWith('bob');
      expect(res.body).toEqual({ ok: true });
    });
  });
});
