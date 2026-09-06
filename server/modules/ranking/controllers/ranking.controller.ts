/**
 * Admin ranking (`/api/admin/ranking`).
 * Player `/api/ranking/*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import { getAdminMiningRankingPayload } from '../services/mining-ranking.js';

export type RankingModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerRankingModuleRoutes(app: Express, deps: RankingModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/ranking', isAdmin, async (_req: Request, res: Response) => {
    try {
      const payload = await getAdminMiningRankingPayload();
      res.json(payload);
    } catch (e) {
      console.error('Admin Ranking Error:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/ranking', e, 'Error fetching ranking.');
    }
  });
}
