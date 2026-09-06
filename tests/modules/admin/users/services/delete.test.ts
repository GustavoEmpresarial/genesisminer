import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('deleteAdminUserByEmail', () => {
  let prismaMock: Record<string, any>;
  let deleteUserMock: Record<string, any>;
  const revokeJwtRefreshForUser = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.resetModules();
    revokeJwtRefreshForUser.mockClear();
    prismaMock = {
      prisma: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 10, is_admin: 0 })
        }
      }
    };
    deleteUserMock = {
      deleteUserByEmail: vi.fn().mockResolvedValue({ ok: true })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/admin/referral/services/delete-user.js', () => deleteUserMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/admin/referral/services/delete-user.js');
  });

  async function load() {
    return import('../../../../../server/modules/admin/users/services/delete.js');
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      actorUserId: 1,
      actorIsSuperAdmin: false,
      emailRaw: 'player@x.com',
      revokeJwtRefreshForUser,
      ...overrides
    };
  }

  it('email vazio: 400 e não apaga', async () => {
    const { deleteAdminUserByEmail } = await load();
    await expect(deleteAdminUserByEmail(input({ emailRaw: '  ' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(deleteUserMock.deleteUserByEmail).not.toHaveBeenCalled();
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });

  it('utilizador inexistente: 404, sem delete nem revoke', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const { deleteAdminUserByEmail } = await load();
    await expect(deleteAdminUserByEmail(input())).rejects.toMatchObject({ statusCode: 404 });
    expect(deleteUserMock.deleteUserByEmail).not.toHaveBeenCalled();
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });

  it('utilizador existente: apaga e revoga JWT depois do sucesso', async () => {
    const { deleteAdminUserByEmail } = await load();
    const out = await deleteAdminUserByEmail(input());
    expect(out).toEqual({ ok: true });
    expect(deleteUserMock.deleteUserByEmail).toHaveBeenCalledWith('player@x.com', null);
    expect(revokeJwtRefreshForUser).toHaveBeenCalledWith(10);
  });

  it('decodifica email URL-encoded', async () => {
    const { deleteAdminUserByEmail, parseAdminUserPathEmail } = await load();
    expect(parseAdminUserPathEmail('a%40b.com')).toBe('a@b.com');
    await deleteAdminUserByEmail(input({ emailRaw: 'a%40b.com' }));
    expect(prismaMock.prisma.users.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: 'a@b.com', mode: 'insensitive' } } })
    );
    expect(deleteUserMock.deleteUserByEmail).toHaveBeenCalledWith('a@b.com', null);
  });

  it('admin comum a apagar outro admin: 403 sem mutação', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 99, is_admin: 1 });
    const { deleteAdminUserByEmail } = await load();
    await expect(deleteAdminUserByEmail(input({ actorUserId: 1, actorIsSuperAdmin: false }))).rejects.toMatchObject({
      statusCode: 403
    });
    expect(deleteUserMock.deleteUserByEmail).not.toHaveBeenCalled();
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });

  it('super-admin a apagar outro admin: permitido', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 99, is_admin: 1 });
    const { deleteAdminUserByEmail } = await load();
    const out = await deleteAdminUserByEmail(input({ actorIsSuperAdmin: true }));
    expect(out).toEqual({ ok: true });
    expect(deleteUserMock.deleteUserByEmail).toHaveBeenCalled();
    expect(revokeJwtRefreshForUser).toHaveBeenCalledWith(99);
  });

  it('admin comum a apagar a própria conta admin: permitido (sem regra extra de auto-exclusão)', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 1, is_admin: 1 });
    const { deleteAdminUserByEmail } = await load();
    const out = await deleteAdminUserByEmail(input({ actorUserId: 1, actorIsSuperAdmin: false }));
    expect(out).toEqual({ ok: true });
  });

  it('falha do helper não revoga JWT nem devolve ok', async () => {
    deleteUserMock.deleteUserByEmail.mockResolvedValue({ ok: false, error: 'Utilizador não encontrado.' });
    const { deleteAdminUserByEmail } = await load();
    await expect(deleteAdminUserByEmail(input())).rejects.toMatchObject({ statusCode: 404 });
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });

  it('helper a lançar não produz sucesso nem revoke', async () => {
    deleteUserMock.deleteUserByEmail.mockRejectedValue(new Error('db down'));
    const { deleteAdminUserByEmail } = await load();
    await expect(deleteAdminUserByEmail(input())).rejects.toThrow('db down');
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });
});
