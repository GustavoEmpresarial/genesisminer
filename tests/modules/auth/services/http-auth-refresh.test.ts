import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    cookies: [] as string[],
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    append(_name: string, value: string) {
      res.cookies.push(value);
    }
  };
  return res;
}

describe('http-auth issue + refresh (auth worker)', () => {
  let refreshStore: Record<string, ReturnType<typeof vi.fn>>;
  let jwt: Record<string, ReturnType<typeof vi.fn>>;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let mirror: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.resetModules();
    refreshStore = {
      revokeAllRefreshForUser: vi.fn().mockResolvedValue(undefined),
      issueRefreshToken: vi.fn().mockResolvedValue({
        refreshToken: 'raw-refresh',
        expiresAtMs: 50,
        expiresInSec: 1209600
      }),
      rotateRefreshToken: vi.fn()
    };
    jwt = {
      signAccessToken: vi.fn().mockResolvedValue({ token: 'access.jwt', expiresInSec: 900 }),
      verifyAccessToken: vi.fn()
    };
    repo = { findActiveSessionUserId: vi.fn().mockResolvedValue(null) };
    mirror = { writeJwtRefreshSnapshot: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('../../../../server/modules/auth/services/refresh-token-store.js', () => refreshStore);
    vi.doMock('../../../../server/modules/auth/services/jwt-service.js', () => jwt);
    vi.doMock('../../../../server/modules/auth/models/repository.js', () => repo);
    vi.doMock('../../../../server/modules/auth/services/storage-mirror.js', () => mirror);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/auth/services/refresh-token-store.js');
    vi.doUnmock('../../../../server/modules/auth/services/jwt-service.js');
    vi.doUnmock('../../../../server/modules/auth/models/repository.js');
    vi.doUnmock('../../../../server/modules/auth/services/storage-mirror.js');
  });

  it('issueJwtAuthCookies: revoga, emite refresh no worker, seta cookies com TTL do worker', async () => {
    const { issueJwtAuthCookies } = await import('../../../../server/modules/auth/services/http-auth.js');
    const res = fakeRes();
    const req = { headers: { 'user-agent': 'ua' }, ip: '203.0.113.9', socket: {} } as any;
    await issueJwtAuthCookies(res, 4, req);
    expect(refreshStore.revokeAllRefreshForUser).toHaveBeenCalledWith(4);
    expect(refreshStore.issueRefreshToken).toHaveBeenCalledWith({
      userId: 4,
      userAgent: 'ua',
      ip: '203.0.113.9'
    });
    expect(jwt.signAccessToken).toHaveBeenCalledWith(4);
    expect(res.cookies.some((c: string) => c.includes('gm_access=access.jwt') && c.includes('Max-Age=900'))).toBe(
      true
    );
    expect(
      res.cookies.some((c: string) => c.includes('gm_refresh=raw-refresh') && c.includes('Max-Age=1209600'))
    ).toBe(true);
  });

  it('handleJwtRefresh: rotate + novos cookies; 401 limpa cookies', async () => {
    refreshStore.rotateRefreshToken
      .mockResolvedValueOnce({
        ok: true,
        userId: 4,
        newRefreshRaw: 'next-refresh',
        expiresInSec: 1209600
      })
      .mockResolvedValueOnce({ ok: false, code: 'invalid' });
    const { handleJwtRefresh } = await import('../../../../server/modules/auth/services/http-auth.js');
    const parse = () => ({ gm_refresh: 'old-refresh' });
    const okRes = fakeRes();
    await handleJwtRefresh({ headers: {}, ip: '1.1.1.1', socket: {} } as any, okRes, parse as any);
    expect(okRes.body).toEqual({ ok: true });
    expect(okRes.cookies.some((c: string) => c.includes('gm_refresh=next-refresh'))).toBe(true);

    const badRes = fakeRes();
    await handleJwtRefresh({ headers: {}, ip: '1.1.1.1', socket: {} } as any, badRes, parse as any);
    expect(badRes.statusCode).toBe(401);
    expect(badRes.cookies.some((c: string) => c.startsWith('gm_access=;'))).toBe(true);
  });

  it('handleJwtRefresh: worker unset → 503 fail-closed', async () => {
    refreshStore.rotateRefreshToken.mockRejectedValue(new Error('GENESIS_AUTH_URL unset'));
    const { handleJwtRefresh } = await import('../../../../server/modules/auth/services/http-auth.js');
    const res = fakeRes();
    await handleJwtRefresh(
      { headers: {}, ip: '1.1.1.1', socket: {} } as any,
      res,
      (() => ({ gm_refresh: 'old-refresh' })) as any
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('AUTH_WORKER_UNAVAILABLE');
  });

  it('resolveAuth sid: worker unset → 503 fail-closed', async () => {
    repo.findActiveSessionUserId.mockRejectedValue(new Error('GENESIS_AUTH_URL unset'));
    const { createResolveAuthMiddleware } = await import(
      '../../../../server/modules/auth/services/http-auth.js'
    );
    const mw = createResolveAuthMiddleware({ parseCookies: () => ({ sid: 's1' }) });
    const res = fakeRes();
    const next = vi.fn();
    await mw({ headers: {} } as any, res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('AUTH_WORKER_UNAVAILABLE');
    expect(next).not.toHaveBeenCalled();
  });
});
