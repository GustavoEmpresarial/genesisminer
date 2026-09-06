import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('startAdminImpersonate / stopAdminImpersonate', () => {
  let prismaMock: {
    prisma: {
      users: { findFirst: ReturnType<typeof vi.fn> };
    };
  };
  let callAuthSessionLoad: ReturnType<typeof vi.fn>;
  let callAuthSessionUpdateFlags: ReturnType<typeof vi.fn>;

  const AUTH_WORKER = '../../../../../server/modules/auth/services/auth-worker-client.js';

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 20 })
        }
      }
    };
    callAuthSessionLoad = vi.fn().mockResolvedValue({
      ok: true,
      userId: 1,
      sessionId: 'sid-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      originalUserId: null,
      managerMode: 0,
      user: { id: 1, username: 'a', email: 'a@x.com' }
    });
    callAuthSessionUpdateFlags = vi.fn().mockResolvedValue({ ok: true, sessionId: 'sid-1', userId: 20 });
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock(AUTH_WORKER, async () => {
      const actual = await vi.importActual<typeof import('../../../../../server/modules/auth/services/auth-worker-client.js')>(
        AUTH_WORKER
      );
      return { ...actual, callAuthSessionLoad, callAuthSessionUpdateFlags };
    });
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock(AUTH_WORKER);
  });

  async function load() {
    return import('../../../../../server/modules/admin/users/services/impersonate.js');
  }

  it('start: sem sid → 400 Sessão necessária', async () => {
    const { startAdminImpersonate } = await load();
    await expect(
      startAdminImpersonate({ adminUserId: 1, sessionId: '', targetEmail: 'a@b.c' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Sessão necessária para personificação' });
    expect(callAuthSessionUpdateFlags).not.toHaveBeenCalled();
  });

  it('start: sessão inexistente → 400 Sessão inválida', async () => {
    callAuthSessionLoad.mockResolvedValue({ ok: false, status: 401, error: 'session not found' });
    const { startAdminImpersonate } = await load();
    await expect(
      startAdminImpersonate({ adminUserId: 1, sessionId: 'sid-1', targetEmail: 'a@b.c' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Sessão inválida' });
    expect(callAuthSessionUpdateFlags).not.toHaveBeenCalled();
  });

  it('start: worker 5xx → throw (fail-closed)', async () => {
    callAuthSessionLoad.mockResolvedValue({ ok: false, status: 502, error: 'auth worker HTTP 500' });
    const { startAdminImpersonate } = await load();
    await expect(
      startAdminImpersonate({ adminUserId: 1, sessionId: 'sid-1', targetEmail: 'a@b.c' })
    ).rejects.toThrow('auth worker HTTP 500');
  });

  it('start: alvo inexistente → Invalid target (não cria user)', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue(null);
    const { startAdminImpersonate } = await load();
    await expect(
      startAdminImpersonate({ adminUserId: 1, sessionId: 'sid-1', targetEmail: 'ghost@x.com' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid target' });
    expect(callAuthSessionUpdateFlags).not.toHaveBeenCalled();
  });

  it('start: alvo === admin → Invalid target', async () => {
    prismaMock.prisma.users.findFirst.mockResolvedValue({ id: 1 });
    const { startAdminImpersonate } = await load();
    await expect(
      startAdminImpersonate({ adminUserId: 1, sessionId: 'sid-1', targetEmail: 'admin@x.com' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid target' });
    expect(callAuthSessionUpdateFlags).not.toHaveBeenCalled();
  });

  it('start: caminho feliz atualiza sessão e devolve targetUserId', async () => {
    const { startAdminImpersonate } = await load();
    const out = await startAdminImpersonate({
      adminUserId: 1,
      sessionId: 'sid-1',
      targetEmail: 'player@x.com'
    });
    expect(out).toEqual({ targetUserId: 20 });
    expect(prismaMock.prisma.users.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'player@x.com', mode: 'insensitive' } },
      select: { id: true }
    });
    expect(callAuthSessionUpdateFlags).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      userId: 20,
      originalUserId: 1,
      managerMode: 0,
      actingAsOwnerId: null
    });
  });

  it('stop: sem original_user_id → Not impersonating', async () => {
    callAuthSessionLoad.mockResolvedValue({
      ok: true,
      userId: 1,
      sessionId: 'sid-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      originalUserId: null,
      managerMode: 0,
      user: { id: 1, username: 'a', email: 'a@x.com' }
    });
    const { stopAdminImpersonate } = await load();
    await expect(stopAdminImpersonate({ sessionId: 'sid-1' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Not impersonating'
    });
    expect(callAuthSessionUpdateFlags).not.toHaveBeenCalled();
  });

  it('stop: caminho feliz restaura admin', async () => {
    callAuthSessionLoad.mockResolvedValue({
      ok: true,
      userId: 20,
      sessionId: 'sid-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      originalUserId: 7,
      managerMode: 0,
      user: { id: 20, username: 'p', email: 'p@x.com' }
    });
    const { stopAdminImpersonate } = await load();
    const out = await stopAdminImpersonate({ sessionId: 'sid-1' });
    expect(out).toEqual({ adminUserId: 7 });
    expect(callAuthSessionUpdateFlags).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      userId: 7,
      originalUserId: null,
      managerMode: 0,
      actingAsOwnerId: null
    });
  });
});
