/**
 * Admin "Acessar Conta" / personificação: troca `sessions.user_id` para o
 * alvo e guarda o admin em `original_user_id` (sem `manager_mode`).
 * Lookup do alvo só via `prisma.users.findFirst` — nunca `getUserIdByEmail`
 * (que criaria user se o email não existisse).
 * Sessão via `genesis-auth` (fail-closed).
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import {
  SESSION_MANAGER_MODE_OFF,
  callAuthSessionLoad,
  callAuthSessionUpdateFlags
} from '../../../auth/services/auth-worker-client.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const EMAIL_MAX = 254;

export type StartAdminImpersonateInput = {
  adminUserId: number;
  sessionId: string | null | undefined;
  targetEmail: unknown;
};

export type StopAdminImpersonateInput = {
  sessionId: string | null | undefined;
};

function normalizeSessionId(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeTargetEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

async function loadSessionOrThrow(
  sessionId: string,
  missing: { error: string }
): Promise<void> {
  const loaded = await callAuthSessionLoad({ sessionId, includeExpired: true });
  if (!loaded.ok) {
    if (loaded.status === HTTP_UNAUTHORIZED) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, missing);
    }
    throw new Error(loaded.error ?? 'auth session load failed');
  }
}

async function applySessionFlags(opts: {
  sessionId: string;
  userId: number;
  originalUserId: number | null;
}): Promise<void> {
  const updated = await callAuthSessionUpdateFlags({
    sessionId: opts.sessionId,
    userId: opts.userId,
    originalUserId: opts.originalUserId,
    managerMode: SESSION_MANAGER_MODE_OFF,
    actingAsOwnerId: null
  });
  if (!updated.ok) {
    if (updated.status === HTTP_UNAUTHORIZED) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Sessão inválida' });
    }
    throw new Error(updated.error ?? 'auth session update-flags failed');
  }
}

/**
 * Inicia personificação: sessão passa a actuar como o utilizador alvo.
 * @returns `targetUserId` para reemitir cookies JWT.
 */
export async function startAdminImpersonate(
  input: StartAdminImpersonateInput
): Promise<{ targetUserId: number }> {
  const sid = normalizeSessionId(input.sessionId);
  const adminUserId = Number(input.adminUserId);
  if (!sid || !Number.isFinite(adminUserId) || adminUserId <= 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, {
      error: 'Sessão necessária para personificação'
    });
  }

  await loadSessionOrThrow(sid, { error: 'Sessão inválida' });

  const email = normalizeTargetEmail(input.targetEmail);
  if (!email || email.length > EMAIL_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid target' });
  }

  const target = await prisma.users.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true }
  });
  if (!target || target.id === adminUserId) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid target' });
  }

  await applySessionFlags({
    sessionId: sid,
    userId: target.id,
    originalUserId: adminUserId
  });

  return { targetUserId: target.id };
}

/**
 * Termina personificação: restaura `user_id` do admin em `original_user_id`.
 * @returns `adminUserId` restaurado para reemitir cookies JWT.
 */
export async function stopAdminImpersonate(
  input: StopAdminImpersonateInput
): Promise<{ adminUserId: number }> {
  const sid = normalizeSessionId(input.sessionId);
  if (!sid) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Not impersonating' });
  }

  const loaded = await callAuthSessionLoad({ sessionId: sid, includeExpired: true });
  if (!loaded.ok) {
    if (loaded.status === HTTP_UNAUTHORIZED) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Not impersonating' });
    }
    throw new Error(loaded.error ?? 'auth session load failed');
  }
  const originalUid = loaded.originalUserId != null ? Number(loaded.originalUserId) : null;
  if (originalUid == null || !Number.isFinite(originalUid) || originalUid <= 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Not impersonating' });
  }

  await applySessionFlags({
    sessionId: sid,
    userId: originalUid,
    originalUserId: null
  });

  return { adminUserId: originalUid };
}
