/**
 * Conta existe e não está bloqueada.
 * `authenticateToken` só resolve `userId` — mutations devem chamar isto (DECISIONS #94).
 */
import type { Response } from 'express';
import { prisma } from '../../core/database/prisma.js';
import { callMiningWorkerAssertActiveUser } from '../../modules/mining-engine/services/mining-worker-client.js';

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const BLOCKED_FLAG = 1;

/**
 * Devolve `false` depois de já ter escrito a resposta HTTP (404/403) —
 * o caller deve `return` imediatamente.
 */
export async function requireActiveUser(userId: number, res: Response): Promise<boolean> {
  const u = await prisma.users.findUnique({ where: { id: userId }, select: { id: true, is_blocked: true } });
  if (!u) {
    res.status(HTTP_NOT_FOUND).json({ error: 'User not found.', code: 'NOT_FOUND' });
    return false;
  }
  if (u.is_blocked === BLOCKED_FLAG) {
    res.status(HTTP_FORBIDDEN).json({ error: 'Account blocked.', code: 'FORBIDDEN' });
    return false;
  }
  return true;
}

/**
 * Mesmo contrato HTTP que `requireActiveUser`, via mining-worker
 * `POST /v1/users/assert-active` (fail-closed).
 */
export async function requireActiveUserViaWorker(userId: number, res: Response): Promise<boolean> {
  const out = await callMiningWorkerAssertActiveUser(userId);
  if (out.ok) return true;
  res.status(out.status).json({ error: out.error, code: out.code });
  return false;
}
