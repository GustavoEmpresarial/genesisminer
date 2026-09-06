import { describe, expect, it } from 'vitest';
import { sanitizeApiMessage, sanitizeForLog } from '../../../server/shared/utils/safe-text.js';

describe('sanitizeForLog', () => {
  it('remove caracteres zero-width e limita tamanho', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    expect(sanitizeForLog(`a${zeroWidthSpace}b`, 10)).toBe('ab');
    expect(sanitizeForLog('x'.repeat(100), 5)).toBe('xxxxx…');
  });

  it('remove BOM e overrides bidi', () => {
    const bom = String.fromCharCode(0xfeff);
    const bidiOverride = String.fromCharCode(0x202e);
    expect(sanitizeForLog(`${bom}texto${bidiOverride}`, 50)).toBe('texto');
  });

  it('remove caracteres de controle (viram espaço) e símbolos perigosos (removidos, não substituídos)', () => {
    expect(sanitizeForLog('a\x00b<c>&d`e|f$g\\h', 50)).toBe('a bcdefgh');
  });

  it('aceita não-string convertendo para String()', () => {
    expect(sanitizeForLog(42)).toBe('42');
    expect(sanitizeForLog(null)).toBe('null');
  });

  it('colapsa espaços múltiplos e faz trim', () => {
    expect(sanitizeForLog('  a    b  ', 50)).toBe('a b');
  });
});

describe('sanitizeApiMessage', () => {
  it('bloqueia esquemas perigosos', () => {
    expect(sanitizeApiMessage('javascript:alert(1)')).toBe('Invalid request.');
    expect(sanitizeApiMessage('  data:text/html,x')).toBe('Invalid request.');
    expect(sanitizeApiMessage('<script>x</script>')).toBe('Invalid request.');
  });

  it('reutiliza sanitizeForLog para texto normal', () => {
    expect(sanitizeApiMessage('  ok  ')).toBe('ok');
  });

  it('cai no fallback "Internal error." quando o resultado sanitizado fica vazio', () => {
    expect(sanitizeApiMessage('   ')).toBe('Internal error.');
  });
});
