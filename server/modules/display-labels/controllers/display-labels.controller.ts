/**
 * POST `/api/admin/display-labels` — `isAdmin` + tab `settings:labels`.
 * Player GET owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { upsertBatch } from '../services/store.js';

export type DisplayLabelsModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;

export function registerDisplayLabelsModuleRoutes(app: Express, deps: DisplayLabelsModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/display-labels', isAdmin, async (req: Request, res: Response) => {
    const raw = req.body?.labels;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Campo "labels" (objeto) obrigatório.' });
      return;
    }
    try {
      const labels = await upsertBatch(raw as Record<string, unknown>);
      res.json({ ok: true, labels });
    } catch (e) {
      console.error('[POST /api/admin/display-labels]', e);
      res.status(HTTP_INTERNAL_SERVER_ERROR).json({ error: 'Erro ao salvar rótulos.' });
    }
  });
}
