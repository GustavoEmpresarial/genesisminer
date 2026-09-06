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
    delete: (path: string, ...fns: any[]) => {
      routes[`DELETE ${path}`] = fns[fns.length - 1];
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

describe('registerUpgradesModuleRoutes', () => {
  let adminCrudMock: Record<string, any>;
  let loaderMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    adminCrudMock = {
      upsertAdminUpgrade: vi.fn().mockResolvedValue(undefined),
      deleteAdminUpgrade: vi.fn().mockResolvedValue(undefined)
    };
    loaderMock = { loadAdminUpgradesForUser: vi.fn().mockResolvedValue([{ id: 'pack_1', name: 'Pacote 1' }]) };
    vi.doMock('../../../../server/modules/upgrades/services/admin-crud.js', () => adminCrudMock);
    vi.doMock('../../../../server/modules/upgrades/services/admin-upgrades-loader.js', () => loaderMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/upgrades/services/admin-crud.js');
    vi.doUnmock('../../../../server/modules/upgrades/services/admin-upgrades-loader.js');
  });

  async function loadApp() {
    const { registerUpgradesModuleRoutes } = await import('../../../../server/modules/upgrades/controllers/upgrades.controller.js');
    const app = fakeApp();
    registerUpgradesModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/upgrades/state']).toBeUndefined();
    expect(app.routes['GET /api/upgrades/purchases']).toBeUndefined();
    expect(app.routes['POST /api/upgrades/purchase']).toBeUndefined();
  });

  describe('GET /api/admin-upgrades', () => {
    it('devolve a lista do loader', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin-upgrades']({ headers: {}, userId: 1 }, res);
      expect(loaderMock.loadAdminUpgradesForUser).toHaveBeenCalledWith(1);
      expect(res.body).toEqual([{ id: 'pack_1', name: 'Pacote 1' }]);
    });
  });

  describe('POST /api/admin-upgrades', () => {
    it('caminho feliz: repassa o body e devolve ok', async () => {
      const app = await loadApp();
      const res = fakeRes();
      const body = { id: 'pack_1', name: 'Pacote 1', priceUsdc: 10 };
      await app.routes['POST /api/admin-upgrades']({ headers: {}, body }, res);
      expect(adminCrudMock.upsertAdminUpgrade).toHaveBeenCalledWith(body);
      expect(res.body).toEqual({ ok: true });
    });

    it('propaga HttpControlledError (ex.: id em falta)', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminCrudMock.upsertAdminUpgrade.mockRejectedValue(new HttpControlledError(400, { error: 'id do pacote é obrigatório.' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin-upgrades']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(400);
    });

    it('erro inesperado: 500', async () => {
      adminCrudMock.upsertAdminUpgrade.mockRejectedValue(new Error('db down'));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin-upgrades']({ headers: {}, body: {} }, res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('DELETE /api/admin-upgrades/:id', () => {
    it('caminho feliz', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin-upgrades/:id']({ headers: {}, params: { id: 'pack_1' } }, res);
      expect(adminCrudMock.deleteAdminUpgrade).toHaveBeenCalledWith('pack_1');
      expect(res.body).toEqual({ ok: true });
    });

    it('já comprado por usuários: propaga 400 controlado', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminCrudMock.deleteAdminUpgrade.mockRejectedValue(
        new HttpControlledError(400, { error: 'Este upgrade já foi comprado por usuários e não pode ser excluído.' })
      );
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin-upgrades/:id']({ headers: {}, params: { id: 'pack_1' } }, res);
      expect(res.statusCode).toBe(400);
    });

    it('não encontrado: propaga 404 controlado', async () => {
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      adminCrudMock.deleteAdminUpgrade.mockRejectedValue(new HttpControlledError(404, { error: 'Upgrade não encontrado' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin-upgrades/:id']({ headers: {}, params: { id: 'pack_1' } }, res);
      expect(res.statusCode).toBe(404);
    });
  });
});
