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

describe('registerDeviceFingerprintAdminModuleRoutes', () => {
  let logsMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    logsMock = { listDeviceFingerprintLogs: vi.fn().mockResolvedValue({ rows: [], total: 0 }) };
    vi.doMock('../../../../../server/modules/admin/device-fingerprint/services/logs.js', () => logsMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/device-fingerprint/services/logs.js');
  });

  async function loadApp() {
    const { registerDeviceFingerprintAdminModuleRoutes } = await import('../../../../../server/modules/admin/device-fingerprint/controllers/device-fingerprint.controller.js');
    const app = fakeApp();
    registerDeviceFingerprintAdminModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('usa defaults quando query vazia', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/device-fingerprints']({ query: {} }, res);
    expect(logsMock.listDeviceFingerprintLogs).toHaveBeenCalledWith({ limit: 50, offset: 0, eventType: null, userId: null, q: undefined });
  });

  it('repassa filtros válidos e ignora eventType desconhecido', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/device-fingerprints']({ query: { limit: '10', offset: '5', eventType: 'login', userId: '7', q: 'joe' } }, res);
    expect(logsMock.listDeviceFingerprintLogs).toHaveBeenCalledWith({ limit: 10, offset: 5, eventType: 'login', userId: 7, q: 'joe' });
  });

  it('eventType inválido vira null', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/device-fingerprints']({ query: { eventType: 'bogus' } }, res);
    expect(logsMock.listDeviceFingerprintLogs).toHaveBeenCalledWith(expect.objectContaining({ eventType: null }));
  });

  it('caminho feliz: devolve rows/total/limit/offset', async () => {
    logsMock.listDeviceFingerprintLogs.mockResolvedValue({ rows: [{ id: '1' }], total: 1 });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/device-fingerprints']({ query: {} }, res);
    expect(res.body).toEqual({ rows: [{ id: '1' }], total: 1, limit: 50, offset: 0 });
  });

  it('erro no serviço: 500', async () => {
    logsMock.listDeviceFingerprintLogs.mockRejectedValue(new Error('db down'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/device-fingerprints']({ query: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
