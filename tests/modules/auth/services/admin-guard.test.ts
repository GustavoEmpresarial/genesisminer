import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    url: '/api/admin/users/map',
    originalUrl: '/api/admin/users/map',
    method: 'GET',
    userId: undefined,
    ...overrides
  } as any;
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

describe('admin-guard services/admin-guard', () => {
  let prismaMock: Record<string, any>;
  let httpAuthMock: Record<string, any>;
  const parseCookies = () => ({});

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn() },
        user_history_ips: { findFirst: vi.fn().mockResolvedValue(null) },
        admin_access_logs: { create: vi.fn().mockResolvedValue(undefined) }
      }
    };
    httpAuthMock = {
      createResolveAuthMiddleware: vi.fn(() => (req: any, _res: any, next: () => void) => {
        next();
      })
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/auth/services/http-auth.js', () => httpAuthMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/auth/services/http-auth.js');
  });

  describe('loadAdminGateContext', () => {
    it('utilizador não é admin: devolve null', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
      const { loadAdminGateContext } = await import('../../../../server/modules/auth/services/admin-guard.js');
      expect(await loadAdminGateContext(1)).toBeNull();
    });

    it('admin com permissões JSON válidas: devolve contexto', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '{"users":true}' });
      const { loadAdminGateContext } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const ctx = await loadAdminGateContext(1);
      expect(ctx).toEqual({ isSuperAdmin: false, tabSet: new Set(['users']), rawAdminPermissions: { users: true } });
    });

    it('admin_permissions com JSON inválido: não lança, tabSet vazio', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '{broken' });
      const { loadAdminGateContext } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const ctx = await loadAdminGateContext(1);
      expect(ctx?.tabSet.size).toBe(0);
    });

    it('erro na BD: devolve null (não lança)', async () => {
      prismaMock.prisma.users.findUnique.mockRejectedValue(new Error('db down'));
      const { loadAdminGateContext } = await import('../../../../server/modules/auth/services/admin-guard.js');
      expect(await loadAdminGateContext(1)).toBeNull();
    });
  });

  describe('createIsAdminMiddleware', () => {
    it('sem userId resolvido: 401 e loga tentativa', async () => {
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq();
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
      expect(prismaMock.prisma.admin_access_logs.create).toHaveBeenCalled();
    });

    it('userId resolvido mas sem is_admin: 403 Acesso negado', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5 });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Access denied' });
    });

    it('admin sem permissão para a rota: 403 Permissão insuficiente', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '{"games":true}' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/admin/restore', originalUrl: '/api/admin/restore', method: 'POST' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Permissão insuficiente para esta operação.' });
    });

    it('admin com a permissão certa: passa e seta isSuperAdmin/adminPermissions no req', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '{"users":true}' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5 });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.isSuperAdmin).toBe(false);
      expect(req.adminPermissions).toEqual({ users: true });
    });

    it('admin com a permissão users em PUT /api/user: passa', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["users"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user', originalUrl: '/api/user', method: 'PUT' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('admin sem aba users em PUT /api/user: 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["reports"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user', originalUrl: '/api/user', method: 'PUT' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('super-admin em PUT /api/user: passa sem aba users', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user', originalUrl: '/api/user', method: 'PUT' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('admin com aba users em DELETE /api/user/:email: passa', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["users"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user/a@b.com', originalUrl: '/api/user/a@b.com', method: 'DELETE' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('admin sem aba users em DELETE /api/user/:email: 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["reports"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user/a@b.com', originalUrl: '/api/user/a@b.com', method: 'DELETE' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('super-admin em DELETE /api/user/:email: passa sem aba users', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({ userId: 5, url: '/api/user/a@b.com', originalUrl: '/api/user/a@b.com', method: 'DELETE' });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('admin com aba users em GET /api/admin/users/:id/wallet-history: passa', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["users"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({
        userId: 5,
        url: '/api/admin/users/10/wallet-history',
        originalUrl: '/api/admin/users/10/wallet-history',
        method: 'GET'
      });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('admin sem aba users em GET /api/admin/users/:id/wallet-history: 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 0, admin_permissions: '["reports"]' });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({
        userId: 5,
        url: '/api/admin/users/10/wallet-history',
        originalUrl: '/api/admin/users/10/wallet-history',
        method: 'GET'
      });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('super-admin em GET /api/admin/users/:id/wallet-history: passa sem aba users', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 1, is_super_admin: 1, admin_permissions: null });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({
        userId: 5,
        url: '/api/admin/users/10/wallet-history',
        originalUrl: '/api/admin/users/10/wallet-history',
        method: 'GET'
      });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('não-admin em GET /api/admin/users/:id/wallet-history: 403', async () => {
      prismaMock.prisma.users.findUnique.mockResolvedValue({ is_admin: 0, is_super_admin: 0, admin_permissions: null });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq({
        userId: 5,
        url: '/api/admin/users/10/wallet-history',
        originalUrl: '/api/admin/users/10/wallet-history',
        method: 'GET'
      });
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('erro inesperado no meio do fluxo: 500 Erro interno', async () => {
      prismaMock.prisma.users.findUnique.mockRejectedValue(new Error('boom'));
      httpAuthMock.createResolveAuthMiddleware = vi.fn(() => () => {
        throw new Error('boom');
      });
      const { createIsAdminMiddleware } = await import('../../../../server/modules/auth/services/admin-guard.js');
      const isAdmin = createIsAdminMiddleware({ parseCookies });
      const req = fakeReq();
      const res = fakeRes();
      const next = vi.fn();
      await isAdmin(req, res, next);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('isIpFromUser', () => {
    it('encontra histórico: true', async () => {
      prismaMock.prisma.user_history_ips.findFirst.mockResolvedValue({ user_id: 1 });
      const { isIpFromUser } = await import('../../../../server/modules/auth/services/admin-guard.js');
      expect(await isIpFromUser('1.2.3.4')).toBe(true);
    });

    it('erro na BD: false (não lança)', async () => {
      prismaMock.prisma.user_history_ips.findFirst.mockRejectedValue(new Error('db down'));
      const { isIpFromUser } = await import('../../../../server/modules/auth/services/admin-guard.js');
      expect(await isIpFromUser('1.2.3.4')).toBe(false);
    });
  });
});
