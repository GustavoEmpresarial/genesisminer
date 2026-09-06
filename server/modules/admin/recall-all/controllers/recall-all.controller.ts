/**
 * POST `/api/admin/recall-all-players-items` — destrutivo, só super-admin.
 * Auth: `isAdmin` + `{ kind: 'super' }` em admin-route-auth.ts. Sem body/query.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { sendInternalErrorShapeOrPrisma } from '../../../../core/http/error-response.js';
import {
  emptyRecallAllReport,
  isRecallAllThrown,
  recallAllPlayersItems
} from '../services/recall-all.js';

export type AdminRecallAllModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminRecallAllModuleRoutes(app: Express, deps: AdminRecallAllModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/recall-all-players-items', isAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await recallAllPlayersItems(pool));
    } catch (e) {
      console.error('[RecallAll] Erro critico no fluxo:', e);
      const report = isRecallAllThrown(e) ? e.report : emptyRecallAllReport();
      sendInternalErrorShapeOrPrisma(
        res,
        'RecallAll',
        e,
        { ok: false, report },
        'Erro no fluxo. Consulta o relatório em anexo.'
      );
    }
  });
}
