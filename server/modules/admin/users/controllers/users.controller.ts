/**
 * Rotas da aba Usuários que continuam no Express:
 * `GET /api/admin/users/:userId/wallet-history`, `POST /api/admin/users/:userId/save-game-override`,
 * `PUT /api/admin/users/:userId/rooms`, `POST /api/admin/impersonate`, `POST /api/admin/stop-impersonate`.
 *
 * As leftovers fora do prefixo `/api/admin` são do genesis-api (`admin_users`):
 * `GET /api/users`, `PUT /api/users/block`, `PUT /api/user`, `DELETE /api/user/:email`
 * → mining-worker `/v1/users/admin-*`; `GET /api/game-state/:email` → genesis-hardware
 * `/v1/game-state/by-email`. Os serviços `list.ts` / `update.ts` / `delete.ts` e
 * `loadAdminGameStateByEmail` seguem aqui como referência do contrato portado.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { rateLimit } from 'express-rate-limit';
import { getClientIpFromRequest } from '../../../../core/http/client-ip.js';
import {
  respondIfHttpControlledError,
  sendInternalErrorSafeMessageOrPrisma
} from '../../../../core/http/error-response.js';
import { parseRateLimit } from '../../../../core/http/rate-limit.js';
import { resolveRequestUserId as uidNum } from '../../../../core/http/request-user-id.js';
import { MS_PER_MINUTE } from '../../../../shared/utils/time.js';
import { loadAdminUserWalletHistory } from '../services/wallet-history.js';
import { startAdminImpersonate, stopAdminImpersonate } from '../services/impersonate.js';
import { applyAdminSaveGameOverride } from '../services/admin-game-state.js';
import { applyAdminOwnedRooms } from '../services/owned-rooms.js';

export type AdminUsersModuleDeps = {
  isAdmin: RequestHandler;
  authenticateToken: RequestHandler;
  pool: Pool;
  parseCookies: (req: Request) => Record<string, string>;
  issueJwtAuthCookies: (res: Response, userId: number, req: Request) => Promise<void>;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

/**
 * SPA admin dispara várias rotas sob o mesmo `usersLimiter` por perfil
 * (lista, game-state, wallet-history, etc.). Default 120/min esgotava ao abrir
 * tickets em sequência. Ajustável via `ADMIN_USERS_RATE_LIMIT_MAX`.
 */
export const ADMIN_USERS_RATE_LIMIT_DEFAULT = 600;
export const ADMIN_USERS_RATE_LIMIT_FLOOR = 120;
export const ADMIN_USERS_RATE_LIMIT_CEILING = 5000;

export function resolveAdminUsersRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return parseRateLimit(
    env.ADMIN_USERS_RATE_LIMIT_MAX,
    ADMIN_USERS_RATE_LIMIT_DEFAULT,
    ADMIN_USERS_RATE_LIMIT_FLOOR,
    ADMIN_USERS_RATE_LIMIT_CEILING
  );
}

const usersLimiter = rateLimit({
  windowMs: MS_PER_MINUTE,
  max: resolveAdminUsersRateLimitMax(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-users:${uidNum(req) ?? getClientIpFromRequest(req)}`,
  message: { error: 'Too many admin users requests.', code: 'RATE_LIMIT' }
});

function parseTargetUserId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function registerAdminUsersModuleRoutes(app: Express, deps: AdminUsersModuleDeps): void {
  const { isAdmin, authenticateToken, pool, parseCookies, issueJwtAuthCookies } = deps;

  app.get('/api/admin/users/:userId/wallet-history', isAdmin, usersLimiter, async (req: Request, res: Response) => {
    try {
      const payload = await loadAdminUserWalletHistory(req.params.userId);
      res.json(payload);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/users/:userId/wallet-history', e, 'Could not load wallet history.');
    }
  });

  /** Personificar jogador (Acessar Conta). JWT passa a ser do alvo. */
  app.post('/api/admin/impersonate', isAdmin, usersLimiter, async (req: Request, res: Response) => {
    try {
      const out = await startAdminImpersonate({
        adminUserId: uidNum(req) ?? 0,
        sessionId: parseCookies(req).sid,
        targetEmail: req.body?.targetEmail
      });
      await issueJwtAuthCookies(res, out.targetUserId, req);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/impersonate', e, 'Could not impersonate user.');
    }
  });

  /**
   * Sair da personificação. `authenticateToken` (não `isAdmin`): enquanto
   * personifica, o JWT é do alvo (não-admin).
   */
  app.post('/api/admin/stop-impersonate', authenticateToken, usersLimiter, async (req: Request, res: Response) => {
    try {
      const out = await stopAdminImpersonate({ sessionId: parseCookies(req).sid });
      await issueJwtAuthCookies(res, out.adminUserId, req);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/stop-impersonate', e, 'Could not stop impersonation.');
    }
  });

  /** Override admin: stock / placedRacks / usdc / coinBalances (sem conflict lastLoadTime). */
  app.post(
    '/api/admin/users/:userId/save-game-override',
    isAdmin,
    usersLimiter,
    async (req: Request, res: Response) => {
      const actorUserId = uidNum(req);
      if (!actorUserId) {
        res.status(HTTP_UNAUTHORIZED).json({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
        return;
      }
      const targetUserId = parseTargetUserId(req.params.userId);
      if (targetUserId == null) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Invalid user id.', code: 'VALIDATION' });
        return;
      }
      const changes =
        req.body?.changes && typeof req.body.changes === 'object' && !Array.isArray(req.body.changes)
          ? (req.body.changes as Record<string, unknown>)
          : {};
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      try {
        const out = await applyAdminSaveGameOverride({
          targetUserId,
          actorUserId,
          changes,
          reason,
          pool
        });
        res.json(out);
      } catch (e) {
        if (respondIfHttpControlledError(res, e)) return;
        sendInternalErrorSafeMessageOrPrisma(
          res,
          'POST /api/admin/users/:userId/save-game-override',
          e,
          'Could not save game override.'
        );
      }
    }
  );

  /** Grant/revoke de salas (`user_rig_rooms`) + devolver racks ao estoque. */
  app.put('/api/admin/users/:userId/rooms', isAdmin, usersLimiter, async (req: Request, res: Response) => {
    const targetUserId = parseTargetUserId(req.params.userId);
    if (targetUserId == null) {
      res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Invalid user id.', code: 'VALIDATION' });
      return;
    }
    const roomIdsRaw: unknown = req.body?.roomIds;
    if (!Array.isArray(roomIdsRaw) || !roomIdsRaw.every((id): id is string => typeof id === 'string')) {
      res.status(HTTP_BAD_REQUEST).json({
        ok: false,
        error: 'roomIds must be an array of strings.',
        code: 'VALIDATION'
      });
      return;
    }
    try {
      const out = await applyAdminOwnedRooms({
        userId: targetUserId,
        roomIds: roomIdsRaw,
        pool
      });
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(
        res,
        'PUT /api/admin/users/:userId/rooms',
        e,
        'Could not update owned rooms.'
      );
    }
  });
}
