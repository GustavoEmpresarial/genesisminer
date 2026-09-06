/**
 * Admin wheel editor (`/api/admin/wheel/*`).
 * Player `/api/wheel/*` and `/api/roleta/*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import {
  addAdminWheelPlayer,
  fetchWheelPrizesForAdminWheelEditor,
  getAdminWheelRuntimeConfig,
  listAdminWheelPlayers,
  replaceWheelPrizesCatalog,
  upsertAdminWheelRuntimeConfig,
  type AdminWheelPrizeInput,
  type AdminWheelRuntimeConfigInput
} from '../services/admin.js';

export type WheelModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;

export function registerWheelModuleRoutes(app: Express, deps: WheelModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/wheel/config', isAdmin, async (_req: Request, res: Response) => {
    try {
      const items = await fetchWheelPrizesForAdminWheelEditor();
      res.json(items);
    } catch (e) {
      console.error('[GET /api/admin/wheel/config]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/wheel/config', e, 'Internal error.');
    }
  });

  app.post('/api/admin/wheel/config', isAdmin, async (req: Request, res: Response) => {
    const items = req.body;
    if (!Array.isArray(items)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Invalid prize list' });
      return;
    }
    try {
      await replaceWheelPrizesCatalog(items as AdminWheelPrizeInput[]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[POST /api/admin/wheel/config]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/wheel/config', e, 'Internal error.');
    }
  });

  app.get('/api/admin/wheel/runtime-config', isAdmin, async (_req: Request, res: Response) => {
    try {
      const cfg = await getAdminWheelRuntimeConfig();
      res.json(cfg);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[GET /api/admin/wheel/runtime-config]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/wheel/runtime-config', e, 'Internal error.');
    }
  });

  app.post('/api/admin/wheel/runtime-config', isAdmin, async (req: Request, res: Response) => {
    try {
      await upsertAdminWheelRuntimeConfig((req.body ?? {}) as AdminWheelRuntimeConfigInput);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[POST /api/admin/wheel/runtime-config]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/wheel/runtime-config', e, 'Internal error.');
    }
  });

  app.get('/api/admin/wheel/players', isAdmin, async (_req: Request, res: Response) => {
    try {
      const players = await listAdminWheelPlayers();
      res.json(players.map((p) => ({ username: p.username, added_at: p.addedAt })));
    } catch (e) {
      console.error('[GET /api/admin/wheel/players]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/wheel/players', e, 'Internal error.');
    }
  });

  app.post('/api/admin/wheel/players', isAdmin, async (req: Request, res: Response) => {
    try {
      await addAdminWheelPlayer(req.body?.username);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[POST /api/admin/wheel/players]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/wheel/players', e, 'Internal error.');
    }
  });
}
