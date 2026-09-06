/**
 * GET admin `/api/admin/monetization-settings` (com secret).
 *
 * Migrado de `legacy/backend/server.ts`. O GET público `/api/monetization-settings`
 * (sem secret) e o POST (tab `settings:monetization`) são do genesis-api
 * (`admin_tabs` → mining-worker `/v1/settings/monetization/persist`).
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { loadMonetizationSettings } from '../services/monetization-settings.js';

export type AdminMonetizationSettingsModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminMonetizationSettingsModuleRoutes(
  app: Express,
  deps: AdminMonetizationSettingsModuleDeps
): void {
  const { isAdmin } = deps;

  app.get('/api/admin/monetization-settings', isAdmin, async (_req: Request, res: Response) => {
    try {
      const settings = await loadMonetizationSettings();
      res.setHeader('Cache-Control', 'no-store');
      res.json(settings);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(
        res,
        'GET /api/admin/monetization-settings',
        e,
        'Could not load monetization settings.'
      );
    }
  });
}
