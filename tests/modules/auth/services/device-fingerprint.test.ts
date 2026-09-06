import { describe, expect, it } from 'vitest';
import { sanitizeDeviceFingerprint } from '../../../../server/modules/auth/services/device-fingerprint.js';

describe('sanitizeDeviceFingerprint', () => {
  it('devolve null pra entrada inválida', () => {
    expect(sanitizeDeviceFingerprint(null)).toBeNull();
    expect(sanitizeDeviceFingerprint('string')).toBeNull();
    expect(sanitizeDeviceFingerprint([])).toBeNull();
    expect(sanitizeDeviceFingerprint({})).toBeNull();
  });

  it('aceita visitorId em formato hex válido', () => {
    const id = 'a'.repeat(32);
    const result = sanitizeDeviceFingerprint({ visitorId: id });
    expect(result).not.toBeNull();
    expect(result!.payloadJson).toContain(id);
  });

  it('ignora visitorId em formato inválido', () => {
    const result = sanitizeDeviceFingerprint({ visitorId: 'not-hex!!' });
    expect(result).toBeNull();
  });

  it('filtra components pra só chaves da allowlist', () => {
    const result = sanitizeDeviceFingerprint({
      components: { userAgent: 'Mozilla/5.0', maliciousKey: 'x', platform: 'Linux' }
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.payloadJson);
    expect(parsed).toHaveProperty('userAgent');
    expect(parsed).toHaveProperty('platform');
    expect(parsed).not.toHaveProperty('maliciousKey');
  });

  it('devolve hash SHA-256 consistente pro mesmo payload', () => {
    const a = sanitizeDeviceFingerprint({ components: { platform: 'Linux' } });
    const b = sanitizeDeviceFingerprint({ components: { platform: 'Linux' } });
    expect(a!.fingerprintHash).toBe(b!.fingerprintHash);
    expect(a!.fingerprintHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('descarta string de component acima do limite de tamanho', () => {
    const result = sanitizeDeviceFingerprint({ components: { userAgent: 'x'.repeat(700) } });
    expect(result).toBeNull();
  });
});
