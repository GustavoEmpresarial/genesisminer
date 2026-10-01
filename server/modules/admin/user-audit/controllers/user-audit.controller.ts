/**
 * Rotas admin de auditoria ainda no Express: inventário, session-snapshots
 * (descontinuado) e account-trace. `GET /api/admin/user-activity` → genesis-api.
 *
 * Migrado de legacy/backend/controllers/adminUserAudit.controller.ts.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { getAdminUserAccountTrace } from '../services/account-trace.js';
import { listUserInventoryAudit, parseInventoryAuditRange } from '../services/inventory-audit.js';

export type AdminUserAuditModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const ACCOUNT_TRACE_TIMELINE_LIMIT_DEFAULT = 100;

/**
 * Regista as rotas admin de auditoria de jogador que ainda ficam no Express:
 * - `GET /api/admin/users/:userId/inventory-audit` — histórico de `inventory_movements`, paginado.
 * - `GET /api/admin/users/:userId/session-snapshots` — descontinuado (resposta vazia).
 * - `GET /api/admin/users/:userId/account-trace` — rastreio agregado completo da conta (ver
 *   `getAdminUserAccountTrace`), com suporte a `sections` para pedir só parte da resposta.
 *
 * `GET /api/admin/user-activity` → genesis-api `admin_users` + mining-worker.
 *
 * Todas as rotas exigem `deps.isAdmin` como middleware e devolvem erro 500 uniforme via
 * `sendInternalErrorSafeMessageOrPrisma` em caso de falha inesperada.
 */
export function registerAdminUserAuditModuleRoutes(app: Express, deps: AdminUserAuditModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/users/:userId/inventory-audit', isAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'userId inválido' });
        return;
      }
      const page = parseInt(String(req.query.page || String(DEFAULT_PAGE)), 10) || DEFAULT_PAGE;
      const limit = parseInt(String(req.query.limit || String(DEFAULT_LIMIT)), 10) || DEFAULT_LIMIT;
      const { fromMs, toMs } = parseInventoryAuditRange(req.query.from, req.query.to);
      const lossesOnly = req.query.lossesOnly === '1' || req.query.lossesOnly === 'true';

      const data = await listUserInventoryAudit({ userId, fromMs, toMs, page, limit, lossesOnly });
      res.json(data);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[AdminInventoryAudit]', e, 'Falha ao carregar auditoria de inventário');
    }
  });

  app.get('/api/admin/users/:userId/session-snapshots', isAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'userId inválido' });
        return;
      }
      // Writer de session snapshots nunca foi portado para current/; Mongo removido.
      res.json({
        snapshots: [],
        diffs: [],
        note: 'Session snapshots descontinuados (dependência Mongo removida).'
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[AdminSessionSnapshots]', e, 'Falha ao carregar snapshots de sessão');
    }
  });

  app.get('/api/admin/users/:userId/account-trace', isAdmin, async (req: Request, res: Response) => {
    try {
      const userId = parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'userId inválido' });
        return;
      }
      const fromMs = parseInt(String(req.query.fromMs || ''), 10);
      const toMs = parseInt(String(req.query.toMs || ''), 10);
      const timelineLimit = parseInt(String(req.query.timelineLimit || String(ACCOUNT_TRACE_TIMELINE_LIMIT_DEFAULT)), 10) || ACCOUNT_TRACE_TIMELINE_LIMIT_DEFAULT;
      const timelineBeforeMs = parseInt(String(req.query.timelineBeforeMs || req.query.cursor || ''), 10);
      const sectionsRaw = String(req.query.sections || '').trim();
      const sections = sectionsRaw ? sectionsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;

      const data = await getAdminUserAccountTrace({
        userId,
        fromMs: Number.isFinite(fromMs) && fromMs > 0 ? fromMs : null,
        toMs: Number.isFinite(toMs) && toMs > 0 ? toMs : null,
        timelineLimit,
        timelineBeforeMs: Number.isFinite(timelineBeforeMs) && timelineBeforeMs > 0 ? timelineBeforeMs : null,
        sections
      });

      if (!data) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Utilizador não encontrado' });
        return;
      }

      if (sections && sections.length > 0) {
        const out: Record<string, unknown> = {};
        for (const key of sections) {
          if (key in data) out[key] = (data as Record<string, unknown>)[key];
        }
        if (!sections.includes('timeline')) {
          out.timelineHasMore = data.timelineHasMore;
          out.timelineNextCursor = data.timelineNextCursor;
        }
        res.json(out);
        return;
      }

      res.json(data);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[AdminAccountTrace]', e, 'Falha ao carregar rastreio da conta');
    }
  });
}
