import { describe, expect, it } from 'vitest';
import { shouldEmitThrottled } from '../../../server/shared/utils/log-throttle.js';

// Base de tempo realista (não-zero): a guarda interna usa `prev > 0` para distinguir
// "nunca emitido" (Map sem entrada, default 0) de "emitido no instante 0" — em produção
// Date.now() nunca é 0, então a base de teste precisa refletir isso.
const T0 = 1_700_000_000_000;

describe('shouldEmitThrottled', () => {
  it('primeira emissão sempre passa', () => {
    expect(shouldEmitThrottled('k1', 1000, T0)).toBe(true);
  });

  it('bloqueia repetição dentro do TTL', () => {
    const key = 'k2';
    expect(shouldEmitThrottled(key, 1000, T0)).toBe(true);
    expect(shouldEmitThrottled(key, 1000, T0 + 500)).toBe(false);
  });

  it('libera de novo depois do TTL', () => {
    const key = 'k3';
    expect(shouldEmitThrottled(key, 1000, T0)).toBe(true);
    expect(shouldEmitThrottled(key, 1000, T0 + 1500)).toBe(true);
  });

  it('impõe piso mínimo de 1000ms mesmo com ttl menor', () => {
    const key = 'k4';
    expect(shouldEmitThrottled(key, 10, T0)).toBe(true);
    expect(shouldEmitThrottled(key, 10, T0 + 500)).toBe(false);
  });

  it('chaves diferentes não se afetam', () => {
    expect(shouldEmitThrottled('a', 1000, T0)).toBe(true);
    expect(shouldEmitThrottled('b', 1000, T0)).toBe(true);
  });

  it('faz limpeza (evict) quando passa de MAX_KEYS entradas', () => {
    // MAX_KEYS = 8000 (interno). Insere 8001 chaves distintas no mesmo instante —
    // dispara o ramo de limpeza por cutoff (e o `clear()` de segurança, se sobrar).
    for (let i = 0; i < 8001; i++) {
      shouldEmitThrottled(`bulk-${i}`, 1000, T0 + i);
    }
    // Não afirma sobre o tamanho interno (não exportado) — só garante que não lança
    // e que o comportamento normal continua depois da limpeza.
    expect(shouldEmitThrottled('post-cleanup', 1000, T0 + 100_000)).toBe(true);
  });
});
