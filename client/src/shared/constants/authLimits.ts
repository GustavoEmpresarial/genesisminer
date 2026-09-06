/**
 * Cadastro e login: mesmo teto que `SIGNUP_EMAIL_MAX_TOTAL` / `EMAIL_ADDRESS_MAX_LENGTH` no servidor.
 */
export const AUTH_SIGNUP_EMAIL_MAX = 50;
export const AUTH_LOGIN_RECOVERY_EMAIL_MAX = 50;
/** Igual a `PASSWORD_MIN_LENGTH` em `password-policy.ts` (servidor). */
export const AUTH_PASSWORD_MIN = 6;
/** Igual a `PASSWORD_MAX` em `registrationValidation.ts` / strength policy (servidor). */
export const AUTH_PASSWORD_MAX = 50;
export const AUTH_USERNAME_MIN = 3;
/** Igual a `USERNAME_MAX` no servidor. */
export const AUTH_USERNAME_MAX = 50;
/** Igual a `REFERRAL_CODE_MAX` no servidor. */
export const AUTH_REFERRAL_MAX = 50;
