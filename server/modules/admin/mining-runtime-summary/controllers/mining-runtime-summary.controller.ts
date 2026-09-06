/**
 * Snapshot admin do runtime de mineração (`GET /api/admin/mining-runtime-summary`).
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `reports`.
 * Sem query params. Não dispara yield nem scheduler.
 * Com worker Rust: hidrata Maps from `app_cache.network_stats` antes de ler.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { hydrateMiningRuntimeStatsFromAppCache } from '../../../mining-engine/services/runtime-stats.js';
import { getMiningRuntimeSummary } from '../services/mining-runtime-summary.js';

export type AdminMiningRuntimeSummaryModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminMiningRuntimeSummaryModuleRoutes(
  app: Express,
  deps: AdminMiningRuntimeSummaryModuleDeps
): void {
  const { isAdmin } = deps;

  app.get('/api/admin/mining-runtime-summary', isAdmin, async (_req: Request, res: Response) => {
    try {
      await hydrateMiningRuntimeStatsFromAppCache(pool);
      res.json(getMiningRuntimeSummary());
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(
        res,
        'GET /api/admin/mining-runtime-summary',
        e,
        'Could not load mining runtime summary.'
      );
    }
  });
}
