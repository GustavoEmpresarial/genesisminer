import { AUTH_LOGIN_RECOVERY_EMAIL_MAX } from '../constants/authLimits';

/** Regex alinhado ao gate leve do client (formato; servidor valida de novo). */
export const AUTH_EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AuthValidateErr = { ok: false; key: string; params?: Record<string, string | number> };

/**
 * Trim + length + formato. `maxLength` default = login/recovery.
 * Retorna e-mail normalizado (trim); lowercasing fica a cargo de `sanitizeEmailInput` no input.
 */
export function validateAuthEmail(
  emailRaw: string,
  maxLength: number = AUTH_LOGIN_RECOVERY_EMAIL_MAX
): { ok: true; email: string } | AuthValidateErr {
  const email = emailRaw.trim();
  if (!email || email.length > maxLength || !AUTH_EMAIL_FORMAT_RE.test(email)) {
    return { ok: false, key: 'auth.errValidEmail' };
  }
  return { ok: true, email };
}
