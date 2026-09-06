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
    delete: (path: string, ...fns: any[]) => {
      stacks[`DELETE ${path}`] = fns;
    },
    put: (path: string, ...fns: any[]) => {
      stacks[`PUT ${path}`] = fns;
    },
    stacks
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

const LIST = '/api/admin/promo-codes';
const BULK = '/api/admin/promo-codes/bulk-delete';
const DEL = '/api/admin/promo-codes/:code';
const TOGGLE = '/api/admin/promo-codes/:code/toggle';

describe('registerAdminPromoCodesModuleRoutes', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) },
        promo_codes: {
          findMany: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 })
        },
        promo_code_redemptions: {
          groupBy: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 })
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $transaction: vi.fn(async (arg: any) => {
          if (typeof arg === 'function') return arg(prismaMock.prisma);
          if (Array.isArray(arg)) {
            const results = [];
            for (const p of arg) results.push(await p);
            return results;
          }
          return arg;
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
    const { registerAdminPromoCodesModuleRoutes } = await import(
      '../../../../../server/modules/admin/promo-codes/controllers/promo-codes.controller.js'
    );
    const app = fakeApp();
    registerAdminPromoCodesModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('GET sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(401);
  });

  it('GET não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, userId: 9, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
  });

  /**
   * `resolveAdminRouteRequirement` concede `/api/admin/promo-codes` a
   * `settings:monetization` **ou** `lootboxes` (`anyOf`), de propósito: os
   * códigos promo têm `loot_box_id` e o ecrã de Lucky Boxes consome esta mesma
   * API (`AdminLootBoxes.tsx` → `apiFetch('/api/admin/promo-codes')`). Estreitar
   * para só `settings:monetization` partiria esse ecrã.
   */
  it('GET admin com lootboxes (sem settings:monetization) → 200: anyOf concede', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"lootboxes":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, userId: 9, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(prismaMock.prisma.promo_codes.findMany).toHaveBeenCalled();
  });

  it('GET admin sem nenhuma das tabs do anyOf → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"support":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, userId: 9, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.promo_codes.findMany).not.toHaveBeenCalled();
  });

  it('GET admin com settings:monetization → 200 array', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"settings:monetization":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, userId: 9, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST 400 payload inválido', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${LIST}`,
      { headers: {}, userId: 1, url: LIST, originalUrl: LIST, method: 'POST', body: { code: 'X' } },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST super-admin → 200 { ok: true }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${LIST}`,
      { headers: {}, userId: 1, url: LIST, originalUrl: LIST, method: 'POST', body: { code: 'ABC1', lootBoxId: 'box' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE código → 200 mesmo se inexistente', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"settings:monetization":true}'
    });
    prismaMock.prisma.promo_codes.deleteMany.mockResolvedValue({ count: 0 });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `DELETE ${DEL}`,
      { headers: {}, userId: 9, url: '/api/admin/promo-codes/NOPE', originalUrl: '/api/admin/promo-codes/NOPE', method: 'DELETE', params: { code: 'NOPE' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('PUT toggle → 200', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"settings:monetization":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `PUT ${TOGGLE}`,
      {
        headers: {},
        userId: 9,
        url: '/api/admin/promo-codes/ABC/toggle',
        originalUrl: '/api/admin/promo-codes/ABC/toggle',
        method: 'PUT',
        params: { code: 'ABC' },
        body: { isActive: false }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(prismaMock.prisma.promo_codes.updateMany).toHaveBeenCalledWith({
      where: { code: 'ABC' },
      data: { is_active: 0 }
    });
  });

  it('POST bulk-delete admin tab sem super → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"settings:monetization":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BULK}`,
      {
        headers: {},
        userId: 9,
        url: BULK,
        originalUrl: BULK,
        method: 'POST',
        body: { codes: ['AAAA'] }
      },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('POST bulk-delete super → 200 deleted', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.promo_codes.deleteMany.mockResolvedValue({ count: 1 });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BULK}`,
      { headers: {}, userId: 1, url: BULK, originalUrl: BULK, method: 'POST', body: { codes: ['AAAA'] } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 1 });
  });

  it('POST bulk-delete 400 lista vazia', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${BULK}`,
      { headers: {}, userId: 1, url: BULK, originalUrl: BULK, method: 'POST', body: { codes: [] } },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('GET 500 seguro', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.promo_codes.findMany.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `GET ${LIST}`, { headers: {}, userId: 1, url: LIST, originalUrl: LIST, method: 'GET' }, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/DATABASE_URL/i);
  });
});
