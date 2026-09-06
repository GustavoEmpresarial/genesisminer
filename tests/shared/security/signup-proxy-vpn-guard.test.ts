import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSignupProxyVpnGuardEnabled, verifySignupIpNotProxyVpn } from '../../../server/shared/security/signup-proxy-vpn-guard.js';

const originalFetch = global.fetch;

describe('isSignupProxyVpnGuardEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('desligado por padrão', () => {
    expect(isSignupProxyVpnGuardEnabled()).toBe(false);
  });

  it('liga com ENABLED=1 + PROXYCHECK_API_KEY', () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    expect(isSignupProxyVpnGuardEnabled()).toBe(true);
  });
});

describe('verifySignupIpNotProxyVpn', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
  });

  it('desligado: aprova sem chamar fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('IP privado: aprova sem chamar proxycheck (não é IP público)', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const result = await verifySignupIpNotProxyVpn('10.0.0.5');
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bloqueia quando proxycheck acusa VPN', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        '203.0.113.50': { proxy: 'yes', vpn: 'yes', type: 'VPN', risk: 90 }
      })
    }) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNUP_PROXY_VPN_BLOCKED');
  });

  it('aprova quando proxycheck devolve veredito limpo', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        '203.0.113.50': { proxy: 'no', vpn: 'no', type: 'Residential', risk: 0 }
      })
    }) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result).toEqual({ ok: true });
  });

  it('veredito desconhecido (proxycheck não devolveu proxy/vpn/type/risk): bloqueia 503', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ '203.0.113.50': {}, status: 'error' })
    }) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNUP_IP_INTEL_UNAVAILABLE');
  });

  it('veredito desconhecido + ALLOW_ON_ERROR=1: aprova', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR', '1');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ '203.0.113.50': {} })
    }) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result).toEqual({ ok: true });
  });

  it('res.ok=false + ALLOW_ON_ERROR=1: aprova mesmo com HTTP de erro', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR', '1');
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result).toEqual({ ok: true });
  });

  it('erro de rede: SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR=1 aprova mesmo assim', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ALLOW_ON_ERROR', '1');
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result).toEqual({ ok: true });
  });

  it('erro de rede sem ALLOW_ON_ERROR: bloqueia com 503', async () => {
    vi.stubEnv('SIGNUP_ANTI_PROXY_VPN_ENABLED', '1');
    vi.stubEnv('PROXYCHECK_API_KEY', 'key-123');
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as any;
    const result = await verifySignupIpNotProxyVpn('203.0.113.50');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });
});
