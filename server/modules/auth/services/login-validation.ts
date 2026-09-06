/**
 * Validação dos campos de login (e-mail/senha) — só forma/limites, sem whitelist de
 * domínio (isso é regra de cadastro, não de login).
 */
import {
  rustValidateLoginEmail,
  rustValidateLoginFieldsPresent,
  rustValidateLoginPassword
} from './auth-rust-bridge.js';

export type LoginValidationResult = { ok: true } | { ok: false; error: string };

export const EMAIL_ADDRESS_MAX_LENGTH = 50;
export const PASSWORD_MAX_LENGTH = 128;

export function validateLoginFieldsPresent(rawEmail: unknown, rawPassword: unknown): LoginValidationResult {
  const rust = rustValidateLoginFieldsPresent(rawEmail, rawPassword);
  if (rust) return rust;
  const emailStr = typeof rawEmail === 'string' ? rawEmail : '';
  const passwordStr = typeof rawPassword === 'string' ? rawPassword : '';
  const hasEmail = emailStr.trim().length > 0;
  const hasPassword = passwordStr.length > 0;
  if (!hasEmail && !hasPassword) {
    return { ok: false, error: 'Enter your email and password.' };
  }
  if (!hasEmail) {
    return { ok: false, error: 'Enter your email.' };
  }
  if (!hasPassword) {
    return { ok: false, error: 'Enter your password.' };
  }
  return { ok: true };
}

const FORBIDDEN_EMAIL_CHARS = /[<>'"\\]/;

export function validateLoginEmail(raw: unknown): LoginValidationResult {
  const rust = rustValidateLoginEmail(raw);
  if (rust) return rust;
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Enter your email.' };
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, error: 'Enter your email.' };
  }
  if (normalized.length > EMAIL_ADDRESS_MAX_LENGTH) {
    return { ok: false, error: `Email may be at most ${EMAIL_ADDRESS_MAX_LENGTH} characters.` };
  }
  const at = normalized.lastIndexOf('@');
  if (at < 1 || at === normalized.length - 1) {
    return { ok: false, error: 'Invalid email.' };
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (
    !local ||
    !domain ||
    local.length + 1 + domain.length > EMAIL_ADDRESS_MAX_LENGTH ||
    domain.includes('..') ||
    domain.startsWith('.') ||
    domain.endsWith('.')
  ) {
    return { ok: false, error: 'Invalid email.' };
  }
  if (FORBIDDEN_EMAIL_CHARS.test(local) || FORBIDDEN_EMAIL_CHARS.test(domain)) {
    return { ok: false, error: 'Email contains disallowed characters.' };
  }
  return { ok: true };
}

export function validateLoginPassword(raw: unknown): LoginValidationResult {
  const rust = rustValidateLoginPassword(raw);
  if (rust) return rust;
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Enter your password.' };
  }
  if (raw.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `Password is too long (maximum ${PASSWORD_MAX_LENGTH} characters).` };
  }
  return { ok: true };
}
