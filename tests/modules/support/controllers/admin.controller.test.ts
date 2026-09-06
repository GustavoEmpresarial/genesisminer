import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (routePath: string, ...fns: any[]) => {
      routes[`GET ${routePath}`] = fns[fns.length - 1];
    },
    post: (routePath: string, ...fns: any[]) => {
      routes[`POST ${routePath}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      res.headersSent = true;
      return res;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

/** Stub de `multer` (`.array()`, usado pela rota de resposta admin). */
function multerStub() {
  let nextErr: unknown = null;
  let nextFiles: Record<string, unknown>[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const array = (_field: string, _maxCount: number) => (req: any, _res: any, cb: (err: unknown) => unknown) => {
    if (nextFiles.length > 0) req.files = nextFiles;
    pending = Promise.resolve(cb(nextErr));
  };
  const diskStorage = (_opts: unknown) => ({});
  const memoryStorage = () => ({});
  const factory: any = (_opts: unknown) => ({ array });
  factory.diskStorage = diskStorage;
  factory.memoryStorage = memoryStorage;
  return {
    factory,
    setNextError: (e: unknown) => {
      nextErr = e;
    },
    setNextFiles: (f: Record<string, unknown>[]) => {
      nextFiles = f;
    },
    flush: () => pending
  };
}

describe('registerSupportAdminModuleRoutes', () => {
  let ticketModelMock: Record<string, any>;
  let authRepoMock: Record<string, any>;
  let loginValidationMock: Record<string, any>;
  let prismaMock: Record<string, any>;
  let multerCtl: ReturnType<typeof multerStub>;

  beforeEach(() => {
    vi.resetModules();
    ticketModelMock = {
      listTicketsForAdmin: vi.fn().mockResolvedValue([]),
      getAdminTicketListRowById: vi.fn().mockResolvedValue(null),
      getUserSupportTicketStats: vi.fn().mockResolvedValue({ total: 0, open_count: 0, archived_count: 0, last_ticket_at: 0 }),
      listUserSupportTicketHistorySummaries: vi.fn().mockResolvedValue([]),
      listAdminRepliesForTicketIds: vi.fn().mockResolvedValue([]),
      listPlayerRepliesForTicketIds: vi.fn().mockResolvedValue([]),
      updateSupportTicketStatus: vi.fn().mockResolvedValue(1),
      getTicketForAdminReply: vi.fn().mockResolvedValue(null),
      insertSupportAdminReply: vi.fn().mockResolvedValue(undefined)
    };
    authRepoMock = { findUserByEmail: vi.fn().mockResolvedValue(undefined) };
    loginValidationMock = { validateLoginEmail: vi.fn().mockReturnValue({ ok: true }) };
    prismaMock = { prisma: { game_states: { findUnique: vi.fn().mockResolvedValue(null) } } };
    multerCtl = multerStub();
    vi.doMock('../../../../server/modules/support/services/ticket-model.js', () => ticketModelMock);
    vi.doMock('../../../../server/modules/auth/models/repository.js', () => authRepoMock);
    vi.doMock('../../../../server/modules/auth/services/login-validation.js', () => loginValidationMock);
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('multer', () => ({ default: multerCtl.factory }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/support/services/ticket-model.js');
    vi.doUnmock('../../../../server/modules/auth/models/repository.js');
    vi.doUnmock('../../../../server/modules/auth/services/login-validation.js');
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('multer');
  });

  async function loadApp(uploadsDir = '/tmp/support-admin-test-uploads') {
    const { registerSupportAdminModuleRoutes } = await import('../../../../server/modules/support/controllers/admin.controller.js');
    const app = fakeApp();
    registerSupportAdminModuleRoutes(app as any, { isAdmin, uploadsDir });
    return app;
  }

  it('GET /api/admin/support-tickets devolve a lista com respostas agrupadas', async () => {
    ticketModelMock.listTicketsForAdmin.mockResolvedValue([
      { id: 't1', user_id: 1, subject: 'Assunto', message: 'msg', attachments: [], status: 'open', created_at: 1000, username: 'joe', email: 'joe@x.com' }
    ]);
    ticketModelMock.listAdminRepliesForTicketIds.mockResolvedValue([
      { id: 'r1', ticket_id: 't1', admin_user_id: 5, message: 'resposta', attachments: [], created_at: 2000, admin_username: 'admin1' }
    ]);
    ticketModelMock.listPlayerRepliesForTicketIds.mockResolvedValue([{ id: 'p1', ticket_id: 't1', message: 'ok', attachments: [], created_at: 1500 }]);

    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support-tickets']({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].replies).toEqual([{ id: 'r1', adminUserId: 5, adminUsername: 'admin1', message: 'resposta', attachments: [], createdAt: 2000 }]);
    expect(res.body.tickets[0].playerReplies).toEqual([{ id: 'p1', message: 'ok', attachments: [], createdAt: 1500 }]);
  });

  it('GET /api/admin/support-tickets caps limit em 300', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support-tickets']({ query: { limit: '99999' } }, res);
    expect(ticketModelMock.listTicketsForAdmin).toHaveBeenCalledWith(300);
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/admin/support/user-history sem email: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/user-history']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/admin/support/user-history email inválido: 400', async () => {
    loginValidationMock.validateLoginEmail.mockReturnValue({ ok: false });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/user-history']({ query: { email: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/admin/support/user-history utilizador não encontrado: 404', async () => {
    authRepoMock.findUserByEmail.mockResolvedValue(undefined);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/user-history']({ query: { email: 'x@x.com' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/admin/support/user-history caminho feliz devolve resumo e tickets', async () => {
    authRepoMock.findUserByEmail.mockResolvedValue({ id: 42, email: 'x@x.com', username: 'xuser' });
    ticketModelMock.getUserSupportTicketStats.mockResolvedValue({ total: 2, open_count: 1, archived_count: 1, last_ticket_at: 5000 });
    ticketModelMock.listUserSupportTicketHistorySummaries.mockResolvedValue([
      { id: 't1', subject: 'S', status: 'open', message: 'msg', attachments: [], created_at: 1000, message_count: 2, last_message_at: 2000, last_admin_username: 'admin1' }
    ]);
    prismaMock.prisma.game_states.findUnique.mockResolvedValue({ start_time: 500 });

    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/user-history']({ query: { email: 'x@x.com' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toEqual({ id: 42, email: 'x@x.com', username: 'xuser', createdAt: 500 });
    expect(res.body.summary).toEqual({ total: 2, open: 1, archived: 1, lastTicketAt: 5000 });
    expect(res.body.tickets[0].preview).toBe('msg');
  });

  it('GET /api/admin/support/tickets/:ticketId inexistente: 404', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/tickets/:ticketId']({ params: { ticketId: 't1' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/admin/support/tickets/:ticketId caminho feliz', async () => {
    ticketModelMock.getAdminTicketListRowById.mockResolvedValue({ id: 't1', user_id: 1, subject: 'S', message: 'm', attachments: [], status: 'open', created_at: 1000, username: 'joe', email: 'joe@x.com' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/support/tickets/:ticketId']({ params: { ticketId: 't1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ticket.id).toBe('t1');
  });

  it('POST /api/admin/support-tickets/status sem id: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/status']({ body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/admin/support-tickets/status ticket inexistente: 404', async () => {
    ticketModelMock.updateSupportTicketStatus.mockResolvedValue(0);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/status']({ body: { id: 't1', status: 'archived' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/support-tickets/status caminho feliz (default para open)', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/status']({ body: { id: 't1' } }, res);
    expect(ticketModelMock.updateSupportTicketStatus).toHaveBeenCalledWith('open', 't1');
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /api/admin/support-tickets/reply sem admin autenticado: 401', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: undefined, body: {} }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/admin/support-tickets/reply sem ticketId: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: {} }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/admin/support-tickets/reply mensagem curta sem ficheiros: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: { ticketId: 't1', message: 'a' } }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/admin/support-tickets/reply ticket inexistente: 404', async () => {
    ticketModelMock.getTicketForAdminReply.mockResolvedValue(null);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: { ticketId: 't1', message: 'mensagem válida' } }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/admin/support-tickets/reply caminho feliz: insere resposta e loga atividade', async () => {
    ticketModelMock.getTicketForAdminReply.mockResolvedValue({ id: 't1', user_id: 7 });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: { ticketId: 't1', message: 'mensagem válida' } }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ticketModelMock.insertSupportAdminReply).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 't1', adminUserId: 5, message: 'mensagem válida' })
    );
  });

  it('POST /api/admin/support-tickets/reply worker/insert fail-closed: 500', async () => {
    ticketModelMock.getTicketForAdminReply.mockResolvedValue({ id: 't1', user_id: 7 });
    ticketModelMock.insertSupportAdminReply.mockRejectedValue(new Error('GENESIS_MINING_WORKER_URL unset'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: { ticketId: 't1', message: 'mensagem válida' } }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(500);
    expect(ticketModelMock.insertSupportAdminReply).toHaveBeenCalled();
  });

  it('POST /api/admin/support-tickets/reply erro do multer (ficheiro grande demais): 413', async () => {
    multerCtl.setNextError({ code: 'LIMIT_FILE_SIZE' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/support-tickets/reply']({ userId: 5, body: {} }, res);
    await multerCtl.flush();
    expect(res.statusCode).toBe(413);
    expect(ticketModelMock.getTicketForAdminReply).not.toHaveBeenCalled();
  });
});
