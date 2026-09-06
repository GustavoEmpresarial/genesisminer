import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const stacks: Record<string, any[]> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      stacks[`GET ${path}`] = fns;
    },
    stacks
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
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
    }
  };
  return res;
}

async function dispatch(app: ReturnType<typeof fakeApp>, key: string, req: any, res: any) {
  const fns = app.stacks[key];
  for (let i = 0; i < fns.length; i++) {
    let nextCalled = false;
    await new Promise<void>((resolve, reject) => {
      const next = (err?: unknown) => {
        nextCalled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      Promise.resolve(fns[i](req, res, next)).then(() => {
        if (!nextCalled) resolve();
      }, reject);
    });
    if (!nextCalled) return;
  }
}

const PATH = '/api/admin/etherscan/treasury-token-txs';
const KEY = 'controller-test-key';

describe('registerAdminEtherscanModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  let settingsRepo: { getSettingValue: ReturnType<typeof vi.fn> };
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) }
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: () => void) => {
        next();
      })
    };
    settingsRepo = { getSettingValue: vi.fn().mockResolvedValue(null) };
    vi.stubEnv('ETHERSCAN_API_KEY', KEY);
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
    vi.doMock('../../../../../server/shared/settings/settings-repository.js', () => settingsRepo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
    vi.doUnmock('../../../../../server/shared/settings/settings-repository.js');
  });

  async function loadGuardedApp(fetchImpl?: (url: string) => Promise<{ json: () => Promise<unknown> }>) {
    if (fetchImpl) {
      vi.stubGlobal('fetch', fetchImpl);
    }
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminEtherscanModuleRoutes } = await import(
      '../../../../../server/modules/admin/etherscan/controllers/etherscan.controller.js'
    );
    const app = fakeApp();
    registerAdminEtherscanModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin sem reports → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"users":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin reports → 200 contrato Etherscan + no-store; secret ausente', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"reports":true}'
    });
    const payload = { status: '1', message: 'OK', result: [{ hash: '0x1', timeStamp: '1', from: '0xa', to: '0xb', value: '0' }] };
    const app = await loadGuardedApp(async () => ({ json: async () => payload }));
    const res = fakeRes();
    await dispatch(
      app,
      `GET ${PATH}`,
      { headers: {}, userId: 9, url: PATH, originalUrl: PATH, method: 'GET', query: { page: '1', offset: '20' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toEqual(payload);
    expect(JSON.stringify(res.body)).not.toMatch(KEY);
  });

  it('super-admin → 200', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp(async () => ({ json: async () => ({ status: '0', message: 'No transactions found', result: [] }) }));
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('sem API key → 503 mensagem legado', async () => {
    vi.stubEnv('ETHERSCAN_API_KEY', '');
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('ETHERSCAN_API_KEY não configurada no servidor.');
  });

  it('fetch falha → 502 sem secret', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp(async () => {
      throw new Error(`fail apikey=${KEY}`);
    });
    const res = fakeRes();
    await dispatch(app, `GET ${PATH}`, { headers: {}, userId: 1, url: PATH, originalUrl: PATH, method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Falha ao contactar Etherscan.' });
    expect(JSON.stringify(res.body)).not.toMatch(KEY);
  });
});
