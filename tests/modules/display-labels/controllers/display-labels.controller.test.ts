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

describe('registerDisplayLabelsModuleRoutes', () => {
  let storeMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    storeMock = {
      listAll: vi.fn().mockResolvedValue({ 'nav.servers': 'Mining' }),
      upsertBatch: vi.fn().mockResolvedValue({ 'nav.profile': 'Perfil' })
    };
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callDisplayLabels: vi.fn().mockResolvedValue({ 'nav.servers': 'Mining' })
    }));
    vi.doMock('../../../../server/modules/display-labels/services/store.js', () => storeMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/display-labels/services/store.js');
  });

  async function loadApp() {
    const { registerDisplayLabelsModuleRoutes } = await import(
      '../../../../server/modules/display-labels/controllers/display-labels.controller.js'
    );
    const app = fakeApp();
    registerDisplayLabelsModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista GET /api/display-labels (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/display-labels']).toBeUndefined();
  });

  it('POST /api/admin/display-labels sem labels: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/display-labels']({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(storeMock.upsertBatch).not.toHaveBeenCalled();
  });

  it('POST /api/admin/display-labels labels array: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/display-labels']({ body: { labels: [] } }, res);
    expect(res.statusCode).toBe(400);
    expect(storeMock.upsertBatch).not.toHaveBeenCalled();
  });

  it('POST /api/admin/display-labels ok', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/display-labels'](
      { body: { labels: { 'nav.profile': 'Perfil' } } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, labels: { 'nav.profile': 'Perfil' } });
    expect(storeMock.upsertBatch).toHaveBeenCalledWith({ 'nav.profile': 'Perfil' });
  });
});
