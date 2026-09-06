/**
 * Admin promo codes — callers: AdminMonetization + AdminLootBoxes.
 *
 * Permissões (mapa em `shared/security/admin-route-auth.ts`, aplicado pelo
 * middleware `isAdmin` a partir do path — não declaradas rota a rota aqui):
 *
 * GET/POST `/api/admin/promo-codes` — anyOf: settings:monetization | lootboxes
 * DELETE `/api/admin/promo-codes/:code` — anyOf: settings:monetization | lootboxes
 * PUT `/api/admin/promo-codes/:code/toggle` — anyOf: settings:monetization | lootboxes
 * POST `/api/admin/promo-codes/bulk-delete` — super
 *
 * `lootboxes` entra no anyOf porque os códigos promo têm `loot_box_id` e o ecrã
 * de Lucky Boxes consome esta API directamente.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  respondIfHttpControlledError,
  sendInternalErrorSafeMessageOrPrisma
} from '../../../../core/http/error-response.js';
import {
  bulkDeletePromoCodes,
  deletePromoCode,
  listPromoCodes,
  togglePromoCode,
  upsertPromoCode
} from '../services/promo-codes.js';

export type AdminPromoCodesModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminPromoCodesModuleRoutes(app: Express, deps: AdminPromoCodesModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/promo-codes', isAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await listPromoCodes());
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/promo-codes', e, 'Could not load promo codes.');
    }
  });

  app.post('/api/admin/promo-codes', isAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await upsertPromoCode(req.body));
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/promo-codes', e, 'Could not save promo code.');
    }
  });

  app.post('/api/admin/promo-codes/bulk-delete', isAdmin, async (req: Request, res: Response) => {
    try {
      const raw = (req.body as { codes?: unknown } | undefined)?.codes;
      res.json(await bulkDeletePromoCodes(raw));
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/promo-codes/bulk-delete', e, 'Could not delete promo codes.');
    }
  });

  app.delete('/api/admin/promo-codes/:code', isAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await deletePromoCode(String(req.params.code || '')));
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/promo-codes/:code', e, 'Could not delete promo code.');
    }
  });

  app.put('/api/admin/promo-codes/:code/toggle', isAdmin, async (req: Request, res: Response) => {
    try {
      const isActive = (req.body as { isActive?: unknown } | undefined)?.isActive;
      res.json(await togglePromoCode(String(req.params.code || ''), isActive));
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT /api/admin/promo-codes/:code/toggle', e, 'Could not toggle promo code.');
    }
  });
}
