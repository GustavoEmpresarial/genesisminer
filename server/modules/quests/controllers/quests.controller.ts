/**
 * Admin quests (`/api/admin/quests`).
 * Player `/api/quests/*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import {
  ensureQuestSchema,
  listAllQuestDefinitionsAdmin,
  saveQuestDefinitionAdmin
} from '../services/quest.js';

export type QuestsModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_NOT_FOUND = 404;

export function registerQuestsModuleRoutes(app: Express, deps: QuestsModuleDeps): void {
  const { isAdmin } = deps;

  void ensureQuestSchema().catch((e) => {
    console.warn('[quests] ensureQuestSchema boot:', e instanceof Error ? e.message : e);
  });

  app.get('/api/admin/quests', isAdmin, async (_req: Request, res: Response) => {
    try {
      const definitions = await listAllQuestDefinitionsAdmin();
      res.json({ ok: true, definitions });
    } catch (e) {
      console.error('[GET /api/admin/quests]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/quests', e, 'Could not list quests.');
    }
  });

  app.post('/api/admin/quests', isAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const saved = await saveQuestDefinitionAdmin({
        id: String(body.id || ''),
        title: body.title,
        description: body.description,
        targetCount: body.targetCount ?? body.target_count,
        rewardUsdc: body.rewardUsdc ?? body.reward_usdc,
        sortOrder: body.sortOrder ?? body.sort_order,
        enabled: body.enabled
      });
      if (!saved) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Quest not found.', code: 'NOT_FOUND' });
        return;
      }
      res.json({ ok: true, definition: saved });
    } catch (e) {
      console.error('[POST /api/admin/quests]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/quests', e, 'Could not save quest.');
    }
  });
}
