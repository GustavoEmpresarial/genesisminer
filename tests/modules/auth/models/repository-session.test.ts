import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('auth repository session (auth worker)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/modules/auth/services/auth-worker-client.js');
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/auth/services/auth-rust-bridge.js');
  });

  async function loadRepo(client: Record<string, ReturnType<typeof vi.fn>>) {
    vi.doMock('../../../../server/core/database/prisma.js', () => ({ prisma: {} }));
    vi.doMock('../../../../server/modules/auth/services/auth-rust-bridge.js', () => ({
      rustLockoutStatus: () => null
    }));
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => client);
    return import('../../../../server/modules/auth/models/repository.js');
  }

  it('insertSession / deleteSessionBySessionId delegam e lançam se worker falha', async () => {
    const create = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'nope' });
    const del = vi.fn().mockResolvedValue({ ok: true });
    const repo = await loadRepo({
      callAuthSessionCreate: create,
      callAuthSessionDelete: del,
      callAuthSessionLoad: vi.fn()
    });
    await repo.insertSession('sid', 2, 1, 99);
    expect(create).toHaveBeenCalledWith({ userId: 2, sessionId: 'sid', expiresAtMs: 99 });
    await expect(repo.insertSession('sid', 2, 1, 99)).rejects.toThrow('nope');
    await repo.deleteSessionBySessionId('sid');
    expect(del).toHaveBeenCalledWith({ sessionId: 'sid' });
  });

  it('loadSessionUser 401 → null; unset → throw', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, error: 'session not found' })
      .mockRejectedValueOnce(new Error('GENESIS_AUTH_URL unset'));
    const repo = await loadRepo({
      callAuthSessionCreate: vi.fn(),
      callAuthSessionDelete: vi.fn(),
      callAuthSessionLoad: load
    });
    expect(await repo.loadSessionUser('gone')).toBeNull();
    await expect(repo.loadSessionUser('gone')).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('findActiveSessionUserId vs findSessionUserIdIgnoringExpiry', async () => {
    const load = vi.fn().mockResolvedValue({
      ok: true,
      userId: 7,
      sessionId: 's',
      createdAtMs: 1,
      expiresAtMs: 2,
      user: { id: 7, username: 'u', email: 'u@x.com' }
    });
    const repo = await loadRepo({
      callAuthSessionCreate: vi.fn(),
      callAuthSessionDelete: vi.fn(),
      callAuthSessionLoad: load
    });
    expect(await repo.findActiveSessionUserId('s')).toBe(7);
    expect(load).toHaveBeenCalledWith({ sessionId: 's' });
    expect(await repo.findSessionUserIdIgnoringExpiry('s')).toBe(7);
    expect(load).toHaveBeenLastCalledWith({ sessionId: 's', includeExpired: true });
  });
});
