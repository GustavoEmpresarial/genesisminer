import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendAccessCookie,
  appendRefreshCookie,
  buildClearCookieHeader,
  buildClearLegacySessionCookieHeader,
  buildLegacySessionCookieHeader,
  buildSetCookieHeader,
  clearAuthCookies,
  resolveCookieDomainAttribute
} from '../../../../server/modules/auth/services/cookies.js';

function fakeRes(): Response & { appended: string[] } {
  const appended: string[] = [];
  return {
    append: (_name: string, value: string) => {
      appended.push(value);
    },
    appended
  } as unknown as Response & { appended: string[] };
}

describe('resolveCookieDomainAttribute', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('usa COOKIE_DOMAIN quando definido', () => {
    vi.stubEnv('COOKIE_DOMAIN', 'genesisdao.tech');
    expect(resolveCookieDomainAttribute()).toBe('Domain=.genesisdao.tech');
  });

  it('deriva de FRONTEND_URL em produção', () => {
    vi.stubEnv('FRONTEND_URL', 'https://genesisdao.tech');
    expect(resolveCookieDomainAttribute()).toBe('Domain=.genesisdao.tech');
  });

  it('sem host configurado fica host-only', () => {
    vi.stubEnv('COOKIE_DOMAIN', '');
    vi.stubEnv('FRONTEND_URL', '');
    vi.stubEnv('PUBLIC_URL', '');
    vi.stubEnv('SITE_URL', '');
    expect(resolveCookieDomainAttribute()).toBe('');
  });

  it('localhost fica host-only', () => {
    vi.stubEnv('COOKIE_DOMAIN', '');
    vi.stubEnv('FRONTEND_URL', 'http://localhost:5173');
    expect(resolveCookieDomainAttribute()).toBe('');
  });
});

describe('cookies com Domain não geram atributo vazio', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('não emite ";;" quando Domain está presente', () => {
    vi.stubEnv('COOKIE_DOMAIN', 'genesisdao.tech');
    for (const header of [
      buildSetCookieHeader('gm_access', 'tok', { maxAgeSec: 60 }),
      buildClearCookieHeader('gm_access'),
      buildLegacySessionCookieHeader('abc', 60),
      buildClearLegacySessionCookieHeader()
    ]) {
      expect(header).toContain('Domain=.genesisdao.tech');
      expect(header).not.toMatch(/;\s*;/);
    }
  });
});

describe('buildSetCookieHeader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('inclui HttpOnly, SameSite=Strict, Path e Max-Age', () => {
    const h = buildSetCookieHeader('foo', 'bar', { maxAgeSec: 100, path: '/x' });
    expect(h).toContain('foo=bar');
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Strict');
    expect(h).toContain('Path=/x');
    expect(h).toContain('Max-Age=100');
  });

  it('sem maxAgeSec, não inclui Max-Age (cookie de sessão)', () => {
    const h = buildSetCookieHeader('foo', 'bar', {});
    expect(h).not.toContain('Max-Age');
    expect(h).toContain('Path=/');
  });

  it('em produção adiciona Secure; em dev não', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(buildSetCookieHeader('a', 'b', {})).toContain('Secure');
    vi.stubEnv('NODE_ENV', 'development');
    expect(buildSetCookieHeader('a', 'b', {})).not.toContain('Secure');
  });
});

describe('buildClearCookieHeader', () => {
  it('zera o valor e usa Max-Age=0', () => {
    const h = buildClearCookieHeader('foo');
    expect(h).toContain('foo=;');
    expect(h).toContain('Max-Age=0');
  });
});

describe('appendAccessCookie / appendRefreshCookie / clearAuthCookies', () => {
  it('appendAccessCookie usa o nome de cookie gm_access', () => {
    const res = fakeRes();
    appendAccessCookie(res, 'tok', 60);
    expect(res.appended[0]).toContain('gm_access=tok');
  });

  it('appendRefreshCookie usa o nome de cookie gm_refresh', () => {
    const res = fakeRes();
    appendRefreshCookie(res, 'tok', 60);
    expect(res.appended[0]).toContain('gm_refresh=tok');
  });

  it('clearAuthCookies limpa os dois cookies', () => {
    const res = fakeRes();
    clearAuthCookies(res);
    expect(res.appended).toHaveLength(2);
    expect(res.appended[0]).toContain('gm_access=;');
    expect(res.appended[1]).toContain('gm_refresh=;');
  });
});
