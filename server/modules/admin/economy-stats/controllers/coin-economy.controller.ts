/**
 * AdminEconomy — apply hashrate/reward por moeda + sync live prices (stub consciente).
 *
 * `POST /api/admin/economy-settings` — atualiza `mining_coins.network_hashrate` / `block_reward`.
 * `POST /api/admin/mining-coins/sync-live-prices` — CoinGecko cosmético não portado (DECISIONS);
 * devolve erro explícito em JSON para o FE não cair em 404 HTML.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { prisma } from '../../../../core/database/prisma.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_IMPLEMENTED = 501;
const COIN_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

function round8(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e8) / 1e8;
}

export type AdminCoinEconomyModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerAdminCoinEconomyModuleRoutes(app: Express, deps: AdminCoinEconomyModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/economy-settings', isAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const coinId = typeof body.coinId === 'string' ? body.coinId.trim() : '';
      if (!coinId || !COIN_ID_RE.test(coinId)) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Invalid coinId.' });
        return;
      }
      const netRaw = Number(body.networkHashrate);
      const rewardRaw = Number(body.blockReward);
      if (!Number.isFinite(netRaw) || netRaw <= 0) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Invalid networkHashrate.' });
        return;
      }
      if (!Number.isFinite(rewardRaw) || rewardRaw < 0) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Invalid blockReward.' });
        return;
      }
      const networkHashrate = Math.max(1_000_000, round8(netRaw));
      const blockReward = round8(rewardRaw);
      const updated = await prisma.mining_coins.updateMany({
        where: { id: coinId },
        data: { network_hashrate: networkHashrate, block_reward: blockReward }
      });
      if (updated.count === 0) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Coin not found.' });
        return;
      }
      res.json({ ok: true, coinId, networkHashrate, blockReward });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/economy-settings', e, 'Could not update economy settings.');
    }
  });

  app.post('/api/admin/mining-coins/sync-live-prices', isAdmin, async (_req: Request, res: Response) => {
    res.status(HTTP_NOT_IMPLEMENTED).json({
      ok: false,
      updated: 0,
      error:
        'Sincronização de preços ao vivo (CoinGecko) não está disponível nesta build — enriquecimento cosmético não portado.'
    });
  });
}
