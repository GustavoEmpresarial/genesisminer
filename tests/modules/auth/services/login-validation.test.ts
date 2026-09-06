import { describe, expect, it } from 'vitest';
import {
  EMAIL_ADDRESS_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  validateLoginEmail,
  validateLoginFieldsPresent,
  validateLoginPassword
} from '../../../../server/modules/auth/services/login-validation.js';

describe('validateLoginFieldsPresent', () => {
  it('ok quando os dois estão presentes', () => {
    expect(validateLoginFieldsPresent('a@b.com', 'x')).toEqual({ ok: true });
  });

  it('mensagem distinta pra cada campo faltando', () => {
    expect(validateLoginFieldsPresent('', '')).toMatchObject({ ok: false, error: expect.stringContaining('email and password') });
    expect(validateLoginFieldsPresent('', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('email') });
    expect(validateLoginFieldsPresent('a@b.com', '')).toMatchObject({ ok: false, error: expect.stringContaining('password') });
  });
});

describe('validateLoginEmail', () => {
  it('aceita e-mail válido', () => {
    expect(validateLoginEmail('user@example.com')).toEqual({ ok: true });
  });

  it('rejeita não-string / vazio', () => {
    expect(validateLoginEmail(null).ok).toBe(false);
    expect(validateLoginEmail('   ').ok).toBe(false);
  });

  it('rejeita acima do limite de tamanho', () => {
    const long = `${'a'.repeat(EMAIL_ADDRESS_MAX_LENGTH)}@x.com`;
    expect(validateLoginEmail(long).ok).toBe(false);
  });

  it('rejeita sem @ ou com @ na primeira/última posição', () => {
    expect(validateLoginEmail('semarroba.com').ok).toBe(false);
    expect(validateLoginEmail('@dominio.com').ok).toBe(false);
    expect(validateLoginEmail('user@').ok).toBe(false);
  });

  it('rejeita domínio com ".." ou começando/terminando em ponto', () => {
    expect(validateLoginEmail('user@dom..com').ok).toBe(false);
    expect(validateLoginEmail('user@.com').ok).toBe(false);
    expect(validateLoginEmail('user@com.').ok).toBe(false);
  });

  it('rejeita caracteres perigosos no local/domínio', () => {
    expect(validateLoginEmail('user<script>@x.com').ok).toBe(false);
  });
});

describe('validateLoginPassword', () => {
  it('aceita senha dentro do limite', () => {
    expect(validateLoginPassword('senha123')).toEqual({ ok: true });
  });

  it('rejeita não-string', () => {
    expect(validateLoginPassword(undefined).ok).toBe(false);
  });

  it('rejeita acima do limite de tamanho', () => {
    expect(validateLoginPassword('x'.repeat(PASSWORD_MAX_LENGTH + 1)).ok).toBe(false);
  });
});
