/**
 * GET `/api/admin/recall-scan` — read-only.
 * Auth: `isAdmin` + tab `backup`. Sem query params.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { scanRecallInstalledItems } from '../services/recall-scan.js';

export type AdminRecallScanModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminRecallScanModuleRoutes(app: Express, deps: AdminRecallScanModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/recall-scan', isAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await scanRecallInstalledItems());
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/recall-scan', e, 'Could not scan installed items.');
    }
  });
}
