/**
 * Rotas admin de saques (`GET /api/admin/withdrawals`, `POST /api/admin/withdrawals/status`).
 *
 * Migrado de `legacy/backend/server.ts` (isAdmin + super via admin-route-auth).
 * O jogador continua a usar `GET /api/withdrawals/history` e `POST /api/withdraw`.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { listAdminWithdrawals, updateAdminWithdrawalStatus } from '../services/admin-withdrawals.js';

export type AdminWithdrawalsModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminWithdrawalsModuleRoutes(app: Express, deps: AdminWithdrawalsModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/withdrawals', isAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await listAdminWithdrawals(pool);
      res.json(rows);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/withdrawals', e, 'Could not load withdrawals.');
    }
  });

  app.post('/api/admin/withdrawals/status', isAdmin, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await updateAdminWithdrawalStatus(pool, {
        requestId: body.requestId,
        status: body.status,
        txHash: body.txHash
      });
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/withdrawals/status', e, 'Could not update withdrawal.');
    }
  });
}
