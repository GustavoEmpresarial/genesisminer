/**
 * POST/PUT/DELETE `/api/admin/transparency*`.
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `transparency`.
 * GET público `/api/transparency` fica em `modules/transparency` (jogador).
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  respondIfHttpControlledError,
  sendInternalErrorSafeMessageOrPrisma
} from '../../../../core/http/error-response.js';
import {
  createTransparencyEntry,
  deleteTransparencyEntry,
  updateTransparencyEntry
} from '../services/admin-transparency.js';

export type AdminTransparencyModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminTransparencyModuleRoutes(app: Express, deps: AdminTransparencyModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/transparency', isAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await createTransparencyEntry(req.body));
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/transparency', e, 'Could not create transparency entry.');
    }
  });

  app.put('/api/admin/transparency/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await updateTransparencyEntry(req.params.id, req.body));
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT /api/admin/transparency/:id', e, 'Could not update transparency entry.');
    }
  });

  app.delete('/api/admin/transparency/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await deleteTransparencyEntry(req.params.id));
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/transparency/:id', e, 'Could not delete transparency entry.');
    }
  });
}
