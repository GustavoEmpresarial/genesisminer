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
    put: (path: string, ...fns: any[]) => {
      routes[`PUT ${path}`] = fns[fns.length - 1];
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

describe('registerGuideModuleRoutes', () => {
  let guideService: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    guideService = {
      listGuideAdmin: vi.fn().mockResolvedValue([{ id: 'cat-1' }, { id: 'cat-2' }]),
      createGuideCategory: vi.fn().mockResolvedValue({ id: 'cat-3' }),
      updateGuideCategory: vi.fn().mockResolvedValue({ id: 'cat-1', title: 'Editada' }),
      deleteGuideCategory: vi.fn().mockResolvedValue(true),
      reorderGuideCategories: vi.fn().mockResolvedValue(undefined),
      createGuidePage: vi.fn().mockResolvedValue({ id: 'page-1' }),
      updateGuidePage: vi.fn().mockResolvedValue({ id: 'page-1', title: 'Editada' }),
      deleteGuidePage: vi.fn().mockResolvedValue(true),
      reorderGuidePages: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../server/modules/guide/services/guide.js', () => guideService);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/guide/services/guide.js');
  });

  async function loadApp() {
    const { registerGuideModuleRoutes } = await import('../../../../server/modules/guide/controllers/guide.controller.js');
    const app = fakeApp();
    registerGuideModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista GET /api/guide (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/guide']).toBeUndefined();
  });

  it('GET /api/admin/guide devolve tudo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/guide']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, categories: [{ id: 'cat-1' }, { id: 'cat-2' }] });
  });

  it('POST /api/admin/guide/categories cria e devolve 201', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/categories']({ headers: {}, body: { title: 'Nova' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, category: { id: 'cat-3' } });
  });

  it('POST /api/admin/guide/categories erro de validação: 400', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    guideService.createGuideCategory.mockRejectedValue(new HttpControlledError(400, { error: 'Título obrigatório.', code: 'VALIDATION' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/categories']({ headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Título obrigatório.', code: 'VALIDATION' });
  });

  it('PUT /api/admin/guide/categories/:id actualiza', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/guide/categories/:id']({ headers: {}, params: { id: 'cat-1' }, body: { title: 'Editada' } }, res);
    expect(guideService.updateGuideCategory).toHaveBeenCalledWith('cat-1', { title: 'Editada' });
    expect(res.body).toEqual({ ok: true, category: { id: 'cat-1', title: 'Editada' } });
  });

  it('DELETE /api/admin/guide/categories/:id não encontrada: 404', async () => {
    guideService.deleteGuideCategory.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/guide/categories/:id']({ headers: {}, params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/guide/categories/reorder repassa os ids', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/categories/reorder']({ headers: {}, body: { orderedIds: ['a', 'b'] } }, res);
    expect(guideService.reorderGuideCategories).toHaveBeenCalledWith(['a', 'b']);
  });

  it('POST /api/admin/guide/pages cria e devolve 201', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/pages']({ headers: {}, body: { categoryId: 'cat-1', title: 'Nova' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, page: { id: 'page-1' } });
  });

  it('POST /api/admin/guide/pages erro de validação: 400', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    guideService.createGuidePage.mockRejectedValue(new HttpControlledError(400, { error: 'Categoria e título obrigatórios.', code: 'VALIDATION' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/pages']({ headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Categoria e título obrigatórios.', code: 'VALIDATION' });
  });

  it('POST /api/admin/guide/pages/reorder com categoryId inválido: 400', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    guideService.reorderGuidePages.mockRejectedValue(new HttpControlledError(400, { error: 'Categoria obrigatória.', code: 'VALIDATION' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/pages/reorder']({ headers: {}, body: { categoryId: '', orderedIds: ['p1'] } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Categoria obrigatória.', code: 'VALIDATION' });
  });

  it('PUT /api/admin/guide/pages/:id actualiza', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/guide/pages/:id']({ headers: {}, params: { id: 'page-1' }, body: { title: 'Editada' } }, res);
    expect(res.body).toEqual({ ok: true, page: { id: 'page-1', title: 'Editada' } });
  });

  it('DELETE /api/admin/guide/pages/:id não encontrada: 404', async () => {
    guideService.deleteGuidePage.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/guide/pages/:id']({ headers: {}, params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/guide/pages/reorder repassa categoryId + ids', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/guide/pages/reorder']({ headers: {}, body: { categoryId: 'cat-2', orderedIds: ['p1', 'p2'] } }, res);
    expect(guideService.reorderGuidePages).toHaveBeenCalledWith('cat-2', ['p1', 'p2']);
  });

  it('erro inesperado em GET /api/admin/guide cai no handler genérico 500', async () => {
    guideService.listGuideAdmin.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/guide']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
