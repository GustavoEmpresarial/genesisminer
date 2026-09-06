import { describe, expect, it } from 'vitest';
import { buildApiRateLimitMiddleware, isLoopbackIp, parseRateLimit } from '../../../server/core/http/rate-limit.js';

describe('parseRateLimit', () => {
  it('usa fallback quando não é número', () => {
    expect(parseRateLimit(undefined, 100, 10, 1000)).toBe(100);
    expect(parseRateLimit('abc', 100, 10, 1000)).toBe(100);
  });

  it('faz clamp no mínimo e no máximo', () => {
    expect(parseRateLimit('1', 100, 10, 1000)).toBe(10);
    expect(parseRateLimit('999999', 100, 10, 1000)).toBe(1000);
  });

  it('aceita valor dentro do range', () => {
    expect(parseRateLimit('500', 100, 10, 1000)).toBe(500);
  });
});

describe('isLoopbackIp', () => {
  it('reconhece as três formas de loopback', () => {
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejeita IP público', () => {
    expect(isLoopbackIp('203.0.113.50')).toBe(false);
  });
});

describe('buildApiRateLimitMiddleware', () => {
  it('devolve um middleware Express (função com 3 parâmetros)', () => {
    const mw = buildApiRateLimitMiddleware({} as NodeJS.ProcessEnv);
    expect(typeof mw).toBe('function');
  });

  it('aceita API_RATE_LIMIT_MAX customizado sem lançar', () => {
    expect(() => buildApiRateLimitMiddleware({ API_RATE_LIMIT_MAX: '50000' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('valor fora dos limites [5000, 250000] não quebra a construção (clamp interno)', () => {
    expect(() => buildApiRateLimitMiddleware({ API_RATE_LIMIT_MAX: '999999999' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => buildApiRateLimitMiddleware({ API_RATE_LIMIT_MAX: '1' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
