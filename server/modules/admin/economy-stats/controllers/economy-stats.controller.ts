/**
 * Leitura admin da economia por moeda (`GET /api/admin/economy-stats`).
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `reports`.
 * Sem query params. Não altera saldos, yield nem racks.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { listEconomyStats } from '../services/economy-stats.js';

export type AdminEconomyStatsModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminEconomyStatsModuleRoutes(app: Express, deps: AdminEconomyStatsModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/economy-stats', isAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await listEconomyStats();
      res.json(rows);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/economy-stats', e, 'Could not load economy stats.');
    }
  });
}
