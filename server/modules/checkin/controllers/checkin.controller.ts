/**
 * Admin check-in policies (`/api/admin/checkin-*-policy`).
 * Player `/api/checkin*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import { loadCheckinPremiumPolicy, saveCheckinPremiumPolicy } from '../services/premium-policy.js';
import { loadCheckinRewardPolicy, saveCheckinRewardPolicy } from '../services/reward-policy.js';

export type CheckinModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerCheckinModuleRoutes(app: Express, deps: CheckinModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/checkin-premium-policy', isAdmin, async (_req: Request, res: Response) => {
    try {
      const policy = await loadCheckinPremiumPolicy();
      res.json({ ok: true, ...policy });
    } catch (e) {
      console.error('[admin/checkin-premium-policy GET]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/checkin-premium-policy', e, 'Não foi possível ler a política de check-in premium.');
    }
  });

  app.post('/api/admin/checkin-premium-policy', isAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const policy = await saveCheckinPremiumPolicy({
        enabled: body.enabled !== undefined ? body.enabled !== false && body.enabled !== 0 : undefined,
        minUsdc: body.minUsdc ?? body.min_usdc,
        intervalDays: body.intervalDays ?? body.interval_days
      });
      res.json({ ok: true, ...policy });
    } catch (e) {
      console.error('[admin/checkin-premium-policy POST]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/checkin-premium-policy', e, 'Não foi possível guardar a política de check-in premium.');
    }
  });

  app.get('/api/admin/checkin-reward-policy', isAdmin, async (_req: Request, res: Response) => {
    try {
      const policy = await loadCheckinRewardPolicy();
      res.json({ ok: true, ...policy });
    } catch (e) {
      console.error('[admin/checkin-reward-policy GET]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/checkin-reward-policy', e, 'Não foi possível ler a política de recompensa do check-in.');
    }
  });

  app.post('/api/admin/checkin-reward-policy', isAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const policy = await saveCheckinRewardPolicy({
        rewardType: body.rewardType ?? body.reward_type,
        dailyRewardAmount: body.dailyRewardAmount ?? body.daily_reward_amount,
        weeklyRewardAmount: body.weeklyRewardAmount ?? body.weekly_reward_amount,
        rewardItemId: body.rewardItemId ?? body.reward_item_id,
        streakRewardEnabled: body.streakRewardEnabled ?? body.streak_reward_enabled,
        streakRewardItemId: body.streakRewardItemId ?? body.streak_reward_item_id,
        streakRewardDurationAmount: body.streakRewardDurationAmount ?? body.streak_reward_duration_amount,
        streakRewardDurationUnit: body.streakRewardDurationUnit ?? body.streak_reward_duration_unit
      });
      res.json({ ok: true, ...policy });
    } catch (e) {
      console.error('[admin/checkin-reward-policy POST]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/checkin-reward-policy', e, 'Não foi possível guardar a política de recompensa do check-in.');
    }
  });
}
