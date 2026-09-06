/**
 * Validação de cadastro público: domínio de e-mail permitido, username, senha,
 * código de referral opcional, carteira Polygon opcional, checagem de conflito.
 *
 * Migrado de legacy/backend/models/registrationValidation.ts (só a parte de
 * cadastro; `validateOptionalAccessLevelId`/`validateAccessLevelIdsArray` ficam de
 * fora — são edição por admin, não cadastro público, migram com `modules/profile/`
 * ou `modules/admin/`).
 */
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { mapPrismaClientError } from '../../../shared/errors/prisma-errors.js';
import { validatePasswordStrengthPolicy } from './password-policy.js';
import { EMAIL_ADDRESS_MAX_LENGTH } from './login-validation.js';
import {
  rustAssertPublicSignupEmail,
  rustValidateReferral,
  rustValidateSignupPassword,
  rustValidateSignupUsername,
  rustValidateWallet
} from './auth-rust-bridge.js';

/** Cadastro público: apenas estes domínios (login continua permitindo qualquer e-mail já registado). */
export const SIGNUP_ALLOWED_DOMAINS = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'ymail.com']);

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamailblock.com', 'sharklasers.com',
  'yopmail.com', 'yopmail.fr', 'tempmail.com', 'temp-mail.org', 'throwaway.email',
  'trashmail.com', '10minutemail.com', '10minutemail.net', 'fakeinbox.com', 'getnada.com',
  'maildrop.cc', 'dispostable.com', 'emailondeck.com', 'burnermail.io', 'moakt.com',
  'tmpmail.org', 'mailcatch.com', 'spam4.me', 'grr.la', 'mailnesia.com', 'trashmail.de',
  'discard.email', 'discardmail.com', 'wegwerfmail.de', 'trashmail.ws', 'armyspy.com',
  'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com',
  'rhyta.com', 'superrito.com', 'teleworm.us'
]);

export type PolicyResult = { ok: true } | { ok: false; error: string };

/** Limite do formulário de novo cadastro (UI/política pública) — mesmo teto que login. */
export const SIGNUP_EMAIL_MAX_TOTAL = EMAIL_ADDRESS_MAX_LENGTH;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 50;
export const REFERRAL_CODE_MAX_LENGTH = 50;

const FORBIDDEN_EMAIL_CHARS = /[<>'"\\]/;

export function assertPublicSignupEmailAllowed(normalizedEmail: string): PolicyResult {
  const rust = rustAssertPublicSignupEmail(normalizedEmail);
  if (rust) return rust;
  if (normalizedEmail.length > SIGNUP_EMAIL_MAX_TOTAL) {
    return { ok: false, error: 'Email too long.' };
  }
  const at = normalizedEmail.lastIndexOf('@');
  if (at < 1 || at === normalizedEmail.length - 1) {
    return { ok: false, error: 'Invalid email.' };
  }
  const local = normalizedEmail.slice(0, at);
  const domain = normalizedEmail.slice(at + 1).toLowerCase().trim();
  if (
    !local ||
    !domain ||
    local.length + 1 + domain.length > SIGNUP_EMAIL_MAX_TOTAL ||
    domain.includes('..') ||
    domain.startsWith('.') ||
    domain.endsWith('.')
  ) {
    return { ok: false, error: 'Invalid email.' };
  }
  if (FORBIDDEN_EMAIL_CHARS.test(local) || FORBIDDEN_EMAIL_CHARS.test(domain)) {
    return { ok: false, error: 'Email contains disallowed characters.' };
  }
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain) || domain.endsWith('.yopmail.com')) {
    return {
      ok: false,
      error: 'Temporary or disposable emails are not accepted. Use Gmail, Outlook, Hotmail, Live, or Yahoo.'
    };
  }
  if (SIGNUP_ALLOWED_DOMAINS.has(domain)) return { ok: true };
  return {
    ok: false,
    error: 'Signup allowed only with Gmail (@gmail.com), Outlook (@outlook.com), Hotmail (@hotmail.com), Live (@live.com), or Yahoo (@yahoo.com, @ymail.com).'
  };
}

/** Hífen no fim da classe para não formar intervalo com o espaço. */
const USERNAME_PATTERN = new RegExp(`^[a-zA-Z0-9_ -]{${USERNAME_MIN_LENGTH},${USERNAME_MAX_LENGTH}}$`);
const USERNAME_FORBIDDEN_CHARS = /[<>'"&`{}[\]\\/;]/;
const USERNAME_SCRIPT_PATTERN = /script/i;

export type UsernameValidation = { ok: true; username: string } | { ok: false; error: string };

/** Letras, números, espaço, _ e - ; sem HTML/XSS por rejeição de caracteres especiais. */
export function validateSignupUsername(raw: unknown): UsernameValidation {
  const rust = rustValidateSignupUsername(raw);
  if (rust) return rust;
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Username is required.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.` };
  }
  if (USERNAME_FORBIDDEN_CHARS.test(trimmed) || USERNAME_SCRIPT_PATTERN.test(trimmed)) {
    return { ok: false, error: 'Username contains disallowed characters.' };
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return { ok: false, error: 'Use only letters (A–Z), numbers, spaces, underscore (_), and hyphen (-).' };
  }
  return { ok: true, username: trimmed };
}

export type PasswordValidation = { ok: true } | { ok: false; error: string };

export function validateSignupPassword(raw: unknown, required: boolean): PasswordValidation {
  const rust = rustValidateSignupPassword(raw, required);
  if (rust) return rust;
  if (!required) return { ok: true };
  if (raw == null || typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'Set a password.' };
  }
  const strength = validatePasswordStrengthPolicy(raw);
  if (!strength.ok) {
    return { ok: false, error: strength.error };
  }
  return { ok: true };
}

export type ReferralCodeValidation = { ok: true; code: string | null } | { ok: false; error: string };

export function validateOptionalReferralCodeInput(raw: unknown): ReferralCodeValidation {
  const rust = rustValidateReferral(raw);
  if (rust) return rust;
  if (raw == null || raw === '') return { ok: true, code: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Invalid referral code.' };
  }
  const t = raw.trim();
  if (!t) return { ok: true, code: null };
  if (t.length > REFERRAL_CODE_MAX_LENGTH) {
    return { ok: false, error: `Referral code may be at most ${REFERRAL_CODE_MAX_LENGTH} characters.` };
  }
  if (/[<>'"&`\\]/.test(t)) {
    return { ok: false, error: 'Referral code contains disallowed characters.' };
  }
  return { ok: true, code: t };
}

const POLYGON_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function validateOptionalPolygonWallet(raw: unknown): string | null | { error: string } {
  const rust = rustValidateWallet(raw);
  if (rust !== undefined) return rust;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return { error: 'Invalid wallet.' };
  const t = raw.trim();
  if (!t) return null;
  if (!POLYGON_ADDRESS_PATTERN.test(t)) {
    return { error: 'Polygon wallet address must be a valid Ethereum address (0x + 40 hex).' };
  }
  return t;
}

const HTTP_SERVICE_UNAVAILABLE = 503;

function throwHttpFromPrisma(err: unknown, logCtx: string): never {
  console.error(logCtx, err instanceof Error ? err.message : err);
  const mapped = mapPrismaClientError(err);
  if (mapped) {
    throw new HttpControlledError(mapped.status, mapped.body);
  }
  throw new HttpControlledError(HTTP_SERVICE_UNAVAILABLE, {
    error: 'Could not validate data. Try again.',
    code: 'DB_READ'
  });
}

/** Outro utilizador já usa este nome (comparação case-insensitive). */
export async function getConflictingUserIdByUsername(
  username: string,
  excludeUserId?: number | string | null
): Promise<number | null> {
  const ex = excludeUserId != null && excludeUserId !== '' ? { not: Number(excludeUserId) } : undefined;
  try {
    const r = await prisma.users.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, ...(ex != null ? { id: ex } : {}) },
      select: { id: true }
    });
    return r?.id ?? null;
  } catch (e: unknown) {
    throwHttpFromPrisma(e, '[getConflictingUserIdByUsername]');
  }
}

/** E-mail já associado a outra conta. */
export async function getConflictingUserIdByEmail(
  email: string,
  excludeUserId?: number | string | null
): Promise<number | null> {
  const ex = excludeUserId != null && excludeUserId !== '' ? { not: Number(excludeUserId) } : undefined;
  try {
    const r = await prisma.users.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, ...(ex != null ? { id: ex } : {}) },
      select: { id: true }
    });
    return r?.id ?? null;
  } catch (e: unknown) {
    throwHttpFromPrisma(e, '[getConflictingUserIdByEmail]');
  }
}
