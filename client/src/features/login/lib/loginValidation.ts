import {
  AUTH_LOGIN_RECOVERY_EMAIL_MAX,
  AUTH_PASSWORD_MAX
} from '../../../shared/constants/authLimits';
import { validateAuthEmail, type AuthValidateErr } from '../../../shared/auth/validateEmail';

export type LoginValidateOk = { ok: true; email: string; password: string };
export type LoginValidateErr = AuthValidateErr;

export function validateLoginCredentials(
  emailRaw: string,
  password: string
): LoginValidateOk | LoginValidateErr {
  const email = emailRaw.trim();
  if (!email && !password) return { ok: false, key: 'auth.errEmailPassword' };
  if (!email) return { ok: false, key: 'auth.errEnterEmail' };
  if (!password) return { ok: false, key: 'auth.errEnterPassword' };
  if (email.length > AUTH_LOGIN_RECOVERY_EMAIL_MAX) {
    return { ok: false, key: 'auth.errEmailMax', params: { max: AUTH_LOGIN_RECOVERY_EMAIL_MAX } };
  }
  if (password.length > AUTH_PASSWORD_MAX) {
    return { ok: false, key: 'auth.errPasswordLong', params: { max: AUTH_PASSWORD_MAX } };
  }
  return { ok: true, email, password };
}

export function validateResendEmail(emailRaw: string): LoginValidateOk | LoginValidateErr {
  const v = validateAuthEmail(emailRaw, AUTH_LOGIN_RECOVERY_EMAIL_MAX);
  if (!v.ok) return v;
  return { ok: true, email: v.email, password: '' };
}

export const TURNSTILE_LOGIN_CONTAINER_ID = 'cf-turnstile-login';
