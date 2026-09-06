/**
 * CRUD/reorder admin do guia (`/api/admin/guide/...`).
 * Player GET `/api/guide` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import {
  createGuideCategory,
  createGuidePage,
  deleteGuideCategory,
  deleteGuidePage,
  listGuideAdmin,
  reorderGuideCategories,
  reorderGuidePages,
  updateGuideCategory,
  updateGuidePage
} from '../services/guide.js';

export type GuideModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_NOT_FOUND = 404;
const HTTP_CREATED = 201;

export function registerGuideModuleRoutes(app: Express, deps: GuideModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/guide', isAdmin, async (_req: Request, res: Response) => {
    try {
      const categories = await listGuideAdmin();
      res.json({ ok: true, categories });
    } catch (e) {
      console.error('[GET /api/admin/guide]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/guide', e, 'Erro ao carregar guia (admin).');
    }
  });

  app.post('/api/admin/guide/categories', isAdmin, async (req: Request, res: Response) => {
    try {
      const row = await createGuideCategory(req.body || {});
      res.status(HTTP_CREATED).json({ ok: true, category: row });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/guide/categories', e, 'Erro ao criar categoria.');
    }
  });

  app.put('/api/admin/guide/categories/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const row = await updateGuideCategory(String(req.params.id), req.body || {});
      res.json({ ok: true, category: row });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT guide category', e, 'Erro ao atualizar categoria.');
    }
  });

  app.delete('/api/admin/guide/categories/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const ok = await deleteGuideCategory(String(req.params.id));
      if (!ok) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Category not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE guide category', e, 'Erro ao apagar categoria.');
    }
  });

  app.post('/api/admin/guide/categories/reorder', isAdmin, async (req: Request, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(String) : [];
      await reorderGuideCategories(ids);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/guide/categories/reorder', e, 'Erro ao reordenar categorias.');
    }
  });

  app.post('/api/admin/guide/pages', isAdmin, async (req: Request, res: Response) => {
    try {
      const row = await createGuidePage(req.body || {});
      res.status(HTTP_CREATED).json({ ok: true, page: row });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/guide/pages', e, 'Erro ao criar página.');
    }
  });

  app.put('/api/admin/guide/pages/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const row = await updateGuidePage(String(req.params.id), req.body || {});
      res.json({ ok: true, page: row });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT guide page', e, 'Erro ao atualizar página.');
    }
  });

  app.delete('/api/admin/guide/pages/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      const ok = await deleteGuidePage(String(req.params.id));
      if (!ok) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Page not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE guide page', e, 'Erro ao apagar página.');
    }
  });

  app.post('/api/admin/guide/pages/reorder', isAdmin, async (req: Request, res: Response) => {
    try {
      const categoryId = String(req.body?.categoryId || '');
      const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(String) : [];
      await reorderGuidePages(categoryId, ids);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/guide/pages/reorder', e, 'Erro ao reordenar páginas.');
    }
  });
}
