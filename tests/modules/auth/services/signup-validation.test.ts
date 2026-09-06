import { describe, expect, it } from 'vitest';
import {
  assertPublicSignupEmailAllowed,
  SIGNUP_ALLOWED_DOMAINS,
  validateOptionalPolygonWallet,
  validateOptionalReferralCodeInput,
  validateSignupPassword,
  validateSignupUsername
} from '../../../../server/modules/auth/services/signup-validation.js';

describe('SIGNUP_ALLOWED_DOMAINS', () => {
  it('só os provedores de e-mail comuns', () => {
    expect([...SIGNUP_ALLOWED_DOMAINS]).toEqual(['gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'ymail.com']);
  });
});

describe('assertPublicSignupEmailAllowed', () => {
  it('aceita domínio permitido', () => {
    expect(assertPublicSignupEmailAllowed('user@gmail.com')).toEqual({ ok: true });
  });

  it('rejeita domínio fora da allowlist', () => {
    expect(assertPublicSignupEmailAllowed('user@empresa.com').ok).toBe(false);
  });

  it('rejeita e-mail descartável, mesmo que o domínio-base pareça válido', () => {
    expect(assertPublicSignupEmailAllowed('user@mailinator.com').ok).toBe(false);
    expect(assertPublicSignupEmailAllowed('user@sub.yopmail.com').ok).toBe(false);
  });

  it('rejeita e-mail malformado', () => {
    expect(assertPublicSignupEmailAllowed('semarroba.com').ok).toBe(false);
    expect(assertPublicSignupEmailAllowed('@gmail.com').ok).toBe(false);
  });
});

describe('validateSignupUsername', () => {
  it('aceita username válido', () => {
    expect(validateSignupUsername('Jogador_01')).toEqual({ ok: true, username: 'Jogador_01' });
  });

  it('rejeita menor que 3 ou maior que 50', () => {
    expect(validateSignupUsername('ab').ok).toBe(false);
    expect(validateSignupUsername('a'.repeat(51)).ok).toBe(false);
  });

  it('rejeita caracteres perigosos / tentativa de script', () => {
    expect(validateSignupUsername('<script>x</script>').ok).toBe(false);
    expect(validateSignupUsername('user{}').ok).toBe(false);
  });
});

describe('validateSignupPassword', () => {
  it('não exige nada quando required=false', () => {
    expect(validateSignupPassword(undefined, false)).toEqual({ ok: true });
  });

  it('exige senha forte quando required=true', () => {
    expect(validateSignupPassword('123', true).ok).toBe(false);
    expect(validateSignupPassword('senhaForte99', true)).toEqual({ ok: true });
  });
});

describe('validateOptionalReferralCodeInput', () => {
  it('vazio/null é válido (código opcional)', () => {
    expect(validateOptionalReferralCodeInput(null)).toEqual({ ok: true, code: null });
    expect(validateOptionalReferralCodeInput('')).toEqual({ ok: true, code: null });
  });

  it('aceita código dentro do limite', () => {
    expect(validateOptionalReferralCodeInput('abc-123')).toEqual({ ok: true, code: 'abc-123' });
  });

  it('rejeita caracteres perigosos', () => {
    expect(validateOptionalReferralCodeInput('<script>').ok).toBe(false);
  });
});

describe('validateOptionalPolygonWallet', () => {
  it('null/vazio é válido', () => {
    expect(validateOptionalPolygonWallet(null)).toBeNull();
    expect(validateOptionalPolygonWallet('')).toBeNull();
  });

  it('aceita endereço Ethereum válido', () => {
    const addr = `0x${'a'.repeat(40)}`;
    expect(validateOptionalPolygonWallet(addr)).toBe(addr);
  });

  it('rejeita endereço malformado', () => {
    expect(validateOptionalPolygonWallet('0x123')).toEqual({ error: expect.any(String) });
  });
});
