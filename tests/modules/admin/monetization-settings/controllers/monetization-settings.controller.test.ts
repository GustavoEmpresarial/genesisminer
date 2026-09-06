import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const stacks: Record<string, any[]> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      stacks[`GET ${path}`] = fns;
    },
    post: (path: string, ...fns: any[]) => {
      stacks[`POST ${path}`] = fns;
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

const ADMIN_GET = '/api/admin/monetization-settings';
const PUBLIC = '/api/monetization-settings';

describe('registerAdminMonetizationSettingsModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  let stored: Record<string, string>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    stored = { applixir_callback_secret: 'sekrit', applixir_enabled: '1' };
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) },
        settings: {
          findMany: vi.fn(async ({ where }: any) => {
            const keys: string[] = where?.key?.in || [];
            return keys.filter((k) => stored[k] != null).map((k) => ({ key: k, value: stored[k] }));
          }),
          upsert: vi.fn().mockResolvedValue({})
        },
        $transaction: vi.fn(async (ops: any) => {
          if (Array.isArray(ops)) return Promise.all(ops);
          if (typeof ops === 'function') return ops(prismaMock.prisma);
          return ops;
        })
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (_req: any, _res: any, next: () => void) => {
        next();
      })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/auth/services/http-auth.js');
  });

  async function loadGuardedApp() {
    const { createIsAdminMiddleware } = await import('../../../../../server/modules/auth/services/admin-guard.js');
    const { registerAdminMonetizationSettingsModuleRoutes } = await import(
      '../../../../../server/modules/admin/monetization-settings/controllers/monetization-settings.controller.js'
    );
    const app = fakeApp();
    registerAdminMonetizationSettingsModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  /** O GET público é do genesis-api (`admin_tabs`); o Express só serve o GET admin. */
  it('GET público não é servido pelo Express', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`GET ${PUBLIC}`]).toBeUndefined();
  });

  it('GET admin sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${ADMIN_GET}`, { headers: {}, url: ADMIN_GET, originalUrl: ADMIN_GET, method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
  });

  it('GET admin não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${ADMIN_GET}`, { headers: {}, userId: 9, url: ADMIN_GET, originalUrl: ADMIN_GET, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  it('GET admin sem tab settings:monetization → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"reports":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${ADMIN_GET}`, { headers: {}, userId: 9, url: ADMIN_GET, originalUrl: ADMIN_GET, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  it('GET admin com tab settings:monetization → 200 com secret', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"settings:monetization":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${ADMIN_GET}`, { headers: {}, userId: 9, url: ADMIN_GET, originalUrl: ADMIN_GET, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body.applixirCallbackSecret).toBe('sekrit');
  });

  /** O POST (tab `settings:monetization`) é do genesis-api `admin_tabs`. */
  it('POST não é servido pelo Express', async () => {
    const app = await loadGuardedApp();
    expect(app.stacks[`POST ${PUBLIC}`]).toBeUndefined();
  });

  it('erro interno GET admin → 500 sem secret', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.settings.findMany.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${ADMIN_GET}`, { headers: {}, userId: 1, url: ADMIN_GET, originalUrl: ADMIN_GET, method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/sekrit|DATABASE_URL/i);
  });
});
