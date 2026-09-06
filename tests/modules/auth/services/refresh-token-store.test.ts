import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('refresh-token-store (auth worker)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/modules/auth/services/auth-worker-client.js');
  });

  it('issueRefreshToken devolve payload do worker', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthRefreshIssue: vi.fn().mockResolvedValue({
        ok: true,
        refreshToken: 'raw',
        expiresAtMs: 50,
        expiresInSec: 1209600
      }),
      callAuthRefreshRevoke: vi.fn(),
      callAuthRefreshRotate: vi.fn()
    }));
    const { issueRefreshToken } = await import(
      '../../../../server/modules/auth/services/refresh-token-store.js'
    );
    await expect(
      issueRefreshToken({ userId: 3, userAgent: null, ip: null })
    ).resolves.toEqual({
      refreshToken: 'raw',
      expiresAtMs: 50,
      expiresInSec: 1209600
    });
  });

  it('issueRefreshToken unset URL → throw', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthRefreshIssue: vi.fn().mockRejectedValue(new Error('GENESIS_AUTH_URL unset')),
      callAuthRefreshRevoke: vi.fn(),
      callAuthRefreshRotate: vi.fn()
    }));
    const { issueRefreshToken } = await import(
      '../../../../server/modules/auth/services/refresh-token-store.js'
    );
    await expect(issueRefreshToken({ userId: 1, userAgent: null, ip: null })).rejects.toThrow(
      'GENESIS_AUTH_URL unset'
    );
  });

  it('rotateRefreshToken mapeia 401 invalid/expired e sucesso', async () => {
    const rotate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'expired' })
      .mockResolvedValueOnce({
        ok: true,
        userId: 8,
        refreshToken: 'next',
        expiresInSec: 1209600
      });
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthRefreshIssue: vi.fn(),
      callAuthRefreshRevoke: vi.fn(),
      callAuthRefreshRotate: rotate
    }));
    const { rotateRefreshToken } = await import(
      '../../../../server/modules/auth/services/refresh-token-store.js'
    );
    expect(await rotateRefreshToken('old', { userAgent: null, ip: null })).toEqual({
      ok: false,
      code: 'expired'
    });
    expect(await rotateRefreshToken('old', { userAgent: null, ip: null })).toEqual({
      ok: true,
      userId: 8,
      newRefreshRaw: 'next',
      expiresInSec: 1209600
    });
  });

  it('revokeAllRefreshForUser falha fechado', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthRefreshIssue: vi.fn(),
      callAuthRefreshRevoke: vi.fn().mockResolvedValue({ ok: false, error: 'auth worker HTTP 500' }),
      callAuthRefreshRotate: vi.fn()
    }));
    const { revokeAllRefreshForUser } = await import(
      '../../../../server/modules/auth/services/refresh-token-store.js'
    );
    await expect(revokeAllRefreshForUser(2)).rejects.toThrow('auth worker HTTP 500');
  });
});
