import { describe, expect, it } from 'vitest';
import { validatePasswordStrengthPolicy } from '../../../../server/modules/auth/services/password-policy.js';

describe('validatePasswordStrengthPolicy', () => {
  it('rejeita menor que 6 chars', () => {
    expect(validatePasswordStrengthPolicy('a1b2c').ok).toBe(false);
  });

  it('rejeita maior que 50 chars', () => {
    expect(validatePasswordStrengthPolicy('a'.repeat(51)).ok).toBe(false);
  });

  it('rejeita senha comum (case-insensitive)', () => {
    expect(validatePasswordStrengthPolicy('Password').ok).toBe(false);
    expect(validatePasswordStrengthPolicy('GENESISMINER').ok).toBe(false);
  });

  it('aceita senha razoável', () => {
    expect(validatePasswordStrengthPolicy('minhaSenhaForte99')).toEqual({ ok: true });
  });
});
