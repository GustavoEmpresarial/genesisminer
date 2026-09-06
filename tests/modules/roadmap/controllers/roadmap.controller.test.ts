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

describe('registerRoadmapModuleRoutes', () => {
  let roadmapService: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    roadmapService = {
      listRoadmapAdmin: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
      createRoadmapStep: vi.fn().mockResolvedValue({ id: 's3', title: 'Nova' }),
      updateRoadmapStep: vi.fn().mockResolvedValue({ id: 's1', title: 'Editada' }),
      deleteRoadmapStep: vi.fn().mockResolvedValue(true),
      reorderRoadmapSteps: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../server/modules/roadmap/services/roadmap.js', () => roadmapService);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/roadmap/services/roadmap.js');
  });

  async function loadApp() {
    const { registerRoadmapModuleRoutes } = await import('../../../../server/modules/roadmap/controllers/roadmap.controller.js');
    const app = fakeApp();
    registerRoadmapModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista GET /api/roadmap (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/roadmap']).toBeUndefined();
  });

  it('GET /api/admin/roadmap devolve tudo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/roadmap']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, steps: [{ id: 's1' }, { id: 's2' }] });
  });

  it('POST /api/admin/roadmap cria e devolve 201', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/roadmap']({ headers: {}, body: { title: 'Nova' } }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, step: { id: 's3', title: 'Nova' } });
  });

  it('POST /api/admin/roadmap com erro de validação: 400 com a mensagem', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    roadmapService.createRoadmapStep.mockRejectedValue(new HttpControlledError(400, { error: 'Título obrigatório.', code: 'VALIDATION' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/roadmap']({ headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Título obrigatório.', code: 'VALIDATION' });
  });

  it('PUT /api/admin/roadmap/:id actualiza', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/roadmap/:id']({ headers: {}, params: { id: 's1' }, body: { title: 'Editada' } }, res);
    expect(roadmapService.updateRoadmapStep).toHaveBeenCalledWith('s1', { title: 'Editada' });
    expect(res.body).toEqual({ ok: true, step: { id: 's1', title: 'Editada' } });
  });

  it('PUT /api/admin/roadmap/:id título vazio: 400', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    roadmapService.updateRoadmapStep.mockRejectedValue(new HttpControlledError(400, { error: 'Título obrigatório.', code: 'VALIDATION' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/roadmap/:id']({ headers: {}, params: { id: 's1' }, body: { title: '  ' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Título obrigatório.', code: 'VALIDATION' });
  });

  it('DELETE /api/admin/roadmap/:id sucesso', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/roadmap/:id']({ headers: {}, params: { id: 's1' } }, res);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE /api/admin/roadmap/:id não encontrado: 404', async () => {
    roadmapService.deleteRoadmapStep.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/roadmap/:id']({ headers: {}, params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/roadmap/reorder repassa os ids como string', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/roadmap/reorder']({ headers: {}, body: { orderedIds: ['a', 'b'] } }, res);
    expect(roadmapService.reorderRoadmapSteps).toHaveBeenCalledWith(['a', 'b']);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /api/admin/roadmap/reorder sem orderedIds: array vazio', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/roadmap/reorder']({ headers: {}, body: {} }, res);
    expect(roadmapService.reorderRoadmapSteps).toHaveBeenCalledWith([]);
  });

  it('erro inesperado em GET /api/admin/roadmap cai no handler genérico 500', async () => {
    roadmapService.listRoadmapAdmin.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/roadmap']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
