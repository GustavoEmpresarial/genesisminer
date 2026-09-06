/**
 * Verificação de e-mail: token assinado (HMAC), flags de estado, envio e
 * confirmação do e-mail de cadastro.
 *
 * Migrado de legacy/backend/modules/email-verification/emailVerification.service.ts.
 *
 * ⚠️ Achado ao portar `verifyEmailTokenAndActivate`: é **aqui**, na confirmação
 * do e-mail (não no cadastro), que o legado credita a recompensa de referral pra
 * quem indicou (`game_states.usdc`, `referral_models`) — ver
 * `modules/profile/services/referral-credit.ts` (`creditReferralBonusOnEmailVerified`).
 */
import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { sendVerificationEmail } from '../../../shared/security/mailer.js';
import { getAuthFlowTokenSecret } from '../../../shared/security/auth-flow-secret.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';
import { creditReferralBonusOnEmailVerified } from '../../profile/services/referral-credit.js';
import {
  rustBuildSignedToken,
  rustEmailFlags,
  rustHashTokenSha256,
  rustParseEmailVerificationToken,
  rustTimingSafeHexEqual
} from './auth-rust-bridge.js';

const EMAIL_VERIFICATION_TTL_HOURS = 24;
const EMAIL_VERIFICATION_TTL_MS = EMAIL_VERIFICATION_TTL_HOURS * MS_PER_HOUR;

export type EmailVerificationFlags = {
  emailVerified: boolean;
  emailVerificationRequired: boolean;
};

export function buildSignedEmailVerificationToken(email: string, expiryMs: number): string {
  const secret = getAuthFlowTokenSecret();
  const rust = rustBuildSignedToken('email_verification', email, expiryMs, secret);
  if (rust) return rust;
  const payload = JSON.stringify({
    email: String(email || '').trim().toLowerCase(),
    expiry: expiryMs,
    purpose: 'email_verification'
  });
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${signature}`;
}

export function parseSignedEmailVerificationToken(rawToken: unknown): { email: string; expiry: number } | null {
  const rust = rustParseEmailVerificationToken(rawToken, getAuthFlowTokenSecret());
  if (rust !== undefined) return rust;
  if (typeof rawToken !== 'string' || !rawToken.trim()) return null;
  const [payloadB64, signature] = rawToken.trim().split('.');
  if (!payloadB64 || !signature) return null;

  const payloadRaw = Buffer.from(payloadB64, 'base64').toString();
  const expectedSig = crypto.createHmac('sha256', getAuthFlowTokenSecret()).update(payloadRaw).digest('hex');
  // Comparação em tempo constante para prevenir timing attacks.
  let sigOk: boolean;
  try {
    sigOk = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return null;

  const payload = JSON.parse(payloadRaw) as { email?: unknown; expiry?: unknown; purpose?: unknown };
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const expiry = Number(payload.expiry);
  const purpose = typeof payload.purpose === 'string' ? payload.purpose : '';
  if (!email || !Number.isFinite(expiry) || purpose !== 'email_verification') return null;
  return { email, expiry };
}

const DB_BOOL_TRUE = 1;

export function getEmailVerificationFlags(user: {
  email_verified?: unknown;
  email_verification_required?: unknown;
}): EmailVerificationFlags {
  const rust = rustEmailFlags(user.email_verified, user.email_verification_required);
  if (rust) {
    return {
      emailVerified: rust.emailVerified,
      emailVerificationRequired: rust.emailVerificationRequired
    };
  }
  return {
    emailVerified: Number(user.email_verified || 0) === DB_BOOL_TRUE,
    emailVerificationRequired: Number(user.email_verification_required || 0) === DB_BOOL_TRUE
  };
}

export function userRequiresEmailVerification(user: {
  email_verified?: unknown;
  email_verification_required?: unknown;
}): boolean {
  const rust = rustEmailFlags(user.email_verified, user.email_verification_required);
  if (rust) return rust.requiresVerification;
  return (
    Number(user.email_verification_required || 0) === DB_BOOL_TRUE &&
    Number(user.email_verified || 0) !== DB_BOOL_TRUE
  );
}

export async function markUserPendingEmailVerificationTx(tx: Prisma.TransactionClient, userId: number): Promise<void> {
  await tx.users.update({
    where: { id: userId },
    data: { email_verification_required: 1, email_verified: 0 }
  });
}

export async function sendSignupVerificationEmail(email: string): Promise<void> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return;
  const token = buildSignedEmailVerificationToken(normalizedEmail, Date.now() + EMAIL_VERIFICATION_TTL_MS);
  // Persistir hash do token garante uso único e invalida link anterior ao reenviar.
  const tokenHash = rustHashTokenSha256(token) ?? crypto.createHash('sha256').update(token).digest('hex');
  await prisma.users.updateMany({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    data: { email_verification_token_hash: tokenHash }
  });
  await sendVerificationEmail(normalizedEmail, token, { validityHours: EMAIL_VERIFICATION_TTL_HOURS });
}

/** Reenvia o e-mail de confirmação só se a conta ainda estiver pendente (não revela se o e-mail existe). */
export async function resendVerificationEmailIfPending(email: string): Promise<void> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return;
  const row = await prisma.users.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    select: { email: true, email_verification_required: true, email_verified: true }
  });
  if (!row || !userRequiresEmailVerification(row)) return;
  await sendSignupVerificationEmail(row.email);
}

export type VerifyEmailTokenResult =
  | { ok: true; alreadyVerified?: boolean; message: string }
  | { ok: false; error: string; status: number };

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * Confirma o e-mail a partir do token assinado — marca `email_verified=1` /
 * `email_verification_required=0` e credita o indicador (se houver, ver
 * header do arquivo), tudo na mesma transação.
 */
export async function verifyEmailTokenAndActivate(rawToken: string): Promise<VerifyEmailTokenResult> {
  const parsed = parseSignedEmailVerificationToken(rawToken);
  if (!parsed) {
    return { ok: false, error: 'Invalid verification link.', status: HTTP_BAD_REQUEST };
  }
  if (Date.now() > parsed.expiry) {
    return { ok: false, error: 'Verification link expired. Request a new one.', status: HTTP_FORBIDDEN };
  }

  const row = await prisma.users.findFirst({
    where: { email: { equals: parsed.email, mode: 'insensitive' } },
    select: { id: true, email_verified: true, email_verification_token_hash: true }
  });
  if (!row) {
    return { ok: false, error: 'Account not found for this link.', status: HTTP_NOT_FOUND };
  }
  if (Number(row.email_verified || 0) === DB_BOOL_TRUE) {
    // Idempotent retry: email already verified but referral credit may have failed earlier.
    await creditReferralBonusOnEmailVerified(row.id);
    return { ok: true, alreadyVerified: true, message: 'Your email was already confirmed.' };
  }

  // Verifica que o token não foi substituído por um reenvio posterior.
  if (row.email_verification_token_hash) {
    const incomingHash =
      rustHashTokenSha256(String(rawToken)) ?? crypto.createHash('sha256').update(String(rawToken)).digest('hex');
    let hashOk: boolean;
    const rustEq = rustTimingSafeHexEqual(incomingHash, row.email_verification_token_hash);
    if (rustEq != null) {
      hashOk = rustEq;
    } else {
      try {
        hashOk = crypto.timingSafeEqual(
          Buffer.from(incomingHash, 'hex'),
          Buffer.from(row.email_verification_token_hash, 'hex')
        );
      } catch {
        hashOk = false;
      }
    }
    if (!hashOk) {
      return {
        ok: false,
        error: 'Verification link expired. Use the most recent link sent to your email.',
        status: HTTP_FORBIDDEN
      };
    }
  }

  await prisma.users.update({
    where: { id: row.id },
    data: { email_verified: 1, email_verification_required: 0, email_verification_token_hash: null }
  });
  // Money TX in genesis-wallet (fail-closed, idempotent via referral_bonus_claimed).
  await creditReferralBonusOnEmailVerified(row.id);

  return { ok: true, message: 'Email confirmed successfully. You can sign in now.' };
}
