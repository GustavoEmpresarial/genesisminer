import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getClientIpFromRequest,
  isUsablePublicClientIp,
  normalizeClientIp,
  resolveRegistrationIp
} from '../../../server/core/http/client-ip.js';

describe('normalizeClientIp', () => {
  it('remove prefixo IPv6 mapeado', () => {
    expect(normalizeClientIp('::ffff:203.0.113.50')).toBe('203.0.113.50');
  });

  it('usa primeiro hop de XFF', () => {
    expect(normalizeClientIp(' 203.0.113.1, 10.0.0.1 ')).toBe('203.0.113.1');
  });

  it('devolve null para valor vazio/nulo', () => {
    expect(normalizeClientIp(null)).toBeNull();
    expect(normalizeClientIp('   ')).toBeNull();
  });
});

describe('isUsablePublicClientIp', () => {
  it('rejeita privados e loopback', () => {
    expect(isUsablePublicClientIp('127.0.0.1')).toBe(false);
    expect(isUsablePublicClientIp('10.0.0.5')).toBe(false);
    expect(isUsablePublicClientIp('172.16.0.1')).toBe(false);
    expect(isUsablePublicClientIp('192.168.1.1')).toBe(false);
    expect(isUsablePublicClientIp('169.254.0.1')).toBe(false);
    expect(isUsablePublicClientIp('unknown')).toBe(false);
    expect(isUsablePublicClientIp('::1')).toBe(false);
    expect(isUsablePublicClientIp('fe80::1')).toBe(false);
    expect(isUsablePublicClientIp('fd00::1')).toBe(false);
  });

  it('aceita IP público v4 e v6', () => {
    expect(isUsablePublicClientIp('203.0.113.50')).toBe(true);
    expect(isUsablePublicClientIp('2001:4860:4860::8888')).toBe(true);
  });
});

describe('resolveRegistrationIp', () => {
  it('devolve null para IP interno (não conta no limite)', () => {
    expect(resolveRegistrationIp('10.0.0.1')).toBeNull();
  });

  it('normaliza IP público', () => {
    expect(resolveRegistrationIp('::ffff:203.0.113.50')).toBe('203.0.113.50');
  });
});

describe('getClientIpFromRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignora cf-connecting-ip por padrão (TRUST_CF_CONNECTING_IP não setado)', () => {
    const ip = getClientIpFromRequest({
      ip: '198.51.100.1',
      headers: { 'cf-connecting-ip': '203.0.113.77' },
      socket: { remoteAddress: '127.0.0.1' }
    });
    expect(ip).toBe('198.51.100.1');
  });

  it('usa cf-connecting-ip só com TRUST_CF_CONNECTING_IP=1 explícito', () => {
    vi.stubEnv('TRUST_CF_CONNECTING_IP', '1');
    const ip = getClientIpFromRequest({
      ip: '198.51.100.1',
      headers: { 'cf-connecting-ip': '203.0.113.77' },
      socket: { remoteAddress: '127.0.0.1' }
    });
    expect(ip).toBe('203.0.113.77');
  });

  it('usa primeiro IP público em XFF quando req.ip é privado', () => {
    const ip = getClientIpFromRequest({
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.88, 10.0.0.1' },
      socket: { remoteAddress: '10.0.0.1' }
    });
    expect(ip).toBe('203.0.113.88');
  });

  it('devolve "unknown" quando não há candidato válido', () => {
    const ip = getClientIpFromRequest({
      headers: {},
      socket: {}
    });
    expect(ip).toBe('unknown');
  });
});
