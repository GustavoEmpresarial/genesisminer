import { describe, expect, it } from 'vitest';
import { isKnownProxyEdgeIpForSecurity, isUsefulSecurityScanIp } from '../../../../../server/modules/admin/security-stats/services/scan-ip.js';
import { parseBlacklistIp } from '../../../../../server/modules/admin/security-stats/services/security-stats.js';

describe('isUsefulSecurityScanIp', () => {
  it('rejeita privado/loopback', () => {
    expect(isUsefulSecurityScanIp('127.0.0.1')).toBe(false);
    expect(isUsefulSecurityScanIp('10.0.0.1')).toBe(false);
    expect(isUsefulSecurityScanIp('192.168.1.1')).toBe(false);
  });

  it('aceita IPv4 público fora de CF edge', () => {
    expect(isUsefulSecurityScanIp('8.8.8.8')).toBe(true);
  });

  it('rejeita range Cloudflare conhecido', () => {
    expect(isKnownProxyEdgeIpForSecurity('104.16.1.1')).toBe(true);
    expect(isUsefulSecurityScanIp('104.16.1.1')).toBe(false);
  });
});

describe('parseBlacklistIp', () => {
  it('vazio: 400 IP requerido', () => {
    try {
      parseBlacklistIp('');
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.jsonBody).toEqual({ error: 'IP requerido' });
    }
  });

  it('trim e aceita IPv4', () => {
    expect(parseBlacklistIp('  203.0.113.10  ')).toBe('203.0.113.10');
  });
});
