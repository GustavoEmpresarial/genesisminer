import { describe, expect, it } from 'vitest';
import { buildCspDirectives, buildSecurityHeadersMiddleware } from '../../../server/core/http/csp.js';

describe('buildCspDirectives', () => {
  it('nunca inclui blockminer.space — guarda de regressão (ver DECISIONS.md item 3)', () => {
    const directives = buildCspDirectives({} as NodeJS.ProcessEnv);
    const flat = JSON.stringify(directives);
    expect(flat).not.toContain('blockminer.space');
  });

  it('frame-src só tem os domínios esperados por este produto', () => {
    const directives = buildCspDirectives({} as NodeJS.ProcessEnv);
    expect(directives['frame-src']).toEqual([
      "'self'",
      'https://cdn.applixir.com',
      'https://challenges.cloudflare.com',
      'https://zerads.com'
    ]);
  });

  it('script-src só ganha unsafe-eval com CSP_ALLOW_UNSAFE_EVAL=1', () => {
    expect(buildCspDirectives({} as NodeJS.ProcessEnv)['script-src']).not.toContain("'unsafe-eval'");
    expect(buildCspDirectives({ CSP_ALLOW_UNSAFE_EVAL: '1' } as NodeJS.ProcessEnv)['script-src']).toContain(
      "'unsafe-eval'"
    );
  });

  it('style-src permite unsafe-inline por padrão (opt-out via CSP_ALLOW_UNSAFE_INLINE_STYLES=0)', () => {
    expect(buildCspDirectives({} as NodeJS.ProcessEnv)['style-src']).toContain("'unsafe-inline'");
    expect(
      buildCspDirectives({ CSP_ALLOW_UNSAFE_INLINE_STYLES: '0' } as NodeJS.ProcessEnv)['style-src']
    ).not.toContain("'unsafe-inline'");
  });

  it('upgrade-insecure-requests só em produção', () => {
    expect(buildCspDirectives({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)['upgrade-insecure-requests']).toBeUndefined();
    expect(buildCspDirectives({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)['upgrade-insecure-requests']).toBeDefined();
  });
});

describe('buildSecurityHeadersMiddleware', () => {
  it('devolve um middleware Express', () => {
    const mw = buildSecurityHeadersMiddleware({} as NodeJS.ProcessEnv);
    expect(typeof mw).toBe('function');
  });
});
