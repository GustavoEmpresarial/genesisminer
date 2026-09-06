import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('auth-worker-client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('authWorkerBaseUrl null quando unset', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { authWorkerBaseUrl } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    expect(authWorkerBaseUrl()).toBeNull();
  });

  it('callAuthPasswordHash unset URL → GENESIS_AUTH_URL unset', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthPasswordHash } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    const r = await callAuthPasswordHash('x', 12);
    expect(r).toEqual({ ok: false, error: 'GENESIS_AUTH_URL unset' });
  });

  it('authWorkerBcrypt.hash unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { authWorkerBcrypt } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(authWorkerBcrypt.hash('x', 12)).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('round-trip mocks hash + verify', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', 'http://auth.test');
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith('/v1/auth/password/hash')) {
        return new Response(JSON.stringify({ ok: true, hash: `$2b$12$mock-${body.rounds}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/password/verify')) {
        return new Response(JSON.stringify({ ok: true, match: body.password === 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/jwt/sign')) {
        return new Response(
          JSON.stringify({ ok: true, token: `tok-${body.userId}`, expiresInSec: 900 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (u.endsWith('/v1/auth/jwt/verify')) {
        return new Response(JSON.stringify({ ok: true, userId: 9, jti: 'j', exp: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const {
      callAuthPasswordHash,
      callAuthPasswordVerify,
      callAuthJwtSign,
      callAuthJwtVerify,
      BCRYPT_ROUNDS_REGISTER
    } = await import('../../../../server/modules/auth/services/auth-worker-client.js');

    const h = await callAuthPasswordHash('secret', BCRYPT_ROUNDS_REGISTER);
    expect(h).toEqual({ ok: true, hash: `$2b$12$mock-${BCRYPT_ROUNDS_REGISTER}` });

    const v = await callAuthPasswordVerify('ok', h.hash!);
    expect(v).toEqual({ ok: true, match: true });

    const signed = await callAuthJwtSign(9);
    expect(signed).toEqual({ ok: true, token: 'tok-9', expiresInSec: 900 });

    const verified = await callAuthJwtVerify(signed.token!);
    expect(verified).toEqual({ ok: true, userId: 9, jti: 'j', exp: 100 });
  });

  it('classifyAuthWorkerError: unset → 503, transport → 502', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', 'http://auth.test');
    const {
      classifyAuthWorkerError,
      authWorkerInfraHttpStatus
    } = await import('../../../../server/modules/auth/services/auth-worker-client.js');
    expect(authWorkerInfraHttpStatus(classifyAuthWorkerError('GENESIS_AUTH_URL unset')!)).toBe(503);
    expect(
      authWorkerInfraHttpStatus(classifyAuthWorkerError('auth worker unreachable: abort')!)
    ).toBe(502);
  });

  it('callAuthTurnstileVerify unset URL → 503', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthTurnstileVerify } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    const r = await callAuthTurnstileVerify({ token: 't' });
    expect(r).toEqual({ ok: false, status: 503, error: 'GENESIS_AUTH_URL unset' });
  });

  it('callAuthMailReset unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthMailReset } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(callAuthMailReset({ email: 'a@b.c', resetToken: 't' })).rejects.toThrow(
      'GENESIS_AUTH_URL unset'
    );
  });

  it('callAuthTurnstileVerify + mail round-trip mocks', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', 'http://auth.test');
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith('/v1/auth/turnstile/verify')) {
        if (!body.token) {
          return new Response(JSON.stringify({ ok: false, error: 'Complete the captcha before continuing.' }), {
            status: 400,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/mail/reset') || u.endsWith('/v1/auth/mail/verify')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const { callAuthTurnstileVerify, callAuthMailReset, callAuthMailVerify } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );

    expect(await callAuthTurnstileVerify({ token: 'ok', remoteip: '1.2.3.4' })).toEqual({ ok: true });
    expect(await callAuthTurnstileVerify({ token: '' })).toEqual({
      ok: false,
      status: 400,
      error: 'Complete the captcha before continuing.'
    });
    expect(await callAuthMailReset({ email: 'a@b.c', resetToken: 'rt', validityMinutes: 60 })).toEqual({
      ok: true
    });
    expect(
      await callAuthMailVerify({ email: 'a@b.c', verificationToken: 'vt', validityHours: 24 })
    ).toEqual({ ok: true });
  });

  it('callAuthSessionLoad unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthSessionLoad } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(callAuthSessionLoad({ sessionId: 's1' })).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('callAuthSessionDeleteByUser unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthSessionDeleteByUser } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(callAuthSessionDeleteByUser({ userId: 1 })).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('callAuthSessionUpdateFlags unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthSessionUpdateFlags } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(
      callAuthSessionUpdateFlags({ sessionId: 's', userId: 1, managerMode: 0, originalUserId: null, actingAsOwnerId: null })
    ).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('callAuthRefreshIssue unset URL → throw', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', '');
    const { callAuthRefreshIssue } = await import(
      '../../../../server/modules/auth/services/auth-worker-client.js'
    );
    await expect(callAuthRefreshIssue({ userId: 1 })).rejects.toThrow('GENESIS_AUTH_URL unset');
  });

  it('session + refresh round-trip mocks', async () => {
    vi.stubEnv('GENESIS_AUTH_URL', 'http://auth.test');
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith('/v1/auth/session/create')) {
        return new Response(JSON.stringify({ ok: true, userId: body.userId }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/session/load')) {
        if (body.sessionId === 'missing') {
          return new Response(JSON.stringify({ ok: false, error: 'session not found' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            userId: 9,
            sessionId: body.sessionId,
            createdAtMs: 10,
            expiresAtMs: 99,
            managerMode: 0,
            user: { id: 9, username: 'ops', email: 'ops@x.com' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.endsWith('/v1/auth/session/delete')) {
        return new Response(JSON.stringify({ ok: true, userId: 9 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/session/delete-by-user')) {
        return new Response(JSON.stringify({ ok: true, deletedCount: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (u.endsWith('/v1/auth/session/update-flags')) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: body.sessionId,
            userId: body.userId,
            originalUserId: body.originalUserId ?? null,
            managerMode: body.managerMode,
            actingAsOwnerId: body.actingAsOwnerId ?? null
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.endsWith('/v1/auth/refresh/issue')) {
        return new Response(
          JSON.stringify({
            ok: true,
            refreshToken: 'raw-refresh',
            expiresAtMs: 50,
            expiresInSec: 1209600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.endsWith('/v1/auth/refresh/rotate')) {
        if (body.refreshToken === 'bad') {
          return new Response(JSON.stringify({ ok: false, code: 'invalid' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            userId: 9,
            refreshToken: 'raw-rotated',
            expiresInSec: 1209600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.endsWith('/v1/auth/refresh/revoke')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const {
      callAuthSessionCreate,
      callAuthSessionLoad,
      callAuthSessionDelete,
      callAuthSessionDeleteByUser,
      callAuthSessionUpdateFlags,
      callAuthRefreshIssue,
      callAuthRefreshRotate,
      callAuthRefreshRevoke
    } = await import('../../../../server/modules/auth/services/auth-worker-client.js');

    expect(await callAuthSessionCreate({ userId: 9, sessionId: 's1', expiresAtMs: 99 })).toEqual({
      ok: true,
      userId: 9
    });
    const loaded = await callAuthSessionLoad({ sessionId: 's1' });
    expect(loaded).toMatchObject({ ok: true, userId: 9, user: { username: 'ops' } });
    expect(await callAuthSessionLoad({ sessionId: 'missing' })).toMatchObject({
      ok: false,
      status: 401
    });
    expect(await callAuthSessionDelete({ sessionId: 's1' })).toEqual({ ok: true, userId: 9 });
    expect(await callAuthSessionDeleteByUser({ userIds: [1, 2] })).toEqual({ ok: true, deletedCount: 2 });
    expect(
      await callAuthSessionUpdateFlags({
        sessionId: 's1',
        userId: 9,
        originalUserId: 1,
        managerMode: 0,
        actingAsOwnerId: null
      })
    ).toMatchObject({ ok: true, sessionId: 's1', userId: 9, originalUserId: 1, managerMode: 0 });
    expect(await callAuthRefreshIssue({ userId: 9 })).toEqual({
      ok: true,
      refreshToken: 'raw-refresh',
      expiresAtMs: 50,
      expiresInSec: 1209600
    });
    expect(await callAuthRefreshRotate({ refreshToken: 'ok' })).toEqual({
      ok: true,
      userId: 9,
      refreshToken: 'raw-rotated',
      expiresInSec: 1209600
    });
    expect(await callAuthRefreshRotate({ refreshToken: 'bad' })).toEqual({
      ok: false,
      code: 'invalid'
    });
    expect(await callAuthRefreshRevoke({ userId: 9 })).toEqual({ ok: true });
  });
});
