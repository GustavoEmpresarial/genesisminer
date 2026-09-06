/**
 * Edição administrativa de conta (`PUT /api/user`).
 * Alvo = `id` do body (nunca a sessão). Flags admin/block ignoradas no payload.
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { mapPrismaClientError } from '../../../../shared/errors/prisma-errors.js';
import { validateLoginEmail } from '../../../auth/services/login-validation.js';
import { validatePasswordStrengthPolicy } from '../../../auth/services/password-policy.js';
import { resolveIsSuperAdminFromUserRow } from '../../../auth/services/super-admin.js';
import {
  BCRYPT_ROUNDS_PROFILE,
  authWorkerBcrypt
} from '../../../auth/services/auth-worker-client.js';
import {
  getConflictingUserIdByEmail,
  getConflictingUserIdByUsername,
  validateOptionalPolygonWallet,
  validateSignupUsername
} from '../../../auth/services/signup-validation.js';
import { isReservedProfileUsername, stripInvisibleUsernameChars } from '../../../profile/services/reserved-username.js';
import {
  appendUserWalletHistory,
  normalizeWalletCompareKey
} from '../../../profile/services/wallet-history.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const BLOCKED_FLAG = 1;

export type AdminUserUpdateResult = {
  id: number;
  username: string;
  email: string;
  polygonWallet?: string;
  accessLevelId?: string;
  accessLevelIds: string[];
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isBlocked: boolean;
};

export type UpdateAdminUserInput = {
  actorUserId: number;
  actorIsSuperAdmin: boolean;
  targetId: number;
  username: unknown;
  email: unknown;
  polygonWallet?: unknown;
  password?: unknown;
  accessLevelId: unknown;
  accessLevelIds: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  revokeJwtRefreshForUser: (userId: number) => Promise<void>;
};

function truthyFlag(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

function parseTargetAccessLevels(accessLevelIdRaw: unknown, accessLevelIdsRaw: unknown): {
  primary: string | null;
  ids: string[];
} {
  if (accessLevelIdsRaw !== undefined && accessLevelIdsRaw !== null && !Array.isArray(accessLevelIdsRaw)) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'accessLevelIds must be an array.', code: 'VALIDATION' });
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const x of Array.isArray(accessLevelIdsRaw) ? accessLevelIdsRaw : []) {
    const id = String(x ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  let primary = typeof accessLevelIdRaw === 'string' ? accessLevelIdRaw.trim() : String(accessLevelIdRaw ?? '').trim();
  if (!primary) primary = ids[0] ?? '';
  if (primary && !seen.has(primary)) {
    ids.unshift(primary);
    seen.add(primary);
  }
  return { primary: primary || null, ids };
}

export async function updateAdminUser(input: UpdateAdminUserInput): Promise<{ ok: true; user: AdminUserUpdateResult }> {
  const targetId = Math.floor(Number(input.targetId));
  if (!Number.isFinite(targetId) || targetId <= 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'User id is required.', code: 'VALIDATION' });
  }

  const target = await prisma.users.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      username: true,
      email: true,
      password: true,
      is_admin: true,
      is_super_admin: true,
      is_blocked: true,
      polygon_wallet: true,
      access_level_id: true
    }
  });
  if (!target) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'User not found.', code: 'NOT_FOUND' });
  }

  const targetIsAdmin = truthyFlag(target.is_admin);
  const targetIsSuper = resolveIsSuperAdminFromUserRow(target);
  const editingOther = input.actorUserId !== targetId;

  const rawUsername = stripInvisibleUsernameChars(typeof input.username === 'string' ? input.username : '');
  const vu = validateSignupUsername(rawUsername);
  if (!vu.ok) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: vu.error, code: 'VALIDATION' });
  }
  if (isReservedProfileUsername(vu.username)) {
    throw new HttpControlledError(HTTP_UNPROCESSABLE, {
      error: 'This username is reserved or not allowed.',
      code: 'USERNAME_RESERVED'
    });
  }

  const emailCheck = validateLoginEmail(input.email);
  if (!emailCheck.ok) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: emailCheck.error, code: 'VALIDATION' });
  }
  const nextEmail = String(input.email).trim().toLowerCase();
  const prevEmail = String(target.email || '').trim().toLowerCase();
  const emailChanging = nextEmail !== prevEmail;

  if (emailChanging && editingOther && targetIsAdmin && !input.actorIsSuperAdmin) {
    throw new HttpControlledError(HTTP_FORBIDDEN, {
      error: 'Only super administrators can change another administrator\'s email.',
      code: 'FORBIDDEN'
    });
  }

  const passwordRaw =
    typeof input.password === 'string' && input.password.trim().length > 0 ? input.password : null;
  if (passwordRaw && editingOther && targetIsSuper && !input.actorIsSuperAdmin) {
    throw new HttpControlledError(HTTP_FORBIDDEN, {
      error: 'Only super administrators can set a super administrator\'s password.',
      code: 'FORBIDDEN'
    });
  }
  if (passwordRaw) {
    const strength = validatePasswordStrengthPolicy(passwordRaw);
    if (!strength.ok) {
      throw new HttpControlledError(HTTP_UNPROCESSABLE, { error: strength.error, code: 'PASSWORD_WEAK' });
    }
  }

  const walletRaw = typeof input.polygonWallet === 'string' ? input.polygonWallet.trim() : '';
  const walletProvided = walletRaw.length > 0;
  let nextWallet: string | null | undefined;
  if (walletProvided) {
    const w = validateOptionalPolygonWallet(walletRaw);
    if (w && typeof w === 'object' && 'error' in w) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: w.error, code: 'VALIDATION' });
    }
    nextWallet = typeof w === 'string' ? w : null;
  }

  const levels = parseTargetAccessLevels(input.accessLevelId, input.accessLevelIds);
  if (levels.ids.length > 0) {
    const found = await prisma.access_levels.findMany({
      where: { id: { in: levels.ids } },
      select: { id: true }
    });
    const foundIds = new Set(found.map((r) => r.id));
    if (levels.ids.some((id) => !foundIds.has(id))) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, {
        error: 'One or more access levels do not exist.',
        code: 'VALIDATION'
      });
    }
  }

  const usernameChanging = vu.username.toLowerCase() !== String(target.username || '').toLowerCase();
  if (usernameChanging) {
    const clash = await getConflictingUserIdByUsername(vu.username, targetId);
    if (clash != null) {
      throw new HttpControlledError(HTTP_CONFLICT, { error: 'This username is already taken.', code: 'USERNAME_TAKEN' });
    }
  }
  if (emailChanging) {
    const clash = await getConflictingUserIdByEmail(nextEmail, targetId);
    if (clash != null) {
      throw new HttpControlledError(HTTP_CONFLICT, { error: 'This email is already in use.', code: 'EMAIL_TAKEN' });
    }
  }

  const walletChanging =
    walletProvided &&
    normalizeWalletCompareKey(nextWallet ?? null) !== normalizeWalletCompareKey(target.polygon_wallet);

  let passwordHash: string | null = null;
  if (passwordRaw) {
    passwordHash = await authWorkerBcrypt.hash(passwordRaw, BCRYPT_ROUNDS_PROFILE);
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (usernameChanging) {
        const updated = await tx.$executeRaw`
          UPDATE users SET username = ${vu.username}
           WHERE id = ${targetId}
             AND NOT EXISTS (
               SELECT 1 FROM users u2
                WHERE LOWER(u2.username) = LOWER(${vu.username}) AND u2.id <> ${targetId}
             )
        `;
        if (Number(updated) === 0) {
          throw new HttpControlledError(HTTP_CONFLICT, { error: 'This username is already taken.', code: 'USERNAME_TAKEN' });
        }
      }

      if (emailChanging) {
        const updated = await tx.$executeRaw`
          UPDATE users SET email = ${nextEmail}
           WHERE id = ${targetId}
             AND NOT EXISTS (
               SELECT 1 FROM users u2
                WHERE LOWER(u2.email) = LOWER(${nextEmail}) AND u2.id <> ${targetId}
             )
        `;
        if (Number(updated) === 0) {
          throw new HttpControlledError(HTTP_CONFLICT, { error: 'This email is already in use.', code: 'EMAIL_TAKEN' });
        }
      }

      const patch: {
        polygon_wallet?: string | null;
        password?: string;
        access_level_id?: string | null;
      } = {
        access_level_id: levels.primary
      };
      if (walletProvided) patch.polygon_wallet = nextWallet ?? null;
      if (passwordHash) patch.password = passwordHash;

      await tx.users.update({
        where: { id: targetId },
        data: patch
      });

      await tx.user_access_levels.deleteMany({ where: { user_id: targetId } });
      if (levels.ids.length > 0) {
        const now = BigInt(Date.now());
        await tx.user_access_levels.createMany({
          data: levels.ids.map((access_level_id) => ({
            user_id: targetId,
            access_level_id,
            granted_at: now
          }))
        });
      }

      if (walletChanging) {
        await appendUserWalletHistory(tx, {
          userId: targetId,
          action: 'admin_changed',
          walletAddress: nextWallet ?? null,
          previousWalletAddress: target.polygon_wallet,
          newWalletAddress: nextWallet ?? null,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          actorType: 'admin',
          actorUserId: input.actorUserId,
          source: 'PUT /api/user'
        });
      }
    });
  } catch (e) {
    if (e instanceof HttpControlledError) throw e;
    const mapped = mapPrismaClientError(e);
    if (mapped) throw new HttpControlledError(mapped.status, mapped.body);
    throw e;
  }

  if (passwordHash) {
    await input.revokeJwtRefreshForUser(targetId);
  }

  const grants = await prisma.user_access_levels.findMany({
    where: { user_id: targetId },
    select: { access_level_id: true }
  });
  const refreshed = await prisma.users.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      username: true,
      email: true,
      polygon_wallet: true,
      access_level_id: true,
      is_admin: true,
      is_super_admin: true,
      is_blocked: true
    }
  });
  if (!refreshed) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'User not found.', code: 'NOT_FOUND' });
  }

  const accessLevelId = refreshed.access_level_id ? String(refreshed.access_level_id) : undefined;
  const accessLevelIds = Array.from(
    new Set([...grants.map((g) => g.access_level_id), ...(accessLevelId ? [accessLevelId] : [])])
  );

  return {
    ok: true,
    user: {
      id: refreshed.id,
      username: String(refreshed.username ?? ''),
      email: String(refreshed.email ?? ''),
      polygonWallet: refreshed.polygon_wallet != null ? String(refreshed.polygon_wallet) : undefined,
      accessLevelId,
      accessLevelIds,
      isAdmin: truthyFlag(refreshed.is_admin),
      isSuperAdmin: resolveIsSuperAdminFromUserRow(refreshed),
      isBlocked: Number(refreshed.is_blocked) === BLOCKED_FLAG
    }
  };
}
