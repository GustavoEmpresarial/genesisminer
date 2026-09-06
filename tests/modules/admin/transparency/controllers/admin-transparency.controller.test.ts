import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const stacks: Record<string, any[]> = {};
  return {
    post: (path: string, ...fns: any[]) => {
      stacks[`POST ${path}`] = fns;
    },
    put: (path: string, ...fns: any[]) => {
      stacks[`PUT ${path}`] = fns;
    },
    delete: (path: string, ...fns: any[]) => {
      stacks[`DELETE ${path}`] = fns;
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

const POST = '/api/admin/transparency';
const PUT = '/api/admin/transparency/:id';
const DEL = '/api/admin/transparency/:id';

describe('registerAdminTransparencyModuleRoutes', () => {
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
        transparency_entries: {
          create: vi.fn(),
          findUnique: vi.fn(),
          update: vi.fn(),
          deleteMany: vi.fn()
        }
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
    const { registerAdminTransparencyModuleRoutes } = await import(
      '../../../../../server/modules/admin/transparency/controllers/admin-transparency.controller.js'
    );
    const app = fakeApp();
    registerAdminTransparencyModuleRoutes(app as any, { isAdmin: createIsAdminMiddleware({ parseCookies }) });
    return app;
  }

  it('POST sem sessão → 401', async () => {
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(app, `POST ${POST}`, { headers: {}, url: POST, originalUrl: POST, method: 'POST', body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST não-admin → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${POST}`,
      { headers: {}, userId: 9, url: POST, originalUrl: POST, method: 'POST', body: {} },
      res
    );
    expect(res.statusCode).toBe(403);
  });

  it('POST admin sem tab transparency → 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"reports":true}'
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${POST}`,
      { headers: {}, userId: 9, url: POST, originalUrl: POST, method: 'POST', body: { category: 'pool', title: 'T' } },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(prismaMock.prisma.transparency_entries.create).not.toHaveBeenCalled();
  });

  it('POST admin com tab transparency → 200 entry', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"transparency":true}'
    });
    prismaMock.prisma.transparency_entries.create.mockResolvedValue({
      id: 1,
      category: 'pool',
      title: 'T',
      body: null,
      amount_usdc: null,
      link_url: null,
      sort_order: 0,
      created_at: 1n,
      updated_at: 1n
    });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${POST}`,
      {
        headers: {},
        userId: 9,
        url: POST,
        originalUrl: POST,
        method: 'POST',
        body: { category: 'pool', title: 'T' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.title).toBe('T');
  });

  it('POST 400 categoria inválida', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${POST}`,
      { headers: {}, userId: 1, url: POST, originalUrl: POST, method: 'POST', body: { category: 'x', title: 'T' } },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('PUT super-admin 404 inexistente', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.transparency_entries.findUnique.mockResolvedValue(null);
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `PUT ${PUT}`,
      {
        headers: {},
        userId: 1,
        url: '/api/admin/transparency/3',
        originalUrl: '/api/admin/transparency/3',
        method: 'PUT',
        params: { id: '3' },
        body: { title: 'N' }
      },
      res
    );
    expect(res.statusCode).toBe(404);
  });

  it('PUT id inválido → 400', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `PUT ${PUT}`,
      {
        headers: {},
        userId: 1,
        url: '/api/admin/transparency/0',
        originalUrl: '/api/admin/transparency/0',
        method: 'PUT',
        params: { id: '0' },
        body: {}
      },
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('DELETE 200 { ok: true }', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({
      is_admin: 1,
      is_super_admin: 0,
      admin_permissions: '{"transparency":true}'
    });
    prismaMock.prisma.transparency_entries.deleteMany.mockResolvedValue({ count: 1 });
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `DELETE ${DEL}`,
      {
        headers: {},
        userId: 9,
        url: '/api/admin/transparency/2',
        originalUrl: '/api/admin/transparency/2',
        method: 'DELETE',
        params: { id: '2' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('erro interno → 500 sem SQL', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
    prismaMock.prisma.transparency_entries.create.mockRejectedValue(new Error('db down'));
    const app = await loadGuardedApp();
    const res = fakeRes();
    await dispatch(
      app,
      `POST ${POST}`,
      { headers: {}, userId: 1, url: POST, originalUrl: POST, method: 'POST', body: { category: 'pool', title: 'T' } },
      res
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/DATABASE_URL|SELECT /i);
  });
});
