import { describe, expect, it } from 'vitest';
import { normalizePromoCode, parseIdempotencyKey, parseWonItemId, sanitizeDisplayName } from '../../../../server/modules/wheel/services/validation.js';

describe('wheel services/validation', () => {
  describe('normalizePromoCode', () => {
    it('normaliza para maiúsculas e remove espaços', () => {
      expect(normalizePromoCode('  abc123  ')).toBe('ABC123');
    });

    it('rejeita vazio, não-string, muito longo ou com bytes de controlo', () => {
      expect(normalizePromoCode('')).toBeNull();
      expect(normalizePromoCode(null)).toBeNull();
      expect(normalizePromoCode(123)).toBeNull();
      expect(normalizePromoCode('a'.repeat(121))).toBeNull();
      expect(normalizePromoCode('ab\x01c')).toBeNull();
    });
  });

  describe('parseIdempotencyKey', () => {
    it('aceita 8-128 chars seguros', () => {
      expect(parseIdempotencyKey('key-123456')).toBe('key-123456');
    });

    it('rejeita curto demais, longo demais ou com caracteres inválidos', () => {
      expect(parseIdempotencyKey('short')).toBeNull();
      expect(parseIdempotencyKey('a'.repeat(129))).toBeNull();
      expect(parseIdempotencyKey('has space here!!')).toBeNull();
    });
  });

  describe('parseWonItemId', () => {
    it('aceita ids seguros', () => {
      expect(parseWonItemId('upg_123-abc.def')).toBe('upg_123-abc.def');
    });

    it('rejeita vazio ou com caracteres inseguros', () => {
      expect(parseWonItemId('')).toBeNull();
      expect(parseWonItemId('has space')).toBeNull();
      expect(parseWonItemId(42)).toBeNull();
    });
  });

  describe('sanitizeDisplayName', () => {
    it('remove control chars e < > e trunca', () => {
      expect(sanitizeDisplayName('<script>ok\x01</script>', 6)).toBe('script');
    });

    it('cai no fallback "Prêmio" quando vazio após sanitização', () => {
      expect(sanitizeDisplayName('   ', 10)).toBe('Prêmio');
      expect(sanitizeDisplayName('<>', 10)).toBe('Prêmio');
    });
  });
});
