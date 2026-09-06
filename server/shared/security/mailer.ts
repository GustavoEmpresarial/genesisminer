/**
 * Envio de e-mail transacional via `genesis-auth` (SMTP no worker).
 *
 * Fail-closed: unset `GENESIS_AUTH_URL` ou erro do worker → throw.
 * Templates / defaults de host/from/base URL vivem no Rust (`mail.rs`).
 */
import {
  callAuthMailReset,
  callAuthMailVerify
} from '../../modules/auth/services/auth-worker-client.js';

/** Keep in sync with Rust `DEFAULT_RESET_LINK_VALIDITY_MINUTES`. */
export const DEFAULT_RESET_LINK_VALIDITY_MINUTES = 60;
/** Keep in sync with Rust `DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS`. */
export const DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS = 24;

export type SendResetEmailOpts = { validityMinutes?: number };
export type SendVerificationEmailOpts = { validityHours?: number };

/** Envia o e-mail de "redefinição de senha", com link contendo `resetToken`. */
export async function sendResetEmail(
  email: string,
  resetToken: string,
  opts: SendResetEmailOpts = {}
): Promise<void> {
  const validityMinutes =
    typeof opts.validityMinutes === 'number' && opts.validityMinutes > 0
      ? opts.validityMinutes
      : DEFAULT_RESET_LINK_VALIDITY_MINUTES;
  const r = await callAuthMailReset({ email, resetToken, validityMinutes });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth mail reset failed');
  }
}

/** Envia o e-mail de "confirme seu e-mail", com link contendo `verificationToken`. */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string,
  opts: SendVerificationEmailOpts = {}
): Promise<void> {
  const validityHours =
    typeof opts.validityHours === 'number' && opts.validityHours > 0
      ? opts.validityHours
      : DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS;
  const r = await callAuthMailVerify({ email, verificationToken, validityHours });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth mail verify failed');
  }
}
