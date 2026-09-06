/**
 * Thin HTTP client for `genesis-auth` (bcrypt + JWT + Turnstile + SMTP + session/refresh PG).
 *
 * Callers always delegate here — no TS bcryptjs / jsonwebtoken / nodemailer / CF fetch fallback.
 * Unset `GENESIS_AUTH_URL` → throw / `{ ok: false, error: 'GENESIS_AUTH_URL unset' }`.
 * Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN` (same as mining/hardware).
 *
 * Napi `GENESIS_AUTH_RUST` covers validation/HMAC/lockout math — not this I/O path.
 */

import {
  MINING_WORKER_AUTH_HEADER,
  MINING_WORKER_PROGRESS_TIMEOUT_MS,
  miningWorkerAuthToken
} from '../../mining-engine/services/mining-worker-client.js';

/** Keep in sync with Rust `BCRYPT_ROUNDS_REGISTER` / Node register + password-reset. */
export const BCRYPT_ROUNDS_REGISTER = 12;
/** Keep in sync with Rust `BCRYPT_ROUNDS_PROFILE` / Node profile + admin + bulk. */
export const BCRYPT_ROUNDS_PROFILE = 10;

const PASSWORD_HASH_PATH = '/v1/auth/password/hash';
const PASSWORD_VERIFY_PATH = '/v1/auth/password/verify';
const JWT_SIGN_PATH = '/v1/auth/jwt/sign';
const JWT_VERIFY_PATH = '/v1/auth/jwt/verify';
const TURNSTILE_VERIFY_PATH = '/v1/auth/turnstile/verify';
const MAIL_RESET_PATH = '/v1/auth/mail/reset';
const MAIL_VERIFY_PATH = '/v1/auth/mail/verify';
const SESSION_CREATE_PATH = '/v1/auth/session/create';
const SESSION_LOAD_PATH = '/v1/auth/session/load';
const SESSION_DELETE_PATH = '/v1/auth/session/delete';
const SESSION_DELETE_BY_USER_PATH = '/v1/auth/session/delete-by-user';
const SESSION_UPDATE_FLAGS_PATH = '/v1/auth/session/update-flags';

/** Prisma `sessions.manager_mode` `@default(0)`. */
export const SESSION_MANAGER_MODE_OFF = 0;
/** Gerente enter / Node `manager.ts` sets `manager_mode = 1`. */
export const SESSION_MANAGER_MODE_ON = 1;
const REFRESH_ISSUE_PATH = '/v1/auth/refresh/issue';
const REFRESH_ROTATE_PATH = '/v1/auth/refresh/rotate';
const REFRESH_REVOKE_PATH = '/v1/auth/refresh/revoke';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** Floor for classifying upstream 5xx (keep in sync with HTTP status classes). */
const HTTP_SERVER_ERROR_FLOOR = 500;

const AUTH_WORKER_UNSET_ERROR = 'GENESIS_AUTH_URL unset';

export type AuthPasswordHashResult = { ok: boolean; hash?: string; error?: string };
export type AuthPasswordVerifyResult = { ok: boolean; match?: boolean; error?: string };
export type AuthJwtSignResult = {
  ok: boolean;
  token?: string;
  expiresInSec?: number;
  error?: string;
  errorName?: string;
};
export type AuthJwtVerifyResult = {
  ok: boolean;
  userId?: number;
  jti?: string;
  exp?: number;
  error?: string;
  errorName?: string;
};

export type AuthTurnstileVerifyResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export type AuthMailResult = { ok: boolean; error?: string };

export type AuthSessionUserPayload = {
  id: number;
  username: string;
  email: string;
  isAdmin?: number | null;
  isSuperAdmin?: number;
  polygonWallet?: string | null;
  isBlocked?: number | null;
  accessLevelId?: string | null;
  referralCode?: string | null;
  referredBy?: string | null;
  lastActiveAtMs?: number | null;
  rankingExcluded?: number | null;
  registrationIp?: string | null;
  adminPermissions?: string | null;
  emailVerificationRequired?: number;
  emailVerified?: number;
  loginFailureCount?: number;
  loginLockedUntilMs?: number | null;
};

export type AuthSessionLoadOk = {
  ok: true;
  userId: number;
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
  originalUserId?: number | null;
  lastSeenAtMs?: number | null;
  managerMode?: number;
  actingAsOwnerId?: number | null;
  user: AuthSessionUserPayload;
};

export type AuthSessionLoadFail = { ok: false; status: number; error: string };
export type AuthSessionLoadResult = AuthSessionLoadOk | AuthSessionLoadFail;

export type AuthSessionMutateResult = { ok: boolean; userId?: number; error?: string };

export type AuthSessionDeleteByUserOk = { ok: true; deletedCount: number };
export type AuthSessionDeleteByUserResult = AuthSessionDeleteByUserOk | { ok: false; error: string };

export type AuthSessionUpdateFlagsOk = {
  ok: true;
  sessionId?: string;
  userId?: number;
  originalUserId?: number | null;
  managerMode?: number;
  actingAsOwnerId?: number | null;
};
export type AuthSessionUpdateFlagsFail = { ok: false; status: number; error: string };
export type AuthSessionUpdateFlagsResult = AuthSessionUpdateFlagsOk | AuthSessionUpdateFlagsFail;

export type AuthRefreshIssueOk = {
  ok: true;
  refreshToken: string;
  expiresAtMs: number;
  expiresInSec: number;
};
export type AuthRefreshIssueResult = AuthRefreshIssueOk | { ok: false; error: string };

export type AuthRefreshRotateOk = {
  ok: true;
  userId: number;
  refreshToken: string;
  expiresInSec: number;
};
export type AuthRefreshRotateFail = { ok: false; code: 'invalid' | 'expired'; error?: string };
export type AuthRefreshRotateResult = AuthRefreshRotateOk | AuthRefreshRotateFail;

export type AuthRefreshRevokeResult = { ok: boolean; error?: string };

/** Infra classification for login / callers — not wrong-password. */
export type AuthWorkerInfraKind = 'unset' | 'transport' | 'upstream';

export function classifyAuthWorkerError(error: string): AuthWorkerInfraKind | null {
  const msg = String(error || '');
  if (msg === AUTH_WORKER_UNSET_ERROR || msg.includes(AUTH_WORKER_UNSET_ERROR)) {
    return 'unset';
  }
  if (
    msg.startsWith('auth worker unreachable') ||
    msg.startsWith('auth worker non-JSON') ||
    msg.startsWith('auth worker empty body')
  ) {
    return 'transport';
  }
  if (/auth worker HTTP 5\d\d/.test(msg) || msg === 'auth password hash failed' || msg === 'auth password verify failed') {
    return 'upstream';
  }
  if (msg.startsWith('auth worker missing') || msg.startsWith('auth worker HTTP')) {
    return 'upstream';
  }
  return null;
}

/** HTTP status for auth-worker infra failures (unset → 503, else 502). */
export function authWorkerInfraHttpStatus(kind: AuthWorkerInfraKind): number {
  return kind === 'unset' ? HTTP_SERVICE_UNAVAILABLE : HTTP_BAD_GATEWAY;
}

export const AUTH_WORKER_UNAVAILABLE_BODY = {
  error: 'Authentication service temporarily unavailable.',
  code: 'AUTH_WORKER_UNAVAILABLE'
} as const;


/** Trimmed base URL or `null` when the worker is not configured. */
export function authWorkerBaseUrl(): string | null {
  const raw = String(process.env.GENESIS_AUTH_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function requireAuthBase(): string {
  const base = authWorkerBaseUrl();
  if (!base) {
    throw new Error(AUTH_WORKER_UNSET_ERROR);
  }
  return base;
}

async function postAuth(path: string, body: unknown): Promise<{ status: number; obj: Record<string, unknown> | null; error?: string }> {
  const base = authWorkerBaseUrl();
  if (!base) {
    return { status: 0, obj: null, error: AUTH_WORKER_UNSET_ERROR };
  }
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_PROGRESS_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return { status: res.status, obj: null, error: `auth worker non-JSON (${res.status})` };
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: res.status, obj: null, error: res.ok ? 'auth worker empty body' : `auth worker HTTP ${res.status}` };
    }
    return { status: res.status, obj: parsed as Record<string, unknown> };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, obj: null, error: `auth worker unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function readOptionalFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return undefined;
}

export async function callAuthPasswordHash(password: string, rounds: number): Promise<AuthPasswordHashResult> {
  const { status, obj, error } = await postAuth(PASSWORD_HASH_PATH, { password, rounds });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return {
      ok: false,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`
    };
  }
  const hash = readOptionalString(obj.hash);
  if (!hash) return { ok: false, error: 'auth worker missing hash' };
  return { ok: true, hash };
}

export async function callAuthPasswordVerify(password: string, hash: string): Promise<AuthPasswordVerifyResult> {
  const { status, obj, error } = await postAuth(PASSWORD_VERIFY_PATH, { password, hash });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return {
      ok: false,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`
    };
  }
  return { ok: true, match: obj.match === true };
}

export async function callAuthJwtSign(userId: number | string): Promise<AuthJwtSignResult> {
  const { status, obj, error } = await postAuth(JWT_SIGN_PATH, { userId });
  if (error) return { ok: false, error, errorName: 'JsonWebTokenError' };
  if (!obj) return { ok: false, error: 'auth worker empty body', errorName: 'JsonWebTokenError' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return {
      ok: false,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`,
      errorName: readOptionalString(obj.errorName) ?? 'JsonWebTokenError'
    };
  }
  const token = readOptionalString(obj.token);
  if (!token) return { ok: false, error: 'auth worker missing token', errorName: 'JsonWebTokenError' };
  const expiresInSec = readOptionalFiniteNumber(obj.expiresInSec);
  if (expiresInSec == null || expiresInSec <= 0) {
    return { ok: false, error: 'auth worker missing expiresInSec', errorName: 'JsonWebTokenError' };
  }
  return { ok: true, token, expiresInSec };
}

export async function callAuthJwtVerify(token: string): Promise<AuthJwtVerifyResult> {
  const { status, obj, error } = await postAuth(JWT_VERIFY_PATH, { token });
  if (error) return { ok: false, error, errorName: 'JsonWebTokenError' };
  if (!obj) return { ok: false, error: 'auth worker empty body', errorName: 'JsonWebTokenError' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return {
      ok: false,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`,
      errorName: readOptionalString(obj.errorName) ?? 'JsonWebTokenError'
    };
  }
  const userId = readOptionalFiniteNumber(obj.userId);
  if (userId == null || userId <= 0) {
    return { ok: false, error: 'auth worker missing userId', errorName: 'JsonWebTokenError' };
  }
  return {
    ok: true,
    userId,
    jti: readOptionalString(obj.jti),
    exp: readOptionalFiniteNumber(obj.exp)
  };
}

/**
 * Turnstile siteverify via worker (worker owns enabled gate).
 * Unset URL / transport → mapped infra status (503/502).
 */
export async function callAuthTurnstileVerify(opts: {
  token: string;
  remoteip?: string;
}): Promise<AuthTurnstileVerifyResult> {
  const body: { token: string; remoteip?: string } = { token: opts.token };
  if (opts.remoteip) body.remoteip = opts.remoteip;
  const { status, obj, error } = await postAuth(TURNSTILE_VERIFY_PATH, body);
  if (error) {
    const kind = classifyAuthWorkerError(error);
    const mapped = kind ? authWorkerInfraHttpStatus(kind) : HTTP_BAD_GATEWAY;
    return { ok: false, status: mapped, error };
  }
  if (!obj) return { ok: false, status: HTTP_BAD_GATEWAY, error: 'auth worker empty body' };
  if (status === HTTP_OK && obj.ok === true) return { ok: true };
  const errMsg = readOptionalString(obj.error) ?? `auth worker HTTP ${status}`;
  const mappedStatus =
    status === HTTP_BAD_REQUEST || status === HTTP_BAD_GATEWAY || status === HTTP_SERVICE_UNAVAILABLE
      ? status
      : status >= HTTP_SERVER_ERROR_FLOOR
        ? HTTP_BAD_GATEWAY
        : HTTP_BAD_REQUEST;
  return { ok: false, status: mappedStatus, error: errMsg };
}

export async function callAuthMailReset(opts: {
  email: string;
  resetToken: string;
  validityMinutes?: number;
}): Promise<AuthMailResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(MAIL_RESET_PATH, {
    email: opts.email,
    resetToken: opts.resetToken,
    validityMinutes: opts.validityMinutes
  });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  return { ok: true };
}

export async function callAuthMailVerify(opts: {
  email: string;
  verificationToken: string;
  validityHours?: number;
}): Promise<AuthMailResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(MAIL_VERIFY_PATH, {
    email: opts.email,
    verificationToken: opts.verificationToken,
    validityHours: opts.validityHours
  });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  return { ok: true };
}

function readOptionalObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as Record<string, unknown>;
}

function parseSessionUser(raw: unknown): AuthSessionUserPayload | null {
  const obj = readOptionalObject(raw);
  if (!obj) return null;
  const id = readOptionalFiniteNumber(obj.id);
  const username = readOptionalString(obj.username);
  const email = readOptionalString(obj.email);
  if (id == null || id <= 0 || !username || !email) return null;
  return {
    id,
    username,
    email,
    isAdmin: readOptionalFiniteNumber(obj.isAdmin) ?? null,
    isSuperAdmin: readOptionalFiniteNumber(obj.isSuperAdmin),
    polygonWallet: readOptionalString(obj.polygonWallet) ?? null,
    isBlocked: readOptionalFiniteNumber(obj.isBlocked) ?? null,
    accessLevelId: readOptionalString(obj.accessLevelId) ?? null,
    referralCode: readOptionalString(obj.referralCode) ?? null,
    referredBy: readOptionalString(obj.referredBy) ?? null,
    lastActiveAtMs: readOptionalFiniteNumber(obj.lastActiveAtMs) ?? null,
    rankingExcluded: readOptionalFiniteNumber(obj.rankingExcluded) ?? null,
    registrationIp: readOptionalString(obj.registrationIp) ?? null,
    adminPermissions: readOptionalString(obj.adminPermissions) ?? null,
    emailVerificationRequired: readOptionalFiniteNumber(obj.emailVerificationRequired),
    emailVerified: readOptionalFiniteNumber(obj.emailVerified),
    loginFailureCount: readOptionalFiniteNumber(obj.loginFailureCount),
    loginLockedUntilMs: readOptionalFiniteNumber(obj.loginLockedUntilMs) ?? null
  };
}

export async function callAuthSessionCreate(opts: {
  userId: number;
  sessionId: string;
  expiresAtMs: number;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthSessionMutateResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(SESSION_CREATE_PATH, {
    userId: opts.userId,
    sessionId: opts.sessionId,
    expiresAtMs: opts.expiresAtMs,
    userAgent: opts.userAgent ?? undefined,
    ip: opts.ip ?? undefined
  });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  return { ok: true, userId: readOptionalFiniteNumber(obj.userId) };
}

export async function callAuthSessionLoad(opts: {
  sessionId: string;
  includeExpired?: boolean;
}): Promise<AuthSessionLoadResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(SESSION_LOAD_PATH, {
    sessionId: opts.sessionId,
    includeExpired: opts.includeExpired === true
  });
  if (error) {
    const kind = classifyAuthWorkerError(error);
    const mapped = kind ? authWorkerInfraHttpStatus(kind) : HTTP_BAD_GATEWAY;
    return { ok: false, status: mapped, error };
  }
  if (!obj) return { ok: false, status: HTTP_BAD_GATEWAY, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    const mapped = status === HTTP_UNAUTHORIZED ? HTTP_UNAUTHORIZED : status >= HTTP_SERVER_ERROR_FLOOR ? HTTP_BAD_GATEWAY : status;
    return {
      ok: false,
      status: mapped || HTTP_BAD_GATEWAY,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`
    };
  }
  const userId = readOptionalFiniteNumber(obj.userId);
  const sessionId = readOptionalString(obj.sessionId);
  const createdAtMs = readOptionalFiniteNumber(obj.createdAtMs);
  const expiresAtMs = readOptionalFiniteNumber(obj.expiresAtMs);
  const user = parseSessionUser(obj.user);
  if (userId == null || userId <= 0 || !sessionId || createdAtMs == null || expiresAtMs == null || !user) {
    return { ok: false, status: HTTP_BAD_GATEWAY, error: 'auth worker missing session payload' };
  }
  return {
    ok: true,
    userId,
    sessionId,
    createdAtMs,
    expiresAtMs,
    originalUserId: readOptionalFiniteNumber(obj.originalUserId) ?? null,
    lastSeenAtMs: readOptionalFiniteNumber(obj.lastSeenAtMs) ?? null,
    managerMode: readOptionalFiniteNumber(obj.managerMode),
    actingAsOwnerId: readOptionalFiniteNumber(obj.actingAsOwnerId) ?? null,
    user
  };
}

export async function callAuthSessionDelete(opts: { sessionId: string }): Promise<AuthSessionMutateResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(SESSION_DELETE_PATH, { sessionId: opts.sessionId });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  return { ok: true, userId: readOptionalFiniteNumber(obj.userId) };
}

export async function callAuthSessionDeleteByUser(opts: {
  userId?: number;
  userIds?: number[];
}): Promise<AuthSessionDeleteByUserResult> {
  requireAuthBase();
  const body: { userId?: number; userIds?: number[] } = {};
  if (opts.userId != null) body.userId = opts.userId;
  if (opts.userIds != null) body.userIds = opts.userIds;
  const { status, obj, error } = await postAuth(SESSION_DELETE_BY_USER_PATH, body);
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  const deletedCount = readOptionalFiniteNumber(obj.deletedCount);
  if (deletedCount == null) {
    return { ok: false, error: 'auth worker missing deletedCount' };
  }
  return { ok: true, deletedCount };
}

export async function callAuthSessionUpdateFlags(opts: {
  sessionId?: string;
  userId?: number;
  originalUserId?: number | null;
  managerMode?: number;
  actingAsOwnerId?: number | null;
  restoreUserIdFromOriginal?: boolean;
  matchOriginalUserId?: number | null;
  matchActingAsOwnerId?: number | null;
}): Promise<AuthSessionUpdateFlagsResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(SESSION_UPDATE_FLAGS_PATH, {
    sessionId: opts.sessionId,
    userId: opts.userId,
    originalUserId: opts.originalUserId === undefined ? undefined : opts.originalUserId,
    managerMode: opts.managerMode,
    actingAsOwnerId: opts.actingAsOwnerId === undefined ? undefined : opts.actingAsOwnerId,
    restoreUserIdFromOriginal: opts.restoreUserIdFromOriginal === true,
    matchOriginalUserId: opts.matchOriginalUserId === undefined ? undefined : opts.matchOriginalUserId,
    matchActingAsOwnerId: opts.matchActingAsOwnerId === undefined ? undefined : opts.matchActingAsOwnerId
  });
  if (error) {
    const kind = classifyAuthWorkerError(error);
    const mapped = kind ? authWorkerInfraHttpStatus(kind) : HTTP_BAD_GATEWAY;
    return { ok: false, status: mapped, error };
  }
  if (!obj) return { ok: false, status: HTTP_BAD_GATEWAY, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    const mapped =
      status === HTTP_UNAUTHORIZED || status === HTTP_BAD_REQUEST
        ? status
        : status >= HTTP_SERVER_ERROR_FLOOR
          ? HTTP_BAD_GATEWAY
          : status || HTTP_BAD_GATEWAY;
    return {
      ok: false,
      status: mapped,
      error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}`
    };
  }
  return {
    ok: true,
    sessionId: readOptionalString(obj.sessionId),
    userId: readOptionalFiniteNumber(obj.userId),
    originalUserId: readOptionalFiniteNumber(obj.originalUserId) ?? null,
    managerMode: readOptionalFiniteNumber(obj.managerMode),
    actingAsOwnerId: readOptionalFiniteNumber(obj.actingAsOwnerId) ?? null
  };
}

export async function callAuthRefreshIssue(opts: {
  userId: number;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthRefreshIssueResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(REFRESH_ISSUE_PATH, {
    userId: opts.userId,
    userAgent: opts.userAgent ?? undefined,
    ip: opts.ip ?? undefined
  });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  const refreshToken = readOptionalString(obj.refreshToken);
  const expiresAtMs = readOptionalFiniteNumber(obj.expiresAtMs);
  const expiresInSec = readOptionalFiniteNumber(obj.expiresInSec);
  if (!refreshToken || expiresAtMs == null || expiresInSec == null || expiresInSec <= 0) {
    return { ok: false, error: 'auth worker missing refresh issue payload' };
  }
  return { ok: true, refreshToken, expiresAtMs, expiresInSec };
}

export async function callAuthRefreshRotate(opts: {
  refreshToken: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthRefreshRotateResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(REFRESH_ROTATE_PATH, {
    refreshToken: opts.refreshToken,
    userAgent: opts.userAgent ?? undefined,
    ip: opts.ip ?? undefined
  });
  if (error) throw new Error(error);
  if (!obj) throw new Error('auth worker empty body');
  if (status === HTTP_UNAUTHORIZED) {
    const codeRaw = readOptionalString(obj.code);
    const code = codeRaw === 'expired' ? 'expired' : 'invalid';
    return { ok: false, code, error: readOptionalString(obj.error) };
  }
  if (status !== HTTP_OK || obj.ok !== true) {
    throw new Error(readOptionalString(obj.error) ?? `auth worker HTTP ${status}`);
  }
  const userId = readOptionalFiniteNumber(obj.userId);
  const refreshToken = readOptionalString(obj.refreshToken);
  const expiresInSec = readOptionalFiniteNumber(obj.expiresInSec);
  if (userId == null || userId <= 0 || !refreshToken || expiresInSec == null || expiresInSec <= 0) {
    throw new Error('auth worker missing refresh rotate payload');
  }
  return { ok: true, userId, refreshToken, expiresInSec };
}

export async function callAuthRefreshRevoke(opts: { userId: number }): Promise<AuthRefreshRevokeResult> {
  requireAuthBase();
  const { status, obj, error } = await postAuth(REFRESH_REVOKE_PATH, { userId: opts.userId });
  if (error) return { ok: false, error };
  if (!obj) return { ok: false, error: 'auth worker empty body' };
  if (status !== HTTP_OK || obj.ok !== true) {
    return { ok: false, error: readOptionalString(obj.error) ?? `auth worker HTTP ${status}` };
  }
  return { ok: true };
}

/**
 * bcryptjs-shaped shim for controllers that still inject `bcrypt` via deps.
 * Fail-closed: unset URL or worker error → throw.
 */
export const authWorkerBcrypt = {
  async hash(password: string, rounds: number): Promise<string> {
    requireAuthBase();
    const r = await callAuthPasswordHash(password, rounds);
    if (!r.ok || !r.hash) {
      throw new Error(r.error ?? 'auth password hash failed');
    }
    return r.hash;
  },
  async compare(password: string, hash: string): Promise<boolean> {
    requireAuthBase();
    const r = await callAuthPasswordVerify(password, hash);
    if (!r.ok) {
      throw new Error(r.error ?? 'auth password verify failed');
    }
    return r.match === true;
  }
};
