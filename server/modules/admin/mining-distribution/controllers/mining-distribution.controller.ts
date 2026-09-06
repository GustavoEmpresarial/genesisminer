/**
 * Rotas admin: relatórios de distribuição de mineração (`/api/admin/mining-distribution/*`).
 *
 * Migrado de legacy/backend/controllers/adminMiningDistribution.controller.ts.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { clamp } from '../../../../shared/utils/clamp.js';
import { parseDistributionDateMs, utcDayEndMsFromTs } from '../services/dates.js';
import { rebuildMiningDistributionRollups, rebuildMiningDistributionRollupsRecent } from '../services/rollups.js';
import {
  getDistributionByCoin,
  getDistributionOverview,
  getDistributionTimeline,
  getMiningCreditsLedger,
  getUserMiningDistributionSummary,
  streamMiningCreditsCsv
} from '../services/report.js';

export type AdminMiningDistributionModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;
const PAGE_MAX = 99_999;
const LIMIT_MAX = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const DEFAULT_ROLLUP_DAYS_BACK = 45;
const REBUILD_COOLDOWN_MS = 60_000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRangeFromQuery(req: Request): { fromMs: number; toMs: number } | null {
  const fromMs = parseDistributionDateMs(req.query.from ?? req.query.fromMs);
  const toRaw = parseDistributionDateMs(req.query.to ?? req.query.toMs);
  if (fromMs == null || toRaw == null) return null;
  const toMs = typeof req.query.to === 'string' && YMD_RE.test(req.query.to.trim()) ? utcDayEndMsFromTs(toRaw) : toRaw;
  return { fromMs, toMs };
}

let lastRebuildAtMs = 0;

export function registerAdminMiningDistributionModuleRoutes(app: Express, deps: AdminMiningDistributionModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/mining-distribution/overview', isAdmin, async (req: Request, res: Response) => {
    try {
      const customFrom = parseDistributionDateMs(req.query.customFrom);
      const customToRaw = parseDistributionDateMs(req.query.customTo);
      const customTo = customToRaw != null && typeof req.query.customTo === 'string' && YMD_RE.test(req.query.customTo.trim()) ? utcDayEndMsFromTs(customToRaw) : customToRaw;
      const data = await getDistributionOverview(customFrom, customTo);
      res.json(data);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.get('/api/admin/mining-distribution/by-coin', isAdmin, async (req: Request, res: Response) => {
    try {
      const range = parseRangeFromQuery(req);
      if (!range) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Parâmetros from e to obrigatórios (ms ou YYYY-MM-DD UTC).' });
        return;
      }
      const data = await getDistributionByCoin(range.fromMs, range.toMs);
      res.json(data);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.get('/api/admin/mining-distribution/timeline', isAdmin, async (req: Request, res: Response) => {
    try {
      const range = parseRangeFromQuery(req);
      if (!range) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Parâmetros from e to obrigatórios.' });
        return;
      }
      const bucket = req.query.bucket === 'week' ? 'week' : 'day';
      const coinId = typeof req.query.coinId === 'string' ? req.query.coinId.trim() : undefined;
      const data = await getDistributionTimeline(range.fromMs, range.toMs, bucket, coinId || undefined);
      res.json(data);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.get('/api/admin/mining-distribution/credits', isAdmin, async (req: Request, res: Response) => {
    try {
      const range = parseRangeFromQuery(req);
      if (!range) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Parâmetros from e to obrigatórios.' });
        return;
      }
      const page = clamp(parseInt(String(req.query.page ?? String(DEFAULT_PAGE)), 10), 1, PAGE_MAX);
      const limit = clamp(parseInt(String(req.query.limit ?? String(DEFAULT_LIMIT)), 10), 1, LIMIT_MAX);
      const userIdRaw = req.query.userId;
      const userId = userIdRaw != null && String(userIdRaw).trim() !== '' ? parseInt(String(userIdRaw), 10) : undefined;
      const coinId = typeof req.query.coinId === 'string' ? req.query.coinId.trim() : undefined;
      const roomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

      const data = await getMiningCreditsLedger({
        fromMs: range.fromMs,
        toMs: range.toMs,
        userId: Number.isFinite(userId) ? userId : undefined,
        coinId: coinId || undefined,
        roomId: roomId || undefined,
        q: q || undefined,
        page,
        limit
      });
      res.json(data);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.get('/api/admin/mining-distribution/credits/export.csv', isAdmin, async (req: Request, res: Response) => {
    try {
      const range = parseRangeFromQuery(req);
      if (!range) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Parâmetros from e to obrigatórios.' });
        return;
      }
      const userIdRaw = req.query.userId;
      const userId = userIdRaw != null && String(userIdRaw).trim() !== '' ? parseInt(String(userIdRaw), 10) : undefined;
      const coinId = typeof req.query.coinId === 'string' ? req.query.coinId.trim() : undefined;
      const roomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mining-credits-export.csv"');

      const result = await streamMiningCreditsCsv(
        { fromMs: range.fromMs, toMs: range.toMs, userId: Number.isFinite(userId) ? userId : undefined, coinId: coinId || undefined, roomId: roomId || undefined, q: q || undefined, page: 1, limit: LIMIT_MAX },
        (chunk) => res.write(chunk)
      );

      if (result.truncated) {
        res.write(`# AVISO: exportação limitada a ${result.rowsWritten} linhas.\n`);
      }
      res.end();
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.get('/api/admin/mining-distribution/users/:userId/summary', isAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'userId inválido.' });
        return;
      }
      const range = parseRangeFromQuery(req);
      if (!range) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Parâmetros from e to obrigatórios.' });
        return;
      }
      const data = await getUserMiningDistributionSummary(userId, range.fromMs, range.toMs);
      res.json(data);
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });

  app.post('/api/admin/mining-distribution/rebuild-rollups', isAdmin, async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (now - lastRebuildAtMs < REBUILD_COOLDOWN_MS) {
        res.status(HTTP_TOO_MANY_REQUESTS).json({ error: 'Aguarde 60 segundos entre reconstruções de rollup.' });
        return;
      }
      lastRebuildAtMs = now;

      const fromYmd = typeof req.body?.fromDay === 'string' && YMD_RE.test(req.body.fromDay) ? req.body.fromDay : null;
      const toYmd = typeof req.body?.toDay === 'string' && YMD_RE.test(req.body.toDay) ? req.body.toDay : null;

      const result =
        fromYmd && toYmd
          ? await rebuildMiningDistributionRollups(fromYmd, toYmd)
          : await rebuildMiningDistributionRollupsRecent(parseInt(String(req.body?.daysBack ?? process.env.MINING_DISTRIBUTION_ROLLUP_DAYS_BACK ?? String(DEFAULT_ROLLUP_DAYS_BACK)), 10) || DEFAULT_ROLLUP_DAYS_BACK);

      res.json({ ok: true, ...result });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar distribuição de mineração.');
    }
  });
}
