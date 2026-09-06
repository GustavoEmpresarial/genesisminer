import { describe, expect, it } from 'vitest';
import { generateReferralCode } from '../../../../server/modules/auth/services/referral-code.js';

describe('generateReferralCode', () => {
  it('gera código com slug do username + sufixo aleatório', () => {
    const code = generateReferralCode('joao silva');
    expect(code).toMatch(/^joao-silva-[0-9a-f]{8}_\d{5}$/);
  });

  it('acento é tratado como caractere não permitido (regex é ASCII [a-z0-9_-])', () => {
    // Comportamento herdado do legado, não "corrigido" aqui (mudaria o formato dos
    // códigos já emitidos) — documentado no teste pra não virar surpresa depois.
    const code = generateReferralCode('João');
    expect(code.startsWith('jo-o-')).toBe(true);
  });

  it('username vazio cai no slug "user"', () => {
    expect(generateReferralCode('')).toMatch(/^user-[0-9a-f]{8}_\d{5}$/);
  });

  it('remove caracteres não permitidos do slug', () => {
    const code = generateReferralCode('a@b#c!d');
    expect(code.split('-')[0]).not.toMatch(/[@#!]/);
  });

  it('trunca slug em 12 caracteres', () => {
    const code = generateReferralCode('nome-extremamente-longo-de-usuario');
    const slug = code.replace(/-[0-9a-f]{8}_\d{5}$/, '');
    expect(slug.length).toBeLessThanOrEqual(12);
  });

  it('duas chamadas geram códigos diferentes (aleatoriedade)', () => {
    expect(generateReferralCode('mesmo')).not.toBe(generateReferralCode('mesmo'));
  });
});
