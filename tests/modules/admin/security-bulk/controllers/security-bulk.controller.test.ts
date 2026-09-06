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

describe('registerAdminSecurityBulkModuleRoutes', () => {
  let serviceMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    serviceMock = {
      readInactiveBlockConfig: vi.fn().mockResolvedValue({ inactiveBlockDays: 90, autoBlockEnabled: false }),
      saveInactiveBlockConfig: vi.fn().mockResolvedValue(undefined),
      countInactiveUsers: vi.fn().mockResolvedValue(5),
      blockInactiveUsersByDays: vi.fn().mockResolvedValue(5),
      countPasswordResetTargets: vi.fn().mockResolvedValue(10),
      forcePasswordResetForPlayers: vi.fn().mockResolvedValue(10),
      parseInactiveDays: (v: unknown) => {
        const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
        return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : null;
      }
    };
    vi.doMock('../../../../../server/modules/admin/security-bulk/services/security-bulk.js', () => serviceMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/security-bulk/services/security-bulk.js');
  });

  async function loadApp() {
    const { registerAdminSecurityBulkModuleRoutes } = await import('../../../../../server/modules/admin/security-bulk/controllers/security-bulk.controller.js');
    const app = fakeApp();
    registerAdminSecurityBulkModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('GET .../bulk-tools/config devolve a config actual', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/security/bulk-tools/config']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, inactiveBlockDays: 90, autoBlockEnabled: false });
  });

  it('POST .../bulk-tools/config sem super admin: 403, não grava', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/bulk-tools/config']({ headers: {}, isSuperAdmin: false, body: { inactiveBlockDays: 30 } }, res);
    expect(res.statusCode).toBe(403);
    expect(serviceMock.saveInactiveBlockConfig).not.toHaveBeenCalled();
  });

  it('POST .../bulk-tools/config com dias inválidos: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/bulk-tools/config']({ headers: {}, isSuperAdmin: true, body: { inactiveBlockDays: 99999 } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST .../bulk-tools/config caminho feliz: grava e devolve os valores', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/bulk-tools/config']({ headers: {}, isSuperAdmin: true, body: { inactiveBlockDays: 30, autoBlockEnabled: true } }, res);
    expect(serviceMock.saveInactiveBlockConfig).toHaveBeenCalledWith(30, true);
    expect(res.body).toEqual({ ok: true, inactiveBlockDays: 30, autoBlockEnabled: true });
  });

  it('GET .../inactive-block/preview usa days da query se informado, senão o da config', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/security/inactive-block/preview']({ headers: {}, query: { days: '10' } }, res);
    expect(serviceMock.countInactiveUsers).toHaveBeenCalledWith(10);
    expect(res.body).toMatchObject({ ok: true, days: 10, inactiveCount: 5, excludesAdmins: true });
  });

  it('POST .../inactive-block/apply sem super admin: 403', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/inactive-block/apply']({ headers: {}, isSuperAdmin: false, body: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(serviceMock.blockInactiveUsersByDays).not.toHaveBeenCalled();
  });

  it('POST .../inactive-block/apply sem a frase de confirmação exacta: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/inactive-block/apply']({ headers: {}, isSuperAdmin: true, body: { days: 60, confirm: 'sim' } }, res);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.blockInactiveUsersByDays).not.toHaveBeenCalled();
  });

  it('POST .../inactive-block/apply caminho feliz: bloqueia e devolve a contagem', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/inactive-block/apply']({ headers: {}, isSuperAdmin: true, userId: 7, body: { days: 60, confirm: 'bloquear' } }, res);
    expect(serviceMock.blockInactiveUsersByDays).toHaveBeenCalledWith(60);
    expect(res.body).toEqual({ ok: true, days: 60, blockedCount: 5 });
  });

  it('GET .../force-password-reset/preview devolve o alvo actual', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/security/force-password-reset/preview']({ headers: {} }, res);
    expect(res.body).toEqual({ ok: true, targetCount: 10, excludesAdmins: true, excludesSuperAdmins: true });
  });

  it('POST .../force-password-reset/apply sem super admin: 403', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/force-password-reset/apply']({ headers: {}, isSuperAdmin: false, body: { confirm: 'REDEFINIR' } }, res);
    expect(res.statusCode).toBe(403);
    expect(serviceMock.forcePasswordResetForPlayers).not.toHaveBeenCalled();
  });

  it('POST .../force-password-reset/apply sem a frase de confirmação exacta: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/force-password-reset/apply']({ headers: {}, isSuperAdmin: true, body: { confirm: 'sim' } }, res);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.forcePasswordResetForPlayers).not.toHaveBeenCalled();
  });

  it('POST .../force-password-reset/apply caminho feliz: reseta e devolve a contagem', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/security/force-password-reset/apply']({ headers: {}, isSuperAdmin: true, userId: 7, body: { confirm: 'redefinir' } }, res);
    expect(serviceMock.forcePasswordResetForPlayers).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, resetCount: 10 });
  });
});
