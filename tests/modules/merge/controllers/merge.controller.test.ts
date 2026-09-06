import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    put: (path: string, ...fns: any[]) => {
      routes[`PUT ${path}`] = fns[fns.length - 1];
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

const VALID_SETTINGS_BODY = {
  enabled: true,
  enabledMachine: true,
  enabledMultiplier: true,
  enabledInfrastructure: true,
  gainPercent: 5,
  costPctByRarity: { common: 10, uncommon: 15, rare: 20, epic: 25, legendary: 30 },
  rackHsBonusPctByRarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, supreme: 0 }
};

describe('registerMergeModuleRoutes', () => {
  let settingsService: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    settingsService = {
      loadMergeSettings: vi.fn().mockResolvedValue(VALID_SETTINGS_BODY),
      saveMergeSettings: vi.fn().mockResolvedValue(VALID_SETTINGS_BODY)
    };
    vi.doMock('../../../../server/modules/merge/services/settings.js', () => settingsService);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/merge/services/settings.js');
  });

  async function loadApp() {
    const { registerMergeModuleRoutes } = await import('../../../../server/modules/merge/controllers/merge.controller.js');
    const app = fakeApp();
    registerMergeModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/merge/config']).toBeUndefined();
    expect(app.routes['GET /api/merge/inventory']).toBeUndefined();
    expect(app.routes['POST /api/merge/execute']).toBeUndefined();
  });

  it('PUT /api/admin/merge/settings valida enabled ausente: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/merge/settings']({ headers: {}, body: { ...VALID_SETTINGS_BODY, enabled: undefined } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_ENABLED' });
  });

  it('PUT /api/admin/merge/settings valida costPctByRarity fora do intervalo: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/merge/settings']({
      headers: {},
      body: { ...VALID_SETTINGS_BODY, costPctByRarity: { ...VALID_SETTINGS_BODY.costPctByRarity, common: 999 } }
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_COST' });
  });

  it('PUT /api/admin/merge/settings bem-sucedido', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/merge/settings']({ headers: {}, body: VALID_SETTINGS_BODY }, res);
    expect(settingsService.saveMergeSettings).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true });
  });

  it('GET /api/admin/merge/settings devolve as configurações actuais', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/merge/settings']({ headers: {} }, res);
    expect(res.body).toMatchObject({ ok: true, ...VALID_SETTINGS_BODY });
  });
});
