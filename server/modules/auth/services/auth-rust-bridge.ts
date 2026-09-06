/**
 * Opt-in Rust bridge for auth domain (validation, HMAC tokens, lockout, fingerprint).
 * Crypto I/O (bcrypt + access JWT) goes through `genesis-auth` HTTP (`GENESIS_AUTH_URL`).
 * Prisma sessão/refresh, SMTP, Turnstile stay in Node.
 */
import {
  genesisAuthRustEnabled,
  loadGenesisNative
} from '../../../shared/rust/genesis-native.js';

function nativeAuth() {
  if (!genesisAuthRustEnabled()) return null;
  return loadGenesisNative();
}

function parsePolicy(raw: string): { ok: true } | { ok: false; error: string } {
  const j = JSON.parse(raw) as { ok: boolean; error?: string };
  if (j.ok) return { ok: true };
  return { ok: false, error: String(j.error || 'Invalid.') };
}

export function rustValidateLoginFieldsPresent(
  email: unknown,
  password: unknown
): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateLoginFieldsJson;
  if (!fn) return null;
  try {
    return parsePolicy(
      fn(
        typeof email === 'string' ? email : undefined,
        typeof password === 'string' ? password : undefined
      )
    );
  } catch (e) {
    console.warn('[auth/rust] validateLoginFieldsPresent fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateLoginEmail(raw: unknown): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateLoginEmailJson;
  if (!fn) return null;
  try {
    return parsePolicy(fn(typeof raw === 'string' ? raw : undefined));
  } catch (e) {
    console.warn('[auth/rust] validateLoginEmail fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateLoginPassword(raw: unknown): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateLoginPasswordJson;
  if (!fn) return null;
  try {
    return parsePolicy(fn(typeof raw === 'string' ? raw : undefined));
  } catch (e) {
    console.warn('[auth/rust] validateLoginPassword fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidatePasswordStrength(password: string): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authPasswordStrengthJson;
  if (!fn) return null;
  try {
    return parsePolicy(fn(password));
  } catch (e) {
    console.warn('[auth/rust] passwordStrength fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustAssertPublicSignupEmail(email: string): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authAssertSignupEmailJson;
  if (!fn) return null;
  try {
    return parsePolicy(fn(email));
  } catch (e) {
    console.warn('[auth/rust] assertSignupEmail fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateSignupUsername(
  raw: unknown
): { ok: true; username: string } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateUsernameJson;
  if (!fn) return null;
  try {
    const j = JSON.parse(fn(typeof raw === 'string' ? raw : undefined)) as {
      ok: boolean;
      username?: string;
      error?: string;
    };
    if (j.ok && j.username) return { ok: true, username: j.username };
    return { ok: false, error: String(j.error || 'Username is required.') };
  } catch (e) {
    console.warn('[auth/rust] validateUsername fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateSignupPassword(
  raw: unknown,
  required: boolean
): { ok: true } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateSignupPasswordJson;
  if (!fn) return null;
  try {
    return parsePolicy(fn(typeof raw === 'string' ? raw : undefined, required));
  } catch (e) {
    console.warn('[auth/rust] validateSignupPassword fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateReferral(
  raw: unknown
): { ok: true; code: string | null } | { ok: false; error: string } | null {
  const n = nativeAuth();
  const fn = n?.authValidateReferralJson;
  if (!fn) return null;
  try {
    const j = JSON.parse(
      fn(raw == null || raw === '' ? undefined : typeof raw === 'string' ? raw : undefined)
    ) as { ok: boolean; code?: string | null; error?: string };
    if (j.ok) return { ok: true, code: j.code ?? null };
    return { ok: false, error: String(j.error || 'Invalid referral code.') };
  } catch (e) {
    console.warn('[auth/rust] validateReferral fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustValidateWallet(raw: unknown): string | null | { error: string } | undefined {
  const n = nativeAuth();
  const fn = n?.authValidateWalletJson;
  if (!fn) return undefined;
  try {
    const out = fn(raw == null || raw === '' ? undefined : typeof raw === 'string' ? raw : undefined);
    if (out === 'null') return null;
    const j = JSON.parse(out) as string | { error: string };
    if (typeof j === 'string') return j;
    if (j && typeof j === 'object' && 'error' in j) return { error: String(j.error) };
    return null;
  } catch (e) {
    console.warn('[auth/rust] validateWallet fallback', e instanceof Error ? e.message : e);
    return undefined;
  }
}

export function rustGenerateReferralCode(username: string): string | null {
  const n = nativeAuth();
  const fn = n?.authGenerateReferralCode;
  if (!fn) return null;
  try {
    return fn(username);
  } catch (e) {
    console.warn('[auth/rust] generateReferralCode fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustBuildSignedToken(
  purpose: 'password_reset' | 'email_verification',
  email: string,
  expiryMs: number,
  secret: string
): string | null {
  const n = nativeAuth();
  const fn = n?.authBuildSignedTokenJson;
  if (!fn) return null;
  try {
    return fn(purpose, email, expiryMs, secret);
  } catch (e) {
    console.warn('[auth/rust] buildSignedToken fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustParsePasswordResetToken(
  token: unknown,
  secret: string,
  nowMs: number
): { email: string; expiry: number } | { error: string; status: number } | null {
  const n = nativeAuth();
  const fn = n?.authParseSignedTokenJson;
  if (!fn || typeof token !== 'string') return null;
  try {
    const j = JSON.parse(fn('password_reset', token, secret, nowMs)) as {
      email?: string;
      expiry?: number;
      error?: string;
      status?: number;
    };
    if (j.error) return { error: j.error, status: j.status ?? 400 };
    if (j.email != null && j.expiry != null) return { email: j.email, expiry: j.expiry };
    return { error: 'Invalid token.', status: 400 };
  } catch (e) {
    console.warn('[auth/rust] parsePasswordResetToken fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustParseEmailVerificationToken(
  token: unknown,
  secret: string
): { email: string; expiry: number } | null | undefined {
  const n = nativeAuth();
  const fn = n?.authParseSignedTokenJson;
  if (!fn) return undefined;
  if (typeof token !== 'string') return null;
  try {
    const raw = fn('email_verification', token, secret, Date.now());
    if (raw === 'null') return null;
    return JSON.parse(raw) as { email: string; expiry: number };
  } catch (e) {
    console.warn('[auth/rust] parseEmailVerificationToken fallback', e instanceof Error ? e.message : e);
    return undefined;
  }
}

export function rustHashTokenSha256(token: string): string | null {
  const n = nativeAuth();
  const fn = n?.authHashTokenSha256;
  if (!fn) return null;
  try {
    return fn(token);
  } catch (e) {
    console.warn('[auth/rust] hashToken fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustTimingSafeHexEqual(a: string, b: string): boolean | null {
  const n = nativeAuth();
  const fn = n?.authTimingSafeHexEqual;
  if (!fn) return null;
  try {
    return fn(a, b);
  } catch (e) {
    console.warn('[auth/rust] timingSafeHexEqual fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustLockoutStatus(
  lockedUntilMs: number | null | undefined,
  nowMs: number
): { locked: boolean; remainingSeconds: number } | null {
  const n = nativeAuth();
  const fn = n?.authLockoutStatusJson;
  if (!fn) return null;
  try {
    const j = JSON.parse(
      fn(lockedUntilMs == null ? undefined : Number(lockedUntilMs), nowMs)
    ) as { locked: boolean; remainingSeconds: number };
    return j;
  } catch (e) {
    console.warn('[auth/rust] lockoutStatus fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustEmailFlags(
  emailVerified: unknown,
  emailVerificationRequired: unknown
): {
  emailVerified: boolean;
  emailVerificationRequired: boolean;
  requiresVerification: boolean;
} | null {
  const n = nativeAuth();
  const fn = n?.authEmailFlagsJson;
  if (!fn) return null;
  try {
    return JSON.parse(
      fn(Number(emailVerified || 0), Number(emailVerificationRequired || 0))
    ) as {
      emailVerified: boolean;
      emailVerificationRequired: boolean;
      requiresVerification: boolean;
    };
  } catch (e) {
    console.warn('[auth/rust] emailFlags fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustSanitizeFingerprint(
  raw: unknown
): { fingerprintHash: string; payloadJson: string } | null | undefined {
  const n = nativeAuth();
  const fn = n?.authSanitizeFingerprintJson;
  if (!fn) return undefined;
  try {
    const out = fn(JSON.stringify(raw ?? null));
    if (out == null) return null;
    const j = JSON.parse(out) as { fingerprintHash: string; payloadJson: string };
    return j;
  } catch (e) {
    console.warn('[auth/rust] sanitizeFingerprint fallback', e instanceof Error ? e.message : e);
    return undefined;
  }
}
