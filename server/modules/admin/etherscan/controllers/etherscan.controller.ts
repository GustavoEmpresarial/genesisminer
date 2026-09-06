/**
 * GET `/api/admin/etherscan/treasury-token-txs` — proxy Etherscan tokentx.
 *
 * Auth: `isAdmin` + tab `reports`. Não devolve a API key.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  respondIfHttpControlledError,
  sendInternalErrorSafeMessageOrPrisma
} from '../../../../core/http/error-response.js';
import { getTreasuryTokenTxs } from '../services/treasury-token-txs.js';

export type AdminEtherscanModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminEtherscanModuleRoutes(app: Express, deps: AdminEtherscanModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/etherscan/treasury-token-txs', isAdmin, async (req: Request, res: Response) => {
    try {
      const data = await getTreasuryTokenTxs({
        page: req.query.page,
        offset: req.query.offset,
        address: req.query.address
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(
        res,
        'GET /api/admin/etherscan/treasury-token-txs',
        e,
        'Could not load treasury token transactions.'
      );
    }
  });
}
