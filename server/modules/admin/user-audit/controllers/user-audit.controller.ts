/**
 * Rotas admin: atividade legível, auditoria de inventário, snapshots de sessão,
 * rastreio completo da conta.
 *
 * Migrado de legacy/backend/controllers/adminUserAudit.controller.ts.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { prisma } from '../../../../core/database/prisma.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { clamp } from '../../../../shared/utils/clamp.js';
import {
  getAdminUserAccountTrace,
  listAdminUserP2pActivityRowsFromPostgres,
  mergeAdminUserActivityLogs,
  type GameActivityLogRow
} from '../services/account-trace.js';
import { formatActivityEvent, matchesActivityFilter } from '../services/activity-event-formatter.js';
import { listUserInventoryAudit, parseInventoryAuditRange } from '../services/inventory-audit.js';

export type AdminUserAuditModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const ACTIVITY_LIMIT_DEFAULT = 80;
const ACTIVITY_LIMIT_MAX = 100;
const ACTIVITY_LIMIT_MIN = 1;
const P2P_ROWS_FETCH_CAP = 250;
const P2P_ROWS_FETCH_MULTIPLIER = 3;
const ACCOUNT_TRACE_TIMELINE_LIMIT_DEFAULT = 100;

/**
 * Resolve o `userId` alvo de uma rota admin de auditoria: por `email`/`username`
 * (query `email`/`q`, case-insensitive e sem espaços nas pontas) ou por `userId`
 * numérico direto (query ou param de rota).
 *
 * @returns O id do utilizador encontrado, ou `null` se nenhuma das duas formas
 *   de busca resolver (email/username não bate nenhuma linha, ou nenhum dos
 *   dois parâmetros foi informado / `userId` não é um inteiro positivo).
 */
async function resolveUserId(req: Request): Promise<number | null> {
  const rawQ = String(req.query.email || req.query.q || '').trim().toLowerCase();
  const uidParsed = parseInt(String(req.query.userId || req.params.userId || ''), 10);
  if (rawQ) {
    const uRows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM users
      WHERE lower(trim(email::text)) = ${rawQ} OR lower(trim(username::text)) = ${rawQ}
      LIMIT 1
    `;
    return uRows[0]?.id ?? null;
  }
  if (Number.isFinite(uidParsed) && uidParsed > 0) return uidParsed;
  return null;
}

/** Anexa a `display` (título/resumo/severidade legíveis) a uma linha de log crua, via `formatActivityEvent`. */
function withDisplay(row: { id: string; action: string; meta: Record<string, unknown>; createdAt: number }) {
  const display = formatActivityEvent(row.action, row.meta);
  return { ...row, display };
}

/**
 * Regista as 4 rotas admin de auditoria de jogador:
 * - `GET /api/admin/user-activity` — feed de atividade (P2P via Postgres; Mongo descontinuado),
 *   com filtros de categoria/severidade/texto e paginação por cursor (`beforeMs`).
 * - `GET /api/admin/users/:userId/inventory-audit` — histórico de `inventory_movements`, paginado.
 * - `GET /api/admin/users/:userId/session-snapshots` — descontinuado (resposta vazia).
 * - `GET /api/admin/users/:userId/account-trace` — rastreio agregado completo da conta (ver
 *   `getAdminUserAccountTrace`), com suporte a `sections` para pedir só parte da resposta.
 *
 * Todas as rotas exigem `deps.isAdmin` como middleware e devolvem erro 500 uniforme via
 * `sendInternalErrorSafeMessageOrPrisma` em caso de falha inesperada.
 */
export function registerAdminUserAuditModuleRoutes(app: Express, deps: AdminUserAuditModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/user-activity', isAdmin, async (req: Request, res: Response) => {
    try {
      const uid = await resolveUserId(req);
      if (uid == null) {
        const rawQ = String(req.query.email || req.query.q || '').trim();
        if (!rawQ && !req.query.userId) {
          res.status(HTTP_BAD_REQUEST).json({ error: 'Indique email, username ou userId válido' });
          return;
        }
        res.status(HTTP_NOT_FOUND).json({ error: 'Utilizador não encontrado (email ou username).' });
        return;
      }

      const limit = clamp(parseInt(String(req.query.limit || String(ACTIVITY_LIMIT_DEFAULT)), 10) || ACTIVITY_LIMIT_DEFAULT, ACTIVITY_LIMIT_MIN, ACTIVITY_LIMIT_MAX);
      const beforeMs = parseInt(String(req.query.beforeMs || req.query.cursor || ''), 10);
      const categoryFilter = String(req.query.category || '').trim();
      const severityFilter = String(req.query.severity || '').trim();
      const filterId = String(req.query.filterId || 'all').trim();

      let accountCreatedAtMs: number | null = null;
      try {
        const gs = await prisma.game_states.findUnique({ where: { user_id: Number(uid) }, select: { start_time: true } });
        const raw = gs?.start_time;
        if (raw != null) {
          const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
          if (Number.isFinite(n) && n > 0) accountCreatedAtMs = n;
        }
      } catch {
        /* ignore */
      }

      // Mongo descontinuado: feed = só eventos P2P derivados do PostgreSQL.
      const mongoRows: GameActivityLogRow[] = [];
      const pgP2pRows = await listAdminUserP2pActivityRowsFromPostgres(Number(uid), {
        beforeMs: Number.isFinite(beforeMs) && beforeMs > 0 ? beforeMs : null,
        limit: Math.min(P2P_ROWS_FETCH_CAP, limit * P2P_ROWS_FETCH_MULTIPLIER)
      });

      const merged = mergeAdminUserActivityLogs(mongoRows, pgP2pRows, {
        beforeMs: Number.isFinite(beforeMs) && beforeMs > 0 ? beforeMs : null,
        limit
      });

      let enriched = merged.rows.map((r) => withDisplay(r));

      if (filterId && filterId !== 'all') {
        enriched = enriched.filter((r) => matchesActivityFilter(r.display, r.action, filterId));
      }
      if (categoryFilter) {
        enriched = enriched.filter((r) => r.display.category === categoryFilter);
      }
      if (severityFilter) {
        enriched = enriched.filter((r) => r.display.severity === severityFilter);
      }

      const searchQ = String(req.query.q || req.query.search || '').trim().toLowerCase();
      if (searchQ) {
        enriched = enriched.filter((r) => {
          const hay = `${r.action} ${r.display.title} ${r.display.summary}`.toLowerCase();
          return hay.includes(searchQ);
        });
      }

      const nextCursor = enriched.length > 0 ? enriched[enriched.length - 1].createdAt : null;

      res.json({
        logs: enriched,
        hasMore: merged.hasMore,
        nextCursor,
        accountCreatedAtMs,
        activityLogNote:
          'Histórico Mongo descontinuado. Este feed mostra apenas eventos P2P derivados do PostgreSQL.'
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[AdminUserActivity]', e, 'Falha ao carregar atividade');
    }
  });

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
