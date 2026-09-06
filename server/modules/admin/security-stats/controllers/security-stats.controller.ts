/**
 * Rotas AdminSecurity: stats por secção + blacklist IP.
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `security`.
 * Bulk tools continuam em `admin/security-bulk`.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { addIpToBlacklist, loadSecurityStats, removeIpFromBlacklist } from '../services/security-stats.js';

export type AdminSecurityStatsModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminSecurityStatsModuleRoutes(app: Express, deps: AdminSecurityStatsModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/security/stats', isAdmin, async (req: Request, res: Response) => {
    try {
      const dto = await loadSecurityStats(pool, req.query.section);
      res.json(dto);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/security/stats', e, 'Could not load security stats.');
    }
  });

  app.post('/api/admin/security/blacklist', isAdmin, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await addIpToBlacklist({ ip: body.ip, reason: body.reason });
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/security/blacklist', e, 'Could not update blacklist.');
    }
  });

  app.delete('/api/admin/security/blacklist/:ip', isAdmin, async (req: Request, res: Response) => {
    try {
      const out = await removeIpFromBlacklist(req.params.ip);
      res.json(out);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/security/blacklist/:ip', e, 'Could not update blacklist.');
    }
  });
}
