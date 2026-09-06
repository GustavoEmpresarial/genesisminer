/**
 * Leitura admin de ofertas P2P (`GET /api/admin/market/listings`).
 *
 * Migrado de `legacy/backend/server.ts`. Auth: `isAdmin` + tab `shops`.
 * Não altera listings, saldos nem compras.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { listAdminMarketListings } from '../services/market-listings.js';

export type AdminMarketListingsModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminMarketListingsModuleRoutes(app: Express, deps: AdminMarketListingsModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/market/listings', isAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await listAdminMarketListings();
      res.json(rows);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/market/listings', e, 'Could not load market listings.');
    }
  });
}
