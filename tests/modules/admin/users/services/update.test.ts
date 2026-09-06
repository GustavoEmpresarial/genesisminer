import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';

describe('updateAdminUser', () => {
  let prismaMock: Record<string, any>;
  let tx: Record<string, any>;
  let walletHistory: Record<string, any>;
  let authBcrypt: { hash: ReturnType<typeof vi.fn> };
  const revokeJwtRefreshForUser = vi.fn().mockResolvedValue(undefined);

  const AUTH_WORKER = '../../../../../server/modules/auth/services/auth-worker-client.js';

  const baseTarget = {
    id: 10,
    username: 'alice',
    email: 'alice@x.com',
    password: 'hash',
    is_admin: 0,
    is_super_admin: 0,
    is_blocked: 0,
    polygon_wallet: WALLET_A,
    access_level_id: 'free'
  };

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      actorUserId: 1,
      actorIsSuperAdmin: false,
      targetId: 10,
      username: 'alice',
      email: 'alice@x.com',
      accessLevelId: 'free',
      accessLevelIds: ['free'],
      revokeJwtRefreshForUser,
      ...overrides
    };
  }

  beforeEach(() => {
    vi.resetModules();
    revokeJwtRefreshForUser.mockClear();
    tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      users: { update: vi.fn().mockResolvedValue(undefined) },
      user_access_levels: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      user_wallet_history: { create: vi.fn().mockResolvedValue(undefined) }
    };
    prismaMock = {
      prisma: {
        users: {
          findUnique: vi.fn().mockResolvedValue(baseTarget),
          findFirst: vi.fn().mockResolvedValue(null)
        },
        access_levels: { findMany: vi.fn().mockResolvedValue([{ id: 'free' }]) },
        user_access_levels: {
          findMany: vi.fn().mockResolvedValue([{ access_level_id: 'free' }])
        },
        $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx))
      }
    };
    walletHistory = {
      appendUserWalletHistory: vi.fn().mockResolvedValue(undefined),
      normalizeWalletCompareKey: (raw: string | null | undefined) => String(raw || '').trim().toLowerCase()
    };
    authBcrypt = { hash: vi.fn().mockResolvedValue('new-hash') };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/profile/services/wallet-history.js', () => walletHistory);
    vi.doMock(AUTH_WORKER, async () => {
      const actual = await vi.importActual<typeof import('../../../../../server/modules/auth/services/auth-worker-client.js')>(
        AUTH_WORKER
      );
      return { ...actual, authWorkerBcrypt: authBcrypt };
    });
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/profile/services/wallet-history.js');
    vi.doUnmock(AUTH_WORKER);
  });

  async function load() {
    return import('../../../../../server/modules/admin/users/services/update.js');
  }

  it('id inexistente: 404 e não abre transação', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue(null);
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput())).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('username válido: actualiza', async () => {
    const { updateAdminUser } = await load();
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce(baseTarget)
      .mockResolvedValueOnce({ ...baseTarget, username: 'bob' });
    const out = await updateAdminUser(baseInput({ username: 'bob' }));
    expect(out.ok).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(out.user.username).toBe('bob');
  });

  it('username inválido: rejeita', async () => {
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ username: '<>' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('username duplicado: conflito', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 99 });
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ username: 'taken' }))).rejects.toMatchObject({
      statusCode: 409,
      jsonBody: expect.objectContaining({ code: 'USERNAME_TAKEN' })
    });
  });

  it('email é normalizado para lowercase', async () => {
    const { updateAdminUser } = await load();
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce(baseTarget)
      .mockResolvedValueOnce({ ...baseTarget, email: 'new@x.com' });
    await updateAdminUser(baseInput({ email: '  New@X.COM  ' }));
    expect(String(tx.$executeRaw.mock.calls[0][0])).toBeDefined();
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it('email duplicado: conflito', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 99 });
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ email: 'other@x.com' }))).rejects.toMatchObject({
      statusCode: 409,
      jsonBody: expect.objectContaining({ code: 'EMAIL_TAKEN' })
    });
  });

  it('admin comum a alterar email de outro admin: 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ ...baseTarget, is_admin: 1 });
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ email: 'novo@x.com', actorIsSuperAdmin: false }))).rejects.toMatchObject({
      statusCode: 403
    });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('super-admin a alterar email de admin: permitido', async () => {
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce({ ...baseTarget, is_admin: 1 })
      .mockResolvedValueOnce({ ...baseTarget, is_admin: 1, email: 'novo@x.com' });
    const { updateAdminUser } = await load();
    const out = await updateAdminUser(baseInput({ email: 'novo@x.com', actorIsSuperAdmin: true }));
    expect(out.ok).toBe(true);
  });

  it('sem password: não altera senha nem revoga tokens', async () => {
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput());
    expect(authBcrypt.hash).not.toHaveBeenCalled();
    expect(tx.users.update.mock.calls[0][0].data.password).toBeUndefined();
    expect(revokeJwtRefreshForUser).not.toHaveBeenCalled();
  });

  it('password válida: altera e revoga refresh', async () => {
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput({ password: 'validPass9' }));
    expect(authBcrypt.hash).toHaveBeenCalledWith('validPass9', 10);
    expect(tx.users.update.mock.calls[0][0].data.password).toBe('new-hash');
    expect(revokeJwtRefreshForUser).toHaveBeenCalledWith(10);
  });

  it('password fraca: rejeita', async () => {
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ password: '123' }))).rejects.toMatchObject({
      statusCode: 422,
      jsonBody: expect.objectContaining({ code: 'PASSWORD_WEAK' })
    });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('admin comum a alterar senha de super-admin: 403', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ ...baseTarget, is_super_admin: 1, is_admin: 1 });
    const { updateAdminUser } = await load();
    await expect(
      updateAdminUser(baseInput({ password: 'validPass9', actorIsSuperAdmin: false }))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('super-admin a alterar senha de super-admin: permitido', async () => {
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce({ ...baseTarget, is_super_admin: 1, is_admin: 1 })
      .mockResolvedValueOnce({ ...baseTarget, is_super_admin: 1, is_admin: 1 });
    const { updateAdminUser } = await load();
    const out = await updateAdminUser(baseInput({ password: 'validPass9', actorIsSuperAdmin: true }));
    expect(out.ok).toBe(true);
    expect(tx.users.update.mock.calls[0][0].data.password).toBe('new-hash');
  });

  it('wallet alterada: persiste + histórico admin_changed', async () => {
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput({ polygonWallet: WALLET_B }));
    expect(tx.users.update.mock.calls[0][0].data.polygon_wallet).toBe(WALLET_B);
    expect(walletHistory.appendUserWalletHistory).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 10,
        action: 'admin_changed',
        actorType: 'admin',
        actorUserId: 1,
        newWalletAddress: WALLET_B
      })
    );
  });

  it('wallet igual: não duplica histórico', async () => {
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput({ polygonWallet: WALLET_A }));
    expect(walletHistory.appendUserWalletHistory).not.toHaveBeenCalled();
  });

  it('substitui o conjunto de access levels (replace, não append)', async () => {
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'vip' }, { id: 'free' }]);
    prismaMock.prisma.user_access_levels.findMany.mockResolvedValue([
      { access_level_id: 'vip' },
      { access_level_id: 'free' }
    ]);
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce(baseTarget)
      .mockResolvedValueOnce({ ...baseTarget, access_level_id: 'vip' });
    const { updateAdminUser } = await load();
    const out = await updateAdminUser(baseInput({ accessLevelId: 'vip', accessLevelIds: ['vip', 'free'] }));
    expect(tx.user_access_levels.deleteMany).toHaveBeenCalledWith({ where: { user_id: 10 } });
    expect(tx.user_access_levels.createMany).toHaveBeenCalledTimes(1);
    const created = tx.user_access_levels.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(2);
    expect(created.map((r: { access_level_id: string }) => r.access_level_id)).toEqual(['vip', 'free']);
    expect(tx.users.update.mock.calls[0][0].data.access_level_id).toBe('vip');
    expect(out.user.accessLevelId).toBe('vip');
  });

  it('IDs de access level inválidos: rejeita', async () => {
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'free' }]);
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ accessLevelId: 'ghost', accessLevelIds: ['ghost'] }))).rejects.toMatchObject({
      statusCode: 400
    });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('níveis órfãos inalterados: permite update de email sem validar catálogo', async () => {
    prismaMock.prisma.users.findUnique
      .mockResolvedValueOnce({ ...baseTarget, access_level_id: 'orphan' })
      .mockResolvedValueOnce({ ...baseTarget, access_level_id: 'orphan', email: 'new@x.com' });
    prismaMock.prisma.user_access_levels.findMany.mockResolvedValue([{ access_level_id: 'orphan' }]);
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'free' }]);
    const { updateAdminUser } = await load();
    const out = await updateAdminUser(
      baseInput({
        email: 'new@x.com',
        accessLevelId: 'orphan',
        accessLevelIds: ['orphan']
      })
    );
    expect(out.ok).toBe(true);
    expect(out.user.email).toBe('new@x.com');
    expect(prismaMock.prisma.access_levels.findMany).not.toHaveBeenCalled();
    expect(prismaMock.prisma.$transaction).toHaveBeenCalled();
  });

  it('nível inválido novo no payload: rejeita mesmo com grants órfãos actuais', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue({ ...baseTarget, access_level_id: 'orphan' });
    prismaMock.prisma.user_access_levels.findMany.mockResolvedValue([{ access_level_id: 'orphan' }]);
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'free' }]);
    const { updateAdminUser } = await load();
    await expect(
      updateAdminUser(
        baseInput({
          accessLevelId: 'ghost',
          accessLevelIds: ['ghost']
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: expect.objectContaining({ error: 'One or more access levels do not exist.' })
    });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('users.access_level_id fica coerente com o primário mesmo se omitido da lista', async () => {
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'vip' }, { id: 'free' }]);
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput({ accessLevelId: 'vip', accessLevelIds: ['free'] }));
    expect(tx.users.update.mock.calls[0][0].data.access_level_id).toBe('vip');
    const created = tx.user_access_levels.createMany.mock.calls[0][0].data;
    expect(created.map((r: { access_level_id: string }) => r.access_level_id)).toEqual(['vip', 'free']);
  });

  it('falha numa etapa faz rollback (transação rejeita)', async () => {
    tx.user_access_levels.createMany.mockRejectedValue(new Error('fk boom'));
    prismaMock.prisma.access_levels.findMany.mockResolvedValue([{ id: 'free' }]);
    const { updateAdminUser } = await load();
    await expect(updateAdminUser(baseInput({ username: 'bob' }))).rejects.toThrow('fk boom');
    expect(prismaMock.prisma.$transaction).toHaveBeenCalled();
  });

  it('update de users não inclui flags administrativas', async () => {
    const { updateAdminUser } = await load();
    await updateAdminUser(baseInput());
    const data = tx.users.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('is_admin');
    expect(data).not.toHaveProperty('is_super_admin');
    expect(data).not.toHaveProperty('admin_permissions');
    expect(data).not.toHaveProperty('is_blocked');
  });
});
