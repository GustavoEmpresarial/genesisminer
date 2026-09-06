import { describe, expect, it } from 'vitest';
import { stableIntentFingerprint } from '../../../server/shared/security/stable-fingerprint.js';

describe('shared/security/stable-fingerprint', () => {
  it('devolve uma string hex de 32 caracteres', () => {
    const fp = stableIntentFingerprint({ op: 'x' });
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('é determinístico para o mesmo input', () => {
    const a = stableIntentFingerprint({ op: 'shop_checkout', 'line:gpu_1': 2 });
    const b = stableIntentFingerprint({ op: 'shop_checkout', 'line:gpu_1': 2 });
    expect(a).toBe(b);
  });

  it('é insensível à ordem das chaves (ordena antes de hashear)', () => {
    const a = stableIntentFingerprint({ b: 2, a: 1 });
    const b = stableIntentFingerprint({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('inputs diferentes produzem fingerprints diferentes', () => {
    const a = stableIntentFingerprint({ op: 'x', qty: 1 });
    const b = stableIntentFingerprint({ op: 'x', qty: 2 });
    expect(a).not.toBe(b);
  });

  it('objeto vazio não lança e produz um hash estável', () => {
    expect(stableIntentFingerprint({})).toMatch(/^[0-9a-f]{32}$/);
  });
});
