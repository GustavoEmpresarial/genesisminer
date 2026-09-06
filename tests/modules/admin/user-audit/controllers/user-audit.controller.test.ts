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

describe('registerAdminUserAuditModuleRoutes', () => {
  let serviceMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    serviceMock = {
      listUserInventoryAudit: vi.fn().mockResolvedValue({ total: 0, page: 1, limit: 50, rows: [] }),
      parseInventoryAuditRange: vi.fn().mockReturnValue({ fromMs: null, toMs: null })
    };
    vi.doMock('../../../../../server/modules/admin/user-audit/services/inventory-audit.js', () => serviceMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
  });

  async function loadApp() {
    const { registerAdminUserAuditModuleRoutes } = await import('../../../../../server/modules/admin/user-audit/controllers/user-audit.controller.js');
    const app = fakeApp();
    registerAdminUserAuditModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('userId inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/inventory-audit']({ headers: {}, params: { userId: 'abc' }, query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.listUserInventoryAudit).not.toHaveBeenCalled();
  });

  it('caminho feliz: devolve a página do serviço com defaults de page/limit', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/inventory-audit']({ headers: {}, params: { userId: '7' }, query: {} }, res);
    expect(serviceMock.listUserInventoryAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, page: 1, limit: 50, lossesOnly: false }));
    expect(res.body).toEqual({ total: 0, page: 1, limit: 50, rows: [] });
  });

  it('lossesOnly=1 na query é repassado como true', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/inventory-audit']({ headers: {}, params: { userId: '7' }, query: { lossesOnly: '1', page: '2', limit: '10' } }, res);
    expect(serviceMock.listUserInventoryAudit).toHaveBeenCalledWith(expect.objectContaining({ lossesOnly: true, page: 2, limit: 10 }));
  });

  it('erro inesperado do serviço: 500 genérico', async () => {
    serviceMock.listUserInventoryAudit.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/:userId/inventory-audit']({ headers: {}, params: { userId: '7' }, query: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
