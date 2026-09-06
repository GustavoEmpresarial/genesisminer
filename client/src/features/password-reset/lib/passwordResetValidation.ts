import {
  AUTH_LOGIN_RECOVERY_EMAIL_MAX,
  AUTH_PASSWORD_MAX,
  AUTH_PASSWORD_MIN
} from '../../../shared/constants/authLimits';

export type ResetValidateOk = { ok: true };
export type ResetValidateErr = { ok: false; key: string; params?: Record<string, string | number> };

export function validateRecoveryEmail(emailRaw: string): { ok: true; email: string } | ResetValidateErr {
  const email = emailRaw.trim();
  if (!email || email.length > AUTH_LOGIN_RECOVERY_EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, key: 'auth.errValidEmail' };
  }
  return { ok: true, email };
}

export function validateNewPasswordPair(
  password: string,
  confirmPassword: string
): ResetValidateOk | ResetValidateErr {
  if (password.length > AUTH_PASSWORD_MAX) {
    return { ok: false, key: 'auth.errPasswordMax', params: { max: AUTH_PASSWORD_MAX } };
  }
  if (password.length < AUTH_PASSWORD_MIN) {
    return { ok: false, key: 'auth.errPasswordMin', params: { min: AUTH_PASSWORD_MIN } };
  }
  if (password !== confirmPassword) return { ok: false, key: 'auth.errPasswordsMatch' };
  return { ok: true };
}

export type RecoveryStep = 'email' | 'sent' | 'reset';
