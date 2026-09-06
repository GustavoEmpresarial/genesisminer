/**
 * Acesso a dados de autenticação/sessão (users, user_access_levels,
 * user_history_ips via Prisma; sessions via `genesis-auth`).
 *
 * Migrado de legacy/backend/models/authModel.ts. Ajuste de import: `prisma` de
 * `core/database/prisma.ts`, `resolveRegistrationIp` de `core/http/client-ip.ts`.
 */
import type { users as UsersRow } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { resolveRegistrationIp } from '../../../core/http/client-ip.js';
import { generateReferralCode } from '../services/referral-code.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../../shared/utils/time.js';
import { rustLockoutStatus } from '../services/auth-rust-bridge.js';
import {
  callAuthSessionCreate,
  callAuthSessionDelete,
  callAuthSessionLoad,
  type AuthSessionLoadOk,
  type AuthSessionUserPayload
} from '../services/auth-worker-client.js';

export type DbUserRow = Record<string, unknown>;

function userToRow(u: UsersRow): DbUserRow {
  return {
    ...u,
    last_active_at: u.last_active_at != null ? Number(u.last_active_at) : null
  };
}

/** Busca case-insensitive por e-mail já normalizado (lowercase/trim feito pelo chamador). */
export async function findUserByEmail(normalizedEmail: string): Promise<DbUserRow | undefined> {
  const row = await prisma.users.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } }
  });
  return row ? userToRow(row) : undefined;
}

export async function findUserById(id: number): Promise<DbUserRow | undefined> {
  const row = await prisma.users.findUnique({ where: { id } });
  return row ? userToRow(row) : undefined;
}

const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCKOUT_MINUTES = 15;
const LOGIN_LOCKOUT_MS = LOGIN_LOCKOUT_MINUTES * MS_PER_MINUTE;

export async function recordLoginFailure(userId: number): Promise<void> {
  // Incremento atômico para evitar TOCTOU em requests concorrentes.
  const updated = await prisma.users.update({
    where: { id: userId },
    data: { login_failure_count: { increment: 1 } },
    select: { login_failure_count: true }
  });
  if (updated.login_failure_count >= LOGIN_MAX_FAILURES) {
    // Define lockout só ao atingir o limiar; sobrescreve se já bloqueado (reset do timer).
    await prisma.users.update({
      where: { id: userId },
      data: { login_locked_until: BigInt(Date.now() + LOGIN_LOCKOUT_MS) }
    });
  }
}

/** Zera o contador de falhas e remove qualquer bloqueio ativo — chamado após login bem-sucedido. */
export async function clearLoginFailures(userId: number): Promise<void> {
  await prisma.users.update({
    where: { id: userId },
    data: { login_failure_count: 0, login_locked_until: null }
  });
}

export function isAccountLocked(user: DbUserRow): boolean {
  const lockedUntil = user.login_locked_until != null ? Number(user.login_locked_until) : null;
  const rust = rustLockoutStatus(lockedUntil, Date.now());
  if (rust) return rust.locked;
  return lockedUntil !== null && Date.now() < lockedUntil;
}

export function accountLockRemainingSeconds(user: DbUserRow): number {
  const lockedUntil = user.login_locked_until != null ? Number(user.login_locked_until) : null;
  const rust = rustLockoutStatus(lockedUntil, Date.now());
  if (rust) return rust.remainingSeconds;
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil - Date.now()) / MS_PER_SECOND));
}

export async function updateUserPasswordHash(userId: string | number, hash: string): Promise<void> {
  await prisma.users.update({
    where: { id: Number(userId) },
    data: { password: hash }
  });
}

export async function recordLoginIp(userId: string | number, currentIp: string): Promise<void> {
  const uid = Number(userId);
  const ip = resolveRegistrationIp(currentIp);
  if (!ip) return;
  const now = BigInt(Date.now());
  await prisma.users.updateMany({
    where: { id: uid, registration_ip: null },
    data: { registration_ip: ip }
  });
  await prisma.user_history_ips.upsert({
    where: { user_id_ip: { user_id: uid, ip } },
    create: { user_id: uid, ip, last_used_at: now },
    update: { last_used_at: now }
  });
}

const REFERRAL_CODE_CLASH_RETRY_MAX = 10;

export async function ensureUserReferralCode(
  userId: string | number,
  username: string,
  existingCode: string | null | undefined
): Promise<string> {
  if (existingCode) return existingCode;
  const uid = Number(userId);
  let code = generateReferralCode(username);
  let tries = 0;
  while (tries < REFERRAL_CODE_CLASH_RETRY_MAX) {
    const clash = await prisma.users.findFirst({ where: { referral_code: code }, select: { id: true } });
    if (!clash) break;
    code = generateReferralCode(username);
    tries++;
  }
  await prisma.users.update({ where: { id: uid }, data: { referral_code: code } });
  return code;
}

const HTTP_UNAUTHORIZED = 401;

function sessionFromWorker(loaded: AuthSessionLoadOk): Record<string, unknown> {
  return {
    session_id: loaded.sessionId,
    user_id: loaded.userId,
    created_at: loaded.createdAtMs,
    expires_at: loaded.expiresAtMs,
    original_user_id: loaded.originalUserId ?? null,
    last_seen_at: loaded.lastSeenAtMs ?? null,
    manager_mode: loaded.managerMode ?? 0,
    acting_as_owner_id: loaded.actingAsOwnerId ?? null
  };
}

function userFromWorker(u: AuthSessionUserPayload): DbUserRow {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    is_admin: u.isAdmin ?? 0,
    is_super_admin: u.isSuperAdmin ?? 0,
    polygon_wallet: u.polygonWallet ?? null,
    is_blocked: u.isBlocked ?? 0,
    access_level_id: u.accessLevelId ?? null,
    referral_code: u.referralCode ?? null,
    referred_by: u.referredBy ?? null,
    last_active_at: u.lastActiveAtMs ?? null,
    ranking_excluded: u.rankingExcluded ?? null,
    registration_ip: u.registrationIp ?? null,
    admin_permissions: u.adminPermissions ?? null,
    email_verification_required: u.emailVerificationRequired ?? 0,
    email_verified: u.emailVerified ?? 0,
    login_failure_count: u.loginFailureCount ?? 0,
    login_locked_until: u.loginLockedUntilMs ?? null
  };
}

/** Cria a linha de sessão legada (`sid`) — persistência no `genesis-auth` (fail-closed). */
export async function insertSession(
  sessionId: string,
  userId: string | number,
  _createdAt: number,
  expiresAt: number
): Promise<void> {
  const r = await callAuthSessionCreate({
    userId: Number(userId),
    sessionId,
    expiresAtMs: expiresAt
  });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth session create failed');
  }
}

export async function loadSessionUser(
  sessionId: string
): Promise<{ session: Record<string, unknown>; user: DbUserRow } | null> {
  const r = await callAuthSessionLoad({ sessionId });
  if (!r.ok) {
    if (r.status === HTTP_UNAUTHORIZED) return null;
    throw new Error(r.error ?? 'auth session load failed');
  }
  return { session: sessionFromWorker(r), user: userFromWorker(r.user) };
}

/** Todos os níveis de acesso do utilizador (tabela many-to-many), garantindo que o nível primário está incluído. */
export async function listUserAccessLevelIds(userId: string | number, primaryLevelId: unknown): Promise<string[]> {
  const rows = await prisma.user_access_levels.findMany({
    where: { user_id: Number(userId) },
    select: { access_level_id: true }
  });
  const userLvlIds = rows.map((l) => l.access_level_id);
  if (primaryLevelId && !userLvlIds.includes(primaryLevelId as string)) {
    userLvlIds.push(primaryLevelId as string);
  }
  return userLvlIds;
}

/** Atualiza só a carteira Polygon; níveis de acesso vêm de compras/admin no servidor (não do body). */
export async function updateUserPolygonAndAccess(userId: string | number, polygonWallet: unknown): Promise<void> {
  if (polygonWallet !== undefined) {
    await prisma.users.update({
      where: { id: Number(userId) },
      data: { polygon_wallet: polygonWallet as string | null }
    });
  }
}

/** Remove o endereço Polygon do perfil (grava `polygon_wallet = null`). */
export async function clearUserPolygonWallet(userId: number): Promise<void> {
  await prisma.users.update({
    where: { id: userId },
    data: { polygon_wallet: null }
  });
}

/** Apaga a sessão legada pelo `session_id` — usado no logout. */
export async function deleteSessionBySessionId(sessionId: string): Promise<void> {
  const r = await callAuthSessionDelete({ sessionId });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth session delete failed');
  }
}

/** `user_id` da sessão válida (não expirada), ou `null`. */
export async function findActiveSessionUserId(sessionId: string): Promise<number | null> {
  const r = await callAuthSessionLoad({ sessionId });
  if (!r.ok) {
    if (r.status === HTTP_UNAUTHORIZED) return null;
    throw new Error(r.error ?? 'auth session load failed');
  }
  return r.userId;
}

/** Para logout / revogação JWT: devolve `user_id` mesmo se a sessão já expirou. */
export async function findSessionUserIdIgnoringExpiry(sessionId: string): Promise<number | null> {
  const r = await callAuthSessionLoad({ sessionId, includeExpired: true });
  if (!r.ok) {
    if (r.status === HTTP_UNAUTHORIZED) return null;
    throw new Error(r.error ?? 'auth session load failed');
  }
  return r.userId;
}

/** Metadados da sessão (inclui expiradas). */
export async function findSessionRow(sessionId: string): Promise<Record<string, unknown> | null> {
  const r = await callAuthSessionLoad({ sessionId, includeExpired: true });
  if (!r.ok) {
    if (r.status === HTTP_UNAUTHORIZED) return null;
    throw new Error(r.error ?? 'auth session load failed');
  }
  return sessionFromWorker(r);
}
