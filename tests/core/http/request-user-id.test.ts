import { describe, expect, it } from 'vitest';
import { resolveRequestUserId } from '../../../server/core/http/request-user-id.js';

describe('core/http/request-user-id', () => {
  it('ausente: null', () => {
    expect(resolveRequestUserId({ userId: undefined } as any)).toBeNull();
  });

  it('número positivo: devolve como está', () => {
    expect(resolveRequestUserId({ userId: 7 } as any)).toBe(7);
  });

  it('string numérica: converte', () => {
    expect(resolveRequestUserId({ userId: '42' } as any)).toBe(42);
  });

  it('zero, negativo ou não-finito: null', () => {
    expect(resolveRequestUserId({ userId: 0 } as any)).toBeNull();
    expect(resolveRequestUserId({ userId: -1 } as any)).toBeNull();
    expect(resolveRequestUserId({ userId: 'abc' } as any)).toBeNull();
  });
});
