import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    put: (path: string, ...fns: any[]) => {
      routes[`PUT ${path}`] = fns[fns.length - 1];
    },
    post: (path: string, ...fns: any[]) => {
      routes[`POST ${path}`] = fns[fns.length - 1];
    },
    delete: (path: string, ...fns: any[]) => {
      routes[`DELETE ${path}`] = fns[fns.length - 1];
    },
    routes
  };
}

const isAdmin = (_req: any, _res: any, next: any) => next();
const authenticateToken = (_req: any, _res: any, next: any) => next();
const parseCookies = (req: any) => ({ sid: req?.cookiesSid ?? 'sid-test' });
const issueJwtAuthCookies = vi.fn().mockResolvedValue(undefined);

describe('registerAdminUsersModuleRoutes', () => {
  const pool = { connect: vi.fn() };

  beforeEach(() => {
    vi.resetModules();
    issueJwtAuthCookies.mockClear();
  });

  async function loadApp() {
    const { registerAdminUsersModuleRoutes } = await import(
      '../../../../../server/modules/admin/users/controllers/users.controller.js'
    );
    const app = fakeApp();
    registerAdminUsersModuleRoutes(app as any, {
      isAdmin,
      authenticateToken,
      pool: pool as any,
      parseCookies,
      issueJwtAuthCookies
    });
    return app;
  }

  it('não registra leftovers portadas para o genesis-api', async () => {
    const app = await loadApp();
    expect(Object.keys(app.routes)).toEqual([]);
    expect(Object.keys(app.routes)).not.toContain('GET /api/users');
    expect(Object.keys(app.routes)).not.toContain('PUT /api/users/block');
    expect(Object.keys(app.routes)).not.toContain('PUT /api/user');
    expect(Object.keys(app.routes)).not.toContain('DELETE /api/user/:email');
    expect(Object.keys(app.routes)).not.toContain('GET /api/game-state/:email');
    expect(Object.keys(app.routes)).not.toContain(
      'POST /api/admin/users/:userId/save-game-override'
    );
    expect(Object.keys(app.routes)).not.toContain(
      'GET /api/admin/users/:userId/wallet-history'
    );
    expect(Object.keys(app.routes)).not.toContain('POST /api/admin/impersonate');
    expect(Object.keys(app.routes)).not.toContain('POST /api/admin/stop-impersonate');
    expect(Object.keys(app.routes)).not.toContain('PUT /api/admin/users/:userId/rooms');
  });

  afterEach(() => {
    /* no service mocks */
  });
});
