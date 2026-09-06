/**
 * Rotas do Admin Dashboard (`/api/admin/dashboard-stats`, metrics, ranking-exclusion, users/map).
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../../../../core/database/prisma.js';
import db from '../../../../core/database/pool.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { getClientIpFromRequest } from '../../../../core/http/client-ip.js';
import { resolveRequestUserId as uidNum } from '../../../../core/http/request-user-id.js';
import { MS_PER_MINUTE } from '../../../../shared/utils/time.js';
import {
  getAdminDashboardStatsCached,
  invalidateAdminDashboardStatsCache
} from '../services/dashboard-stats.js';
import { computeAdminSiteMetrics } from '../services/site-metrics.js';

export type AdminDashboardModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const RATE_LIMIT_MAX = 120;

const dashLimiter = rateLimit({
  windowMs: MS_PER_MINUTE,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-dash:${uidNum(req) ?? getClientIpFromRequest(req)}`,
  message: { error: 'Too many admin dashboard requests.', code: 'RATE_LIMIT' }
});

export function registerAdminDashboardModuleRoutes(app: Express, deps: AdminDashboardModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/dashboard-stats', isAdmin, dashLimiter, async (req: Request, res: Response) => {
    try {
      const payload = await getAdminDashboardStatsCached();
      res.json(payload);
    } catch (e) {
      console.error('[DashStats] Error:', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/dashboard-stats', e, 'Erro ao carregar dashboard.');
    }
  });

  app.get('/api/admin/metrics', isAdmin, dashLimiter, async (_req: Request, res: Response) => {
    try {
      const payload = await computeAdminSiteMetrics();
      res.json(payload);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/metrics', e, 'Erro ao carregar métricas.');
    }
  });

  app.post('/api/admin/ranking-exclusion', isAdmin, dashLimiter, async (req: Request, res: Response) => {
    const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!emailRaw) {
      res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Email inválido' });
      return;
    }
    const excluded = !!req.body?.excluded;
    try {
      const u = await prisma.users.findFirst({
        where: { email: { equals: emailRaw, mode: 'insensitive' } },
        select: { id: true, email: true, username: true }
      });
      if (!u) {
        res.status(HTTP_NOT_FOUND).json({ ok: false, error: 'Utilizador não encontrado.' });
        return;
      }
      await prisma.users.update({
        where: { id: u.id },
        data: { ranking_excluded: excluded ? 1 : 0 }
      });
      invalidateAdminDashboardStatsCache();
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/ranking-exclusion', e, 'Erro ao atualizar ranking.');
    }
  });

  /** Mapa leve p/ matching carteira↔user no dashboard (depósitos on-chain). */
  app.get('/api/admin/users/map', isAdmin, dashLimiter, async (_req: Request, res: Response) => {
    try {
      const resRows = await db.query(`
        SELECT
          u.id,
          u.username,
          u.polygon_wallet as "polygonWallet",
          u.email
        FROM users u
      `);
      res.json(resRows.rows);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/users/map', e, 'Erro ao carregar mapa de utilizadores.');
    }
  });
}
