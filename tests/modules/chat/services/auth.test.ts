import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('chat services/auth', () => {
  let jwtMock: Record<string, any>;
  let configMock: Record<string, any>;
  let repoMock: Record<string, any>;
  let managerMock: Record<string, any>;
  let dbMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    jwtMock = { verifyAccessToken: vi.fn() };
    configMock = { COOKIE_ACCESS: 'gm_access' };
    repoMock = { loadSessionUser: vi.fn().mockResolvedValue(null) };
    managerMock = { loadSessionManagerFlags: vi.fn().mockResolvedValue({ managerMode: false, managerUserId: null, actingAsOwnerId: null }) };
    dbMock = { default: {} };
    vi.doMock('../../../../server/modules/auth/services/jwt-service.js', () => jwtMock);
    vi.doMock('../../../../server/modules/auth/services/config.js', () => configMock);
    vi.doMock('../../../../server/modules/auth/models/repository.js', () => repoMock);
    vi.doMock('../../../../server/modules/gerente/services/manager.js', () => managerMock);
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../../../server/modules/auth/services/jwt-service.js');
    vi.doUnmock('../../../../server/modules/auth/services/config.js');
    vi.doUnmock('../../../../server/modules/auth/models/repository.js');
    vi.doUnmock('../../../../server/modules/gerente/services/manager.js');
    vi.doUnmock('../../../../server/core/database/pool.js');
  });

  it('sem cookies: devolve null', async () => {
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    expect(await resolveChatActorFromCookieHeader(undefined)).toBeNull();
  });

  it('access token válido resolve sessionUserId=realUserId sem manager_mode', async () => {
    jwtMock.verifyAccessToken.mockReturnValue({ userId: 7 });
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    const actor = await resolveChatActorFromCookieHeader('gm_access=validtoken; sid=s1');
    expect(actor).toMatchObject({ sessionUserId: 7, realUserId: 7, managerMode: false });
  });

  it('access token inválido: devolve null (sem fallback sid por default)', async () => {
    jwtMock.verifyAccessToken.mockImplementation(() => {
      throw new Error('bad token');
    });
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    expect(await resolveChatActorFromCookieHeader('gm_access=bad')).toBeNull();
  });

  it('manager_mode ativo: realUserId vira o managerUserId', async () => {
    jwtMock.verifyAccessToken.mockReturnValue({ userId: 7 });
    managerMock.loadSessionManagerFlags.mockResolvedValue({ managerMode: true, managerUserId: 42, actingAsOwnerId: 7 });
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    const actor = await resolveChatActorFromCookieHeader('gm_access=validtoken; sid=s1');
    expect(actor).toMatchObject({ sessionUserId: 7, realUserId: 42, managerMode: true, managerUserId: 42 });
  });

  it('resolveUserIdFromCookieHeader devolve só o sessionUserId', async () => {
    jwtMock.verifyAccessToken.mockReturnValue({ userId: 7 });
    const { resolveUserIdFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    expect(await resolveUserIdFromCookieHeader('gm_access=validtoken')).toBe(7);
  });

  it('resolveChatActorFromHandshakeLike lê de headers.cookie ou request.headers.cookie', async () => {
    jwtMock.verifyAccessToken.mockReturnValue({ userId: 7 });
    const { resolveChatActorFromHandshakeLike } = await import('../../../../server/modules/chat/services/auth.js');
    const actor = await resolveChatActorFromHandshakeLike({ headers: { cookie: 'gm_access=validtoken' } });
    expect(actor?.sessionUserId).toBe(7);
  });

  it('legacy sid: loadSessionUser via worker resolve sessionUserId', async () => {
    vi.stubEnv('JWT_ALLOW_LEGACY_SESSION', '1');
    vi.stubEnv('JWT_ALLOW_LEGACY_SID', '1');
    jwtMock.verifyAccessToken.mockImplementation(() => {
      throw new Error('bad token');
    });
    repoMock.loadSessionUser.mockResolvedValue({ user: { id: 11 }, session: {} });
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    const actor = await resolveChatActorFromCookieHeader('sid=legacy-sid');
    expect(repoMock.loadSessionUser).toHaveBeenCalledWith('legacy-sid');
    expect(actor).toMatchObject({ sessionUserId: 11, realUserId: 11 });
  });

  it('legacy sid: worker unset lança (fail-closed)', async () => {
    vi.stubEnv('JWT_ALLOW_LEGACY_SESSION', '1');
    vi.stubEnv('JWT_ALLOW_LEGACY_SID', '1');
    jwtMock.verifyAccessToken.mockImplementation(() => {
      throw new Error('bad token');
    });
    repoMock.loadSessionUser.mockRejectedValue(new Error('GENESIS_AUTH_URL unset'));
    const { resolveChatActorFromCookieHeader } = await import('../../../../server/modules/chat/services/auth.js');
    await expect(resolveChatActorFromCookieHeader('sid=legacy-sid')).rejects.toThrow(
      'GENESIS_AUTH_URL unset'
    );
  });
});
