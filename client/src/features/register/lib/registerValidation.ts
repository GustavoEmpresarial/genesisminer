import {
  AUTH_PASSWORD_MAX,
  AUTH_PASSWORD_MIN,
  AUTH_REFERRAL_MAX,
  AUTH_SIGNUP_EMAIL_MAX,
  AUTH_USERNAME_MAX,
  AUTH_USERNAME_MIN
} from '../../../shared/constants/authLimits';
import { validateAuthEmail, type AuthValidateErr } from '../../../shared/auth/validateEmail';

export type RegisterFields = {
  email: string;
  password: string;
  username: string;
  confirmPassword: string;
  referralInput: string;
  acceptedTerms: boolean;
  turnstileRequired: boolean;
  turnstileToken: string;
};

export type RegisterValidateOk = { ok: true; email: string; username: string };
export type RegisterValidateErr = AuthValidateErr;

export function validateRegisterFields(f: RegisterFields): RegisterValidateOk | RegisterValidateErr {
  if (!f.email || !f.password || !f.username) return { ok: false, key: 'auth.errAllRequired' };
  const emailCheck = validateAuthEmail(f.email, AUTH_SIGNUP_EMAIL_MAX);
  if (!emailCheck.ok) return emailCheck;
  const username = f.username.trim();
  if (username.length < AUTH_USERNAME_MIN || username.length > AUTH_USERNAME_MAX) {
    return {
      ok: false,
      key: 'auth.errUsernameLen',
      params: { min: AUTH_USERNAME_MIN, max: AUTH_USERNAME_MAX }
    };
  }
  if (f.password.length > AUTH_PASSWORD_MAX) {
    return { ok: false, key: 'auth.errPasswordMax', params: { max: AUTH_PASSWORD_MAX } };
  }
  if (f.password.length < AUTH_PASSWORD_MIN) {
    return { ok: false, key: 'auth.errPasswordMin', params: { min: AUTH_PASSWORD_MIN } };
  }
  if (f.referralInput.trim().length > AUTH_REFERRAL_MAX) {
    return { ok: false, key: 'auth.errReferralMax', params: { max: AUTH_REFERRAL_MAX } };
  }
  if (f.password !== f.confirmPassword) return { ok: false, key: 'auth.errPasswordsMatch' };
  if (f.turnstileRequired && !f.turnstileToken) return { ok: false, key: 'auth.errCaptcha' };
  if (!f.acceptedTerms) return { ok: false, key: 'auth.errTerms' };
  return { ok: true, email: emailCheck.email, username };
}

export function buildClientReferralCode(username: string): string {
  return `${username.toLowerCase().replace(/\s/g, '')}-${crypto.randomUUID().slice(0, 4)}`;
}

export const TURNSTILE_REGISTER_CONTAINER_ID = 'cf-turnstile-register';
export const GENESIS_REF_SS = 'genesis_ref';
