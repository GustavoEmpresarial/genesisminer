import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('isManagerAllowedRoute', () => {
  let guardModule: typeof import('../../../../server/modules/gerente/services/guard.js');

  beforeEach(async () => {
    guardModule = await import('../../../../server/modules/gerente/services/guard.js');
  });

  it('GET fora de /api/admin é sempre permitido', () => {
    expect(guardModule.isManagerAllowedRoute('GET', '/api/dashboard/state')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('GET', '/api/qualquer-coisa-nova')).toBe(true);
  });

  it('GET /api/admin/* é bloqueado mesmo em modo gerência', () => {
    expect(guardModule.isManagerAllowedRoute('GET', '/api/admin/users')).toBe(false);
  });

  it('POST só passa se estiver na allowlist explícita', () => {
    expect(guardModule.isManagerAllowedRoute('POST', '/api/checkin')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/servers/racks/place')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/servers/racks/rack_1/remove')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/servers/rack_1/remove')).toBe(false);
  });

  it('GET inventory/state e /me passam (não-admin)', () => {
    expect(guardModule.isManagerAllowedRoute('GET', '/api/inventory/state')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('GET', '/api/inventory/me')).toBe(true);
  });

  it('POST fora da allowlist é bloqueado (ex.: comprar, transferir)', () => {
    expect(guardModule.isManagerAllowedRoute('POST', '/api/rig-rooms/purchase-slot')).toBe(false);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/upgrades/purchase')).toBe(false);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/admin/users/1/ban')).toBe(false);
  });

  it('POST lucky-boxes (purchase/open/discard/promocode) passam na allowlist', () => {
    expect(guardModule.isManagerAllowedRoute('POST', '/api/lucky-boxes/purchase')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/lucky-boxes/open')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/lucky-boxes/discard')).toBe(true);
    expect(guardModule.isManagerAllowedRoute('POST', '/api/lucky-boxes/promocodes/redeem')).toBe(true);
  });

  it('GET /api/calculator/me passa (blanket GET não-admin)', () => {
    expect(guardModule.isManagerAllowedRoute('GET', '/api/calculator/me')).toBe(true);
  });

  it('normaliza path sem prefixo /api', () => {
    expect(guardModule.isManagerAllowedRoute('POST', 'checkin')).toBe(true);
  });
});

describe('isApiPath', () => {
  it('só /api e /api/*', async () => {
    const { isApiPath } = await import('../../../../server/modules/gerente/services/guard.js');
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/dashboard')).toBe(true);
    expect(isApiPath('/management')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});

describe('createManagerModeGuard', () => {
  let managerMock: Record<string, any>;
  let featureMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    managerMock = { loadSessionManagerFlags: vi.fn() };
    featureMock = { isAccountManagerEnabled: vi.fn().mockReturnValue(true) };
    vi.doMock('../../../../server/modules/gerente/services/manager.js', () => managerMock);
    vi.doMock('../../../../server/modules/gerente/services/feature.js', () => featureMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/gerente/services/manager.js');
    vi.doUnmock('../../../../server/modules/gerente/services/feature.js');
  });

  function fakeReqRes(overrides: Record<string, any> = {}) {
    const req: any = { headers: {}, method: 'GET', originalUrl: '/api/dashboard/state', ...overrides };
    const res: any = { statusCode: 200, body: undefined, status(n: number) { res.statusCode = n; return res; }, json(b: unknown) { res.body = b; return res; } };
    const next = vi.fn();
    return { req, res, next };
  }

  it('sem manager_mode: chama next() e não seta flags', async () => {
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: false, managerUserId: null, actingAsOwnerId: null, isManagingAccount: false });
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({}) });
    const { req, res, next } = fakeReqRes();
    await guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.managerMode).toBe(false);
  });

  it('manager_mode + rota fora da allowlist: 403 MANAGER_FORBIDDEN', async () => {
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: true, managerUserId: 1, actingAsOwnerId: 2, isManagingAccount: true });
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({ sid: 'abc' }) });
    const { req, res, next } = fakeReqRes({ method: 'POST', originalUrl: '/api/upgrades/purchase' });
    await guard(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'MANAGER_FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
  });

  it('manager_mode + rota dentro da allowlist: chama next() com flags setadas', async () => {
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: true, managerUserId: 1, actingAsOwnerId: 2, isManagingAccount: true });
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({ sid: 'abc' }) });
    const { req, res, next } = fakeReqRes({ method: 'POST', originalUrl: '/api/checkin' });
    await guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.managerMode).toBe(true);
    expect(req.managerUserId).toBe(1);
    expect(req.actingAsOwnerId).toBe(2);
  });

  it('feature desligada em manager_mode: só deixa passar a rota de escape (leave)', async () => {
    featureMock.isAccountManagerEnabled.mockReturnValue(false);
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: true, managerUserId: 1, actingAsOwnerId: 2, isManagingAccount: true });
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({ sid: 'abc' }) });

    const blocked = fakeReqRes({ method: 'GET', originalUrl: '/api/dashboard/state' });
    await guard(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.statusCode).toBe(503);
    expect(blocked.next).not.toHaveBeenCalled();

    const allowed = fakeReqRes({ method: 'POST', originalUrl: '/api/account-manager/leave' });
    await guard(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledTimes(1);
  });

  it('path fora de /api (SPA/estático) nunca é bloqueado, mesmo em manager_mode', async () => {
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: true, managerUserId: 1, actingAsOwnerId: 2, isManagingAccount: true });
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({ sid: 'abc' }) });
    const { req, res, next } = fakeReqRes({ method: 'GET', originalUrl: '/management' });
    await guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('erro no meio do guard não derruba a requisição — chama next()', async () => {
    managerMock.loadSessionManagerFlags.mockRejectedValue(new Error('db down'));
    const { createManagerModeGuard } = await import('../../../../server/modules/gerente/services/guard.js');
    const guard = createManagerModeGuard({ pool: {} as any, parseCookies: () => ({ sid: 'abc' }) });
    const { req, res, next } = fakeReqRes();
    await guard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
