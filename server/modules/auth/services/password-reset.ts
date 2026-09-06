/**
 * Redefinição de senha por email: token HMAC de uso único + hash persistido.
 * Migrado de legacy/backend/server.ts (`/api/request-password-reset`, `/api/reset-password-secure`).
 */
import crypto from 'node:crypto';
import { prisma } from '../../../core/database/prisma.js';
import { sendResetEmail } from '../../../shared/security/mailer.js';
import { getAuthFlowTokenSecret } from '../../../shared/security/auth-flow-secret.js';
import { MS_PER_MINUTE } from '../../../shared/utils/time.js';
import { validateSignupPassword } from './signup-validation.js';
import {
  rustBuildSignedToken,
  rustHashTokenSha256,
  rustParsePasswordResetToken,
  rustTimingSafeHexEqual
} from './auth-rust-bridge.js';
import { BCRYPT_ROUNDS_REGISTER, authWorkerBcrypt, callAuthSessionDeleteByUser } from './auth-worker-client.js';

const PASSWORD_RESET_VALIDITY_MINUTES = 60;
const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_VALIDITY_MINUTES * MS_PER_MINUTE;
const PURPOSE = 'password_reset';

const GENERIC_REQUEST_OK = {
  ok: true as const,
  message: 'If an account exists for this email, we sent a link to reset your password.'
};

export type PasswordResetRequestResult = typeof GENERIC_REQUEST_OK;

export function buildSignedPasswordResetToken(email: string, expiryMs: number): string {
  const secret = getAuthFlowTokenSecret();
  const rust = rustBuildSignedToken('password_reset', email, expiryMs, secret);
  if (rust) return rust;
  const payload = JSON.stringify({
    email: String(email || '').trim(),
    expiry: expiryMs,
    purpose: PURPOSE
  });
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${signature}`;
}

function hashResetToken(resetToken: string): string {
  const rust = rustHashTokenSha256(resetToken);
  if (rust) return rust;
  return crypto.createHash('sha256').update(resetToken).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const rust = rustTimingSafeHexEqual(a, b);
  if (rust != null) return rust;
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export type ParseResetTokenOk = { email: string; expiry: number };
export type ParseResetTokenFail = { error: string; status: number };

export function parseSignedPasswordResetToken(rawToken: unknown): ParseResetTokenOk | ParseResetTokenFail {
  const rust = rustParsePasswordResetToken(rawToken, getAuthFlowTokenSecret(), Date.now());
  if (rust) return rust;
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    return { error: 'Incomplete data.', status: 400 };
  }
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return { error: 'Invalid token.', status: 400 };
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return { error: 'Invalid token.', status: 400 };

  const payloadRaw = Buffer.from(payloadB64, 'base64').toString();
  const expectedSig = crypto.createHmac('sha256', getAuthFlowTokenSecret()).update(payloadRaw).digest('hex');
  if (!timingSafeHexEqual(signature, expectedSig)) {
    return { error: 'Token tampered or invalid.', status: 403 };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return { error: 'Invalid token.', status: 400 };
  }
  const expiry = typeof payload.expiry === 'number' ? payload.expiry : -1;
  const purpose = typeof payload.purpose === 'string' ? payload.purpose : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || purpose !== PURPOSE) return { error: 'Invalid token.', status: 400 };
  if (Date.now() > expiry) return { error: 'Recovery session expired.', status: 403 };
  return { email, expiry };
}

/** Pedido de link: resposta uniforme (não enumera contas). */
export async function requestPasswordResetByEmail(rawEmail: string): Promise<PasswordResetRequestResult> {
  const row = await prisma.users.findFirst({
    where: { email: { equals: rawEmail, mode: 'insensitive' } },
    select: { id: true, email: true }
  });
  if (!row) return GENERIC_REQUEST_OK;

  const email = row.email;
  const expiry = Date.now() + PASSWORD_RESET_TTL_MS;
  const resetToken = buildSignedPasswordResetToken(email, expiry);
  const tokenHash = hashResetToken(resetToken);

  await prisma.users.update({
    where: { id: row.id },
    data: {
      password_reset_token_hash: tokenHash,
      password_reset_token_expires_at: BigInt(expiry)
    }
  });

  void sendResetEmail(email, resetToken, { validityMinutes: PASSWORD_RESET_VALIDITY_MINUTES }).catch(
    (mailErr: unknown) => {
      console.error('[request-password-reset] SMTP:', mailErr instanceof Error ? mailErr.message : mailErr);
    }
  );

  return GENERIC_REQUEST_OK;
}

export type ConsumeResetResult =
  | { ok: true; userId: number }
  | { ok: false; error: string; status: number };

/** Consome o token, redefine a senha e apaga sessões legadas `sid`. */
export async function consumePasswordResetAndSetPassword(
  resetToken: unknown,
  newPassword: unknown
): Promise<ConsumeResetResult> {
  if (typeof resetToken !== 'string' || typeof newPassword !== 'string' || !resetToken || !newPassword) {
    return { ok: false, error: 'Incomplete data.', status: 400 };
  }
  const pv = validateSignupPassword(newPassword, true);
  if (!pv.ok) return { ok: false, error: pv.error, status: 400 };

  const parsed = parseSignedPasswordResetToken(resetToken);
  if ('error' in parsed) return { ok: false, error: parsed.error, status: parsed.status };

  const tokenHash = hashResetToken(resetToken);
  const userRow = await prisma.users.findFirst({
    where: { email: { equals: parsed.email, mode: 'insensitive' } },
    select: { id: true, password_reset_token_hash: true, password_reset_token_expires_at: true }
  });
  if (!userRow) return { ok: false, error: 'Account not found.', status: 400 };

  const storedHash = userRow.password_reset_token_hash;
  const storedExpiry = userRow.password_reset_token_expires_at;
  if (!storedHash || !timingSafeHexEqual(storedHash, tokenHash)) {
    return { ok: false, error: 'Recovery link already used or invalid.', status: 403 };
  }
  if (storedExpiry && Date.now() > Number(storedExpiry)) {
    return { ok: false, error: 'Recovery session expired.', status: 403 };
  }

  const hashedPassword = await authWorkerBcrypt.hash(newPassword, BCRYPT_ROUNDS_REGISTER);
  const wipe = await callAuthSessionDeleteByUser({ userId: userRow.id });
  if (!wipe.ok) {
    throw new Error(wipe.error ?? 'auth session delete-by-user failed');
  }
  await prisma.users.update({
    where: { id: userRow.id },
    data: {
      password: hashedPassword,
      password_reset_token_hash: null,
      password_reset_token_expires_at: null,
      login_failure_count: 0,
      login_locked_until: null
    }
  });

  return { ok: true, userId: userRow.id };
}

/** Exposto para testes — TTL do link por email (1h). */
export const PASSWORD_RESET_LINK_TTL_MS = PASSWORD_RESET_TTL_MS;

/** Mensagem genérica de pedido (testes / controller). */
export const PASSWORD_RESET_GENERIC_OK = GENERIC_REQUEST_OK;
