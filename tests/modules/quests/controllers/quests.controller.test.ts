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

describe('registerQuestsModuleRoutes', () => {
  let questService: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    questService = {
      ensureQuestSchema: vi.fn().mockResolvedValue(undefined),
      listAllQuestDefinitionsAdmin: vi.fn().mockResolvedValue([{ id: 'daily_checkin' }]),
      saveQuestDefinitionAdmin: vi.fn().mockResolvedValue({ id: 'daily_checkin', enabled: 0 })
    };
    vi.doMock('../../../../server/modules/quests/services/quest.js', () => questService);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/quests/services/quest.js');
  });

  async function loadApp() {
    const { registerQuestsModuleRoutes } = await import('../../../../server/modules/quests/controllers/quests.controller.js');
    const app = fakeApp();
    registerQuestsModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('registra as rotas chamando ensureQuestSchema no boot', async () => {
    await loadApp();
    expect(questService.ensureQuestSchema).toHaveBeenCalledTimes(1);
  });

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/quests/state']).toBeUndefined();
    expect(app.routes['POST /api/quests/claim']).toBeUndefined();
  });

  it('GET /api/admin/quests devolve todas as definições', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/quests']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, definitions: [{ id: 'daily_checkin' }] });
  });

  it('POST /api/admin/quests grava e devolve a definição actualizada', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/quests']({ headers: {}, body: { id: 'daily_checkin', enabled: false } }, res);
    expect(questService.saveQuestDefinitionAdmin).toHaveBeenCalledWith(expect.objectContaining({ id: 'daily_checkin', enabled: false }));
    expect(res.body).toEqual({ ok: true, definition: { id: 'daily_checkin', enabled: 0 } });
  });

  it('POST /api/admin/quests com id inexistente: 404', async () => {
    questService.saveQuestDefinitionAdmin.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/quests']({ headers: {}, body: { id: 'nao_existe' } }, res);
    expect(res.statusCode).toBe(404);
  });
});
