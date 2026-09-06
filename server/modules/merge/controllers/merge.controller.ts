/**
 * Admin merge settings (`/api/admin/merge/settings`).
 * Player `/api/merge/*` owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import { MERGEABLE_SOURCE_RARITIES, MERGE_RARITIES } from '../services/constants.js';
import { loadMergeSettings, saveMergeSettings } from '../services/settings.js';

const HTTP_BAD_REQUEST = 400;
const GAIN_PERCENT_MIN = 0;
const GAIN_PERCENT_MAX = 100;
const COST_PCT_MAX = 100;
const RACK_HS_BONUS_PCT_MAX = 500;

export type MergeModuleDeps = {
  isAdmin: RequestHandler;
};

export function registerMergeModuleRoutes(app: Express, deps: MergeModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/merge/settings', isAdmin, async (_req: Request, res: Response) => {
    try {
      const settings = await loadMergeSettings();
      res.json({ ok: true, ...settings });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/merge/settings', e, 'Falha ao carregar.');
    }
  });

  app.put('/api/admin/merge/settings', isAdmin, async (req: Request, res: Response) => {
    try {
      const gainPercent = Number(req.body?.gainPercent);
      const rawCost = req.body?.costPctByRarity;
      const rawRackBonus = req.body?.rackHsBonusPctByRarity;
      if (typeof req.body?.enabled !== 'boolean') {
        res.status(HTTP_BAD_REQUEST).json({ error: 'enabled (boolean) em falta.', code: 'BAD_ENABLED' });
        return;
      }
      const typeFlags = [
        ['enabledMachine', req.body?.enabledMachine],
        ['enabledMultiplier', req.body?.enabledMultiplier],
        ['enabledInfrastructure', req.body?.enabledInfrastructure]
      ] as const;
      for (const [key, val] of typeFlags) {
        if (typeof val !== 'boolean') {
          res.status(HTTP_BAD_REQUEST).json({ error: `${key} (boolean) em falta.`, code: 'BAD_TYPE_ENABLED' });
          return;
        }
      }
      if (!Number.isFinite(gainPercent) || gainPercent < GAIN_PERCENT_MIN || gainPercent > GAIN_PERCENT_MAX) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'gainPercent inválido (0–100).', code: 'BAD_GAIN' });
        return;
      }
      if (!rawCost || typeof rawCost !== 'object') {
        res.status(HTTP_BAD_REQUEST).json({ error: 'costPctByRarity em falta.', code: 'BAD_COST' });
        return;
      }
      const costPctByRarity = {} as Record<(typeof MERGEABLE_SOURCE_RARITIES)[number], number>;
      for (const k of MERGEABLE_SOURCE_RARITIES) {
        const n = Number((rawCost as Record<string, unknown>)[k]);
        if (!Number.isFinite(n) || n < 0 || n > COST_PCT_MAX) {
          res.status(HTTP_BAD_REQUEST).json({ error: `Invalid rate for ${k}.`, code: 'BAD_COST' });
          return;
        }
        costPctByRarity[k] = n;
      }
      if (!rawRackBonus || typeof rawRackBonus !== 'object') {
        res.status(HTTP_BAD_REQUEST).json({ error: 'rackHsBonusPctByRarity em falta.', code: 'BAD_RACK_BONUS' });
        return;
      }
      const rackHsBonusPctByRarity = {} as Record<(typeof MERGE_RARITIES)[number], number>;
      for (const k of MERGE_RARITIES) {
        const n = Number((rawRackBonus as Record<string, unknown>)[k]);
        if (!Number.isFinite(n) || n < 0 || n > RACK_HS_BONUS_PCT_MAX) {
          res.status(HTTP_BAD_REQUEST).json({ error: `Invalid H/s bonus for ${k}.`, code: 'BAD_RACK_BONUS' });
          return;
        }
        rackHsBonusPctByRarity[k] = n;
      }
      const saved = await saveMergeSettings({
        enabled: req.body.enabled === true,
        enabledMachine: req.body.enabledMachine === true,
        enabledMultiplier: req.body.enabledMultiplier === true,
        enabledInfrastructure: req.body.enabledInfrastructure === true,
        gainPercent,
        costPctByRarity,
        rackHsBonusPctByRarity
      });
      res.json({ ok: true, ...saved });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT /api/admin/merge/settings', e, 'Falha ao guardar.');
    }
  });
}
