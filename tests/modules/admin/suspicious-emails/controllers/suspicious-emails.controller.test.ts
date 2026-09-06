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
    headers: {} as Record<string, string>,
    sent: undefined as string | undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    send(b: string) {
      res.sent = b;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

describe('registerAdminSuspiciousEmailsModuleRoutes', () => {
  let reportMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    reportMock = {
      fetchSuspiciousEmailsReport: vi.fn().mockResolvedValue({ ok: true, users: [], pagination: { page: 1, limit: 50, total: 0 } }),
      buildSuspiciousEmailsCsv: vi.fn().mockReturnValue('id,username\n'),
      deactivateFilteredSuspiciousUsers: vi.fn().mockResolvedValue({ ok: true, deactivated: 3, alreadyBlocked: 1, excludedByRealMining: 0 })
    };
    vi.doMock('../../../../../server/modules/admin/suspicious-emails/services/report.js', () => reportMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/suspicious-emails/services/report.js');
  });

  async function loadApp() {
    const { registerAdminSuspiciousEmailsModuleRoutes } = await import('../../../../../server/modules/admin/suspicious-emails/controllers/suspicious-emails.controller.js');
    const app = fakeApp();
    registerAdminSuspiciousEmailsModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('GET .../suspicious-emails devolve o relatório', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/suspicious-emails']({ headers: {}, query: {} }, res);
    expect(res.body.ok).toBe(true);
  });

  it('GET .../export.csv seta headers CSV e envia o conteúdo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/suspicious-emails/export.csv']({ headers: {}, query: {} }, res);
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.headers['Content-Disposition']).toContain('suspicious-emails.csv');
    expect(res.sent).toBe('id,username\n');
  });

  it('POST .../deactivate-filtered sem autenticação: 401', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered']({ headers: {}, userId: undefined, body: { expectedCount: 1 } }, res);
    expect(res.statusCode).toBe(401);
    expect(reportMock.deactivateFilteredSuspiciousUsers).not.toHaveBeenCalled();
  });

  it('POST .../deactivate-filtered sem super admin: 403', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered'](
      { headers: {}, userId: 7, isSuperAdmin: false, body: { expectedCount: 1, confirm: 'DESATIVAR' } },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(reportMock.deactivateFilteredSuspiciousUsers).not.toHaveBeenCalled();
  });

  it('POST .../deactivate-filtered sem a frase de confirmação exacta: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered'](
      { headers: {}, userId: 7, isSuperAdmin: true, body: { expectedCount: 1, confirm: 'sim' } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(reportMock.deactivateFilteredSuspiciousUsers).not.toHaveBeenCalled();
  });

  it('POST .../deactivate-filtered com COUNT_MISMATCH: 409', async () => {
    reportMock.deactivateFilteredSuspiciousUsers.mockResolvedValue({ ok: false, code: 'COUNT_MISMATCH', expected: 5, actual: 3 });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered'](
      { headers: {}, userId: 7, isSuperAdmin: true, body: { expectedCount: 5, confirm: 'DESATIVAR' } },
      res
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('COUNT_MISMATCH');
  });

  it('POST .../deactivate-filtered com INVALID: 400', async () => {
    reportMock.deactivateFilteredSuspiciousUsers.mockResolvedValue({ ok: false, code: 'INVALID', error: 'expectedCount deve ser >= 1.' });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered'](
      { headers: {}, userId: 7, isSuperAdmin: true, body: { expectedCount: 0, confirm: 'DESATIVAR' } },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST .../deactivate-filtered caminho feliz: devolve contagens', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/users/suspicious-emails/deactivate-filtered'](
      { headers: {}, userId: 7, isSuperAdmin: true, body: { expectedCount: 3, confirm: 'desativar' } },
      res
    );
    expect(res.body).toEqual({ ok: true, deactivated: 3, alreadyBlocked: 1, excludedByRealMining: 0 });
    expect(reportMock.deactivateFilteredSuspiciousUsers).toHaveBeenCalledWith(expect.any(Object), { expectedCount: 3, adminUserId: 7 });
  });

  it('erro inesperado no relatório: 500 genérico', async () => {
    reportMock.fetchSuspiciousEmailsReport.mockRejectedValue(new Error('boom'));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/users/suspicious-emails']({ headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
