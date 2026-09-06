import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthFlowTokenSecret } from '../../../server/shared/security/auth-flow-secret.js';

describe('getAuthFlowTokenSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lança se AUTH_FLOW_TOKEN_SECRET e JWT_SECRET ausentes', () => {
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
    expect(() => getAuthFlowTokenSecret()).toThrow(/SECURITY/);
  });

  it('lança se o secret é curto demais (<16 chars)', () => {
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', 'curto');
    expect(() => getAuthFlowTokenSecret()).toThrow();
  });

  it('aceita AUTH_FLOW_TOKEN_SECRET válido', () => {
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', 'a'.repeat(32));
    expect(getAuthFlowTokenSecret()).toBe('a'.repeat(32));
  });

  it('cai no fallback JWT_SECRET quando AUTH_FLOW_TOKEN_SECRET ausente', () => {
    vi.stubEnv('AUTH_FLOW_TOKEN_SECRET', '');
    vi.stubEnv('JWT_SECRET', 'b'.repeat(32));
    expect(getAuthFlowTokenSecret()).toBe('b'.repeat(32));
  });
});
