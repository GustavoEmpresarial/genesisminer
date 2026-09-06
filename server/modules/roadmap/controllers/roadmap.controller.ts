/**
 * CRUD admin do roadmap (`/api/admin/roadmap`).
 * Player GET `/api/roadmap` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import {
  createRoadmapStep,
  deleteRoadmapStep,
  listRoadmapAdmin,
  reorderRoadmapSteps,
  updateRoadmapStep
} from '../services/roadmap.js';

export type RoadmapModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_NOT_FOUND = 404;
const HTTP_CREATED = 201;

export function registerRoadmapModuleRoutes(app: Express, deps: RoadmapModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/roadmap', isAdmin, async (_req: Request, res: Response) => {
    try {
      const steps = await listRoadmapAdmin();
      res.json({ ok: true, steps });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/roadmap', e, 'Erro admin roadmap.');
    }
  });

  app.post('/api/admin/roadmap', isAdmin, async (req: Request, res: Response) => {
    try {
      const step = await createRoadmapStep(req.body || {});
      res.status(HTTP_CREATED).json({ ok: true, step });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/roadmap', e, 'Erro ao criar etapa.');
    }
  });

  app.put('/api/admin/roadmap/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const step = await updateRoadmapStep(String(req.params.id), req.body || {});
      res.json({ ok: true, step });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT roadmap', e, 'Erro ao atualizar etapa.');
    }
  });

  app.delete('/api/admin/roadmap/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const ok = await deleteRoadmapStep(String(req.params.id));
      if (!ok) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Milestone not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/roadmap/:id', e, 'Erro ao apagar etapa.');
    }
  });

  app.post('/api/admin/roadmap/reorder', isAdmin, async (req: Request, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(String) : [];
      await reorderRoadmapSteps(ids);
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/roadmap/reorder', e, 'Erro ao reordenar etapas.');
    }
  });
}
