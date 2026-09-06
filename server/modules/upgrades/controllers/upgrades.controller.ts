/**
 * Admin upgrades CRUD (`GET/POST/DELETE /api/admin-upgrades`).
 * Player `/api/upgrades/*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma, respondIfHttpControlledError } from '../../../core/http/error-response.js';
import { resolveRequestUserId as uidNum } from '../../../core/http/request-user-id.js';
import { deleteAdminUpgrade, upsertAdminUpgrade, type AdminUpgradeUpsertInput } from '../services/admin-crud.js';
import { loadAdminUpgradesForUser } from '../services/admin-upgrades-loader.js';

export type UpgradesModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerUpgradesModuleRoutes(app: Express, deps: UpgradesModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin-upgrades', isAdmin, async (req: Request, res: Response) => {
    try {
      const list = await loadAdminUpgradesForUser(uidNum(req) ?? undefined);
      res.json(list);
    } catch (e) {
      console.error('[GET /api/admin-upgrades]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin-upgrades', e, 'Não foi possível carregar os pacotes.');
    }
  });

  app.post('/api/admin-upgrades', isAdmin, async (req: Request, res: Response) => {
    try {
      await upsertAdminUpgrade((req.body ?? {}) as AdminUpgradeUpsertInput);
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[POST /api/admin-upgrades]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin-upgrades', e, 'Não foi possível guardar o pacote.');
    }
  });

  app.delete('/api/admin-upgrades/:id', isAdmin, async (req: Request, res: Response) => {
    try {
      await deleteAdminUpgrade(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      console.error('[DELETE /api/admin-upgrades/:id]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin-upgrades/:id', e, 'Não foi possível apagar o pacote.');
    }
  });
}
