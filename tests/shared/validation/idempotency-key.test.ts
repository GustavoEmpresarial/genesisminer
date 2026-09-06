import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  parseIdempotencyKey
} from '../../../server/shared/validation/idempotency-key.js';

describe('shared/validation/idempotency-key', () => {
  it('aceita chave válida (8-128 chars, alfanumérico + . _ : -)', () => {
    expect(parseIdempotencyKey('idem-key-12345678')).toBe('idem-key-12345678');
  });

  it('remove espaços nas pontas antes de validar', () => {
    expect(parseIdempotencyKey('  idem-key-12345678  ')).toBe('idem-key-12345678');
  });

  it('rejeita não-string', () => {
    expect(parseIdempotencyKey(null)).toBeNull();
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey(123)).toBeNull();
    expect(parseIdempotencyKey({})).toBeNull();
  });

  it('rejeita string curta demais (< 8 chars)', () => {
    expect(parseIdempotencyKey('short')).toBeNull();
  });

  it('rejeita string longa demais (> 128 chars)', () => {
    expect(parseIdempotencyKey('a'.repeat(129))).toBeNull();
  });

  it('aceita exatamente no limite mínimo e máximo', () => {
    expect(parseIdempotencyKey('a'.repeat(8))).toBe('a'.repeat(8));
    expect(parseIdempotencyKey('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('rejeita caracteres fora do allowlist', () => {
    expect(parseIdempotencyKey('idem key 12345')).toBeNull();
    expect(parseIdempotencyKey('idem/key/12345678')).toBeNull();
    expect(parseIdempotencyKey('idem@key#12345678')).toBeNull();
  });

  it('aceita caracteres especiais permitidos (. _ : -)', () => {
    expect(parseIdempotencyKey('a.b_c:d-12345678')).toBe('a.b_c:d-12345678');
  });

  it('respeita os limites nomeados exportados (min - 1 rejeita, min aceita)', () => {
    expect(parseIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1))).toBeNull();
    expect(parseIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH))).toBe('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH));
  });

  it('respeita os limites nomeados exportados (max aceita, max + 1 rejeita)', () => {
    expect(parseIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toBe('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH));
    expect(parseIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toBeNull();
  });
});
