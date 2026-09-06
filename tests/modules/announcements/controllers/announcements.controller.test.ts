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
const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('registerAnnouncementsModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let announcementsService: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) }
      }
    };
    announcementsService = {
      listAnnouncementsAdmin: vi.fn().mockResolvedValue([{ id: VALID_UUID }]),
      createAnnouncementAdmin: vi.fn().mockResolvedValue({ id: VALID_UUID, title: 'T' }),
      updateAnnouncementAdmin: vi.fn().mockResolvedValue({ id: VALID_UUID, title: 'T2' }),
      deleteAnnouncementAdmin: vi.fn().mockResolvedValue(true)
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/announcements/services/announcements.js', () => announcementsService);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/announcements/services/announcements.js');
  });

  async function loadApp() {
    const { registerAnnouncementsModuleRoutes } = await import(
      '../../../../server/modules/announcements/controllers/announcements.controller.js'
    );
    const app = fakeApp();
    registerAnnouncementsModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('não regista rotas de jogador (genesis-api)', async () => {
    const app = await loadApp();
    expect(app.routes['GET /api/announcements/pending']).toBeUndefined();
    expect(app.routes['GET /api/mini-blog']).toBeUndefined();
    expect(app.routes['POST /api/announcements/:id/dismiss']).toBeUndefined();
    expect(app.routes['GET /api/in-app-announcements/pending']).toBeUndefined();
  });

  it('GET /api/admin/announcements lista tudo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/announcements']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, announcements: [{ id: VALID_UUID }] });
  });

  it('POST /api/admin/announcements valida e cria, loga a ação', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/announcements']({ headers: {}, userId: 9, body: { title: 'T', message: 'M' } }, res);
    expect(res.statusCode).toBe(201);
    expect(announcementsService.createAnnouncementAdmin).toHaveBeenCalledWith(expect.objectContaining({ title: 'T' }), 9);
    expect(prismaMock.prisma.admin_access_logs.create).toHaveBeenCalled();
  });

  it('POST /api/admin/announcements com título vazio: 400 VALIDATION', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/announcements']({ headers: {}, userId: 9, body: { title: '', message: 'M' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION' });
  });

  it('POST /api/admin/announcements com imagem externa: 400 INVALID_IMAGE_URL', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/announcements']({
      headers: {},
      userId: 9,
      body: { title: 'T', message: 'M', imageUrl: 'https://evil.com/x.png' }
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IMAGE_URL' });
  });

  it('PUT /api/admin/announcements/:id bem-sucedido', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/announcements/:id']({
      headers: {},
      userId: 9,
      params: { id: VALID_UUID },
      body: { title: 'T2' }
    }, res);
    expect(res.body).toEqual({ ok: true, announcement: { id: VALID_UUID, title: 'T2' } });
  });

  it('PUT /api/admin/announcements/:id não encontrado: 404', async () => {
    announcementsService.updateAnnouncementAdmin.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/announcements/:id']({
      headers: {},
      userId: 9,
      params: { id: VALID_UUID },
      body: {}
    }, res);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/admin/announcements/:id bem-sucedido', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/announcements/:id']({
      headers: {},
      userId: 9,
      params: { id: VALID_UUID }
    }, res);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE /api/admin/announcements/:id não encontrado: 404', async () => {
    announcementsService.deleteAnnouncementAdmin.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/announcements/:id']({
      headers: {},
      userId: 9,
      params: { id: VALID_UUID }
    }, res);
    expect(res.statusCode).toBe(404);
  });

  it('erro inesperado cai no handler genérico 500', async () => {
    announcementsService.listAnnouncementsAdmin.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/announcements']({ headers: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
