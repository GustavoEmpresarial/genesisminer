/**
 * Rotas admin de saldo de moeda (`AdminRanking`).
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `users`
 * (`admin-route-auth.ts`). Não toca em deposit/withdraw/mining do jogador.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { bulkUpdateAdminCoinBalance, setAdminCoinBalance } from '../services/admin-coin-balance.js';

export type AdminCoinBalanceModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminCoinBalanceModuleRoutes(app: Express, deps: AdminCoinBalanceModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/update-coin-balance', isAdmin, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await setAdminCoinBalance(pool, {
        userId: body.userId,
        coinId: body.coinId,
        amount: body.amount
      });
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/update-coin-balance', e, 'Could not update coin balance.');
    }
  });

  app.post('/api/admin/bulk-update-coin-balance', isAdmin, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await bulkUpdateAdminCoinBalance(pool, {
        coinId: body.coinId,
        amount: body.amount
      });
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(
        res,
        'POST /api/admin/bulk-update-coin-balance',
        e,
        'Erro interno no servidor.'
      );
    }
  });
}
