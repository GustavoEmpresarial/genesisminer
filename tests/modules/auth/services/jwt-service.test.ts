import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('jwt-service (auth worker)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GENESIS_AUTH_URL', 'http://auth.test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../../../server/modules/auth/services/auth-worker-client.js');
  });

  it('assina e verifica um token válido via worker', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: vi.fn().mockResolvedValue({
        ok: true,
        token: 'signed.jwt.token',
        expiresInSec: 900
      }),
      callAuthJwtVerify: vi.fn().mockResolvedValue({
        ok: true,
        userId: 42,
        jti: 'jti-1',
        exp: 1_700_000_000
      })
    }));
    const { signAccessToken, verifyAccessToken } = await import(
      '../../../../server/modules/auth/services/jwt-service.js'
    );
    const signed = await signAccessToken(42);
    expect(signed).toEqual({ token: 'signed.jwt.token', expiresInSec: 900 });
    const verified = await verifyAccessToken(signed.token);
    expect(verified.userId).toBe(42);
    expect(verified.jti).toBe('jti-1');
    expect(verified.exp).toBe(1_700_000_000);
  });

  it('aceita userId como string numérica', async () => {
    const sign = vi.fn().mockResolvedValue({ ok: true, token: 't', expiresInSec: 900 });
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: sign,
      callAuthJwtVerify: vi.fn()
    }));
    const { signAccessToken } = await import('../../../../server/modules/auth/services/jwt-service.js');
    await signAccessToken('7');
    expect(sign).toHaveBeenCalledWith('7');
  });

  it('rejeita userId não numérico ao assinar', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: vi.fn(),
      callAuthJwtVerify: vi.fn()
    }));
    const { signAccessToken } = await import('../../../../server/modules/auth/services/jwt-service.js');
    await expect(signAccessToken('abc')).rejects.toThrow(/inválido/);
  });

  it('propaga errorName do worker na verificação', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: vi.fn(),
      callAuthJwtVerify: vi.fn().mockResolvedValue({
        ok: false,
        error: 'jwt expired',
        errorName: 'TokenExpiredError'
      })
    }));
    const { verifyAccessToken } = await import('../../../../server/modules/auth/services/jwt-service.js');
    await expect(verifyAccessToken('bad')).rejects.toMatchObject({ name: 'TokenExpiredError' });
  });

  it('GENESIS_AUTH_URL unset: callAuthJwtSign falha fechado', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: vi.fn().mockResolvedValue({ ok: false, error: 'GENESIS_AUTH_URL unset' }),
      callAuthJwtVerify: vi.fn()
    }));
    const { signAccessToken } = await import('../../../../server/modules/auth/services/jwt-service.js');
    await expect(signAccessToken(1)).rejects.toThrow(/GENESIS_AUTH_URL unset/);
  });

  it('rejeita sign sem expiresInSec do worker', async () => {
    vi.doMock('../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthJwtSign: vi.fn().mockResolvedValue({ ok: true, token: 't' }),
      callAuthJwtVerify: vi.fn()
    }));
    const { signAccessToken } = await import('../../../../server/modules/auth/services/jwt-service.js');
    await expect(signAccessToken(1)).rejects.toThrow();
  });
});
