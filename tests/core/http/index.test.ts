import { describe, expect, it } from 'vitest';

describe('core/http barrel', () => {
  it('re-exporta as funções dos submódulos (cors, csp, rate-limit, client-ip, parse-cookies)', async () => {
    const mod = await import('../../../server/core/http/index.js');
    expect(typeof mod.buildCorsMiddleware).toBe('function');
    expect(typeof mod.buildCorsOriginSet).toBe('function');
    expect(typeof mod.buildSecurityHeadersMiddleware).toBe('function');
    expect(typeof mod.buildCspDirectives).toBe('function');
    expect(typeof mod.buildApiRateLimitMiddleware).toBe('function');
    expect(typeof mod.getClientIpFromRequest).toBe('function');
    expect(typeof mod.normalizeClientIp).toBe('function');
    expect(typeof mod.isUsablePublicClientIp).toBe('function');
    expect(typeof mod.resolveRegistrationIp).toBe('function');
    expect(typeof mod.parseCookies).toBe('function');
  });
});
