import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJwtAuthConfig, COOKIE_ACCESS, COOKIE_REFRESH } from '../../../../server/modules/auth/services/config.js';

describe('getJwtAuthConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('em dev sem JWT_SECRET, usa fallback e não lança', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('JWT_SECRET', '');
    const cfg = getJwtAuthConfig();
    expect(cfg.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('em produção sem JWT_SECRET (ou curto), lança', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'curto');
    expect(() => getJwtAuthConfig()).toThrow(/JWT_SECRET/);
  });

  it('em produção com JWT_SECRET válido, usa o valor do env', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const secret = 'a'.repeat(32);
    vi.stubEnv('JWT_SECRET', secret);
    expect(getJwtAuthConfig().secret).toBe(secret);
  });

  it('accessTtlSec tem piso de 60s e teto de 3600s', () => {
    vi.stubEnv('JWT_ACCESS_TTL_SEC', '1');
    expect(getJwtAuthConfig().accessTtlSec).toBe(60);
    vi.stubEnv('JWT_ACCESS_TTL_SEC', '999999');
    expect(getJwtAuthConfig().accessTtlSec).toBe(3600);
  });

  it('accessTtlSec default é 900 (15min) sem env', () => {
    vi.stubEnv('JWT_ACCESS_TTL_SEC', '');
    expect(getJwtAuthConfig().accessTtlSec).toBe(900);
  });

  it('refreshTtlSec default é 14 dias, piso 1h, teto 60 dias', () => {
    vi.stubEnv('JWT_REFRESH_TTL_SEC', '');
    expect(getJwtAuthConfig().refreshTtlSec).toBe(14 * 24 * 60 * 60);
    vi.stubEnv('JWT_REFRESH_TTL_SEC', '1');
    expect(getJwtAuthConfig().refreshTtlSec).toBe(3600);
    vi.stubEnv('JWT_REFRESH_TTL_SEC', String(999 * 24 * 60 * 60));
    expect(getJwtAuthConfig().refreshTtlSec).toBe(60 * 24 * 60 * 60);
  });

  it('issuer/audience usam default quando env ausente', () => {
    vi.stubEnv('JWT_ISSUER', '');
    vi.stubEnv('JWT_AUDIENCE', '');
    const cfg = getJwtAuthConfig();
    expect(cfg.issuer).toBe('genesis-miner');
    expect(cfg.audience).toBe('genesis-miner-api');
  });

  it('nomes de cookie são fixos e distintos', () => {
    expect(COOKIE_ACCESS).toBe('gm_access');
    expect(COOKIE_REFRESH).toBe('gm_refresh');
    expect(COOKIE_ACCESS).not.toBe(COOKIE_REFRESH);
  });
});
