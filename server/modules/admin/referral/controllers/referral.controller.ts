/**
 * Rotas admin do programa de referral (`/api/admin/referrals/*`).
 *
 * Migrado de legacy/backend/controllers/adminReferralController.ts. Leitura +
 * bloqueio + exclusão em rede (não permite ajustar comissões via API admin —
 * decisão consciente do legado).
 *
 * `POST /api/admin/referrals/network-delete` é destrutiva (apaga o indicador
 * + todos os indicados directos em cascata, via `deleteUserByEmail` —
 * extraída de legacy/backend/server.ts:6764, nunca tinha sido extraída do
 * monólito). Porte confirmado explicitamente pelo dono do projeto (ver
 * DECISIONS.md #43) — mesma categoria de risco do restore, que continua
 * cortado em `modules/admin/backup` (item #26).
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../../core/database/pool.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { prisma } from '../../../../core/database/prisma.js';
import { parseDateMs, clampPage, clamp } from '../services/format.js';
import { buildReferralCommissionsCsv, buildReferralSummary, listReferralCommissions, listReferralLinks } from '../services/report.js';
import { blockReferralNetwork, findUserByLookupToken, buildReferrerChain, getReferredNetworkStats, listAllReferredUsers, parseLookupQueries, resolveNetworkTarget, resolveReferrerUser, toReferralUserBrief, NETWORK_ROWS_PREVIEW_MAX, type ReferralUserBrief } from '../services/network.js';
import { deleteUserByEmail } from '../services/delete-user.js';

export type AdminReferralModuleDeps = { isAdmin: RequestHandler };

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const COMMISSIONS_PAGE_LIMIT_MAX = 500;
const COMMISSIONS_DEFAULT_LIMIT = 50;
const LINKS_DEFAULT_LIMIT = 50;

export function registerAdminReferralModuleRoutes(app: Express, deps: AdminReferralModuleDeps): void {
  const { isAdmin } = deps;

  /** Indicadores activos, vínculos totais, totais financeiros, top indicadores, taxa actual da comissão. */
  app.get('/api/admin/referrals/summary', isAdmin, async (_req: Request, res: Response) => {
    try {
      const summary = await buildReferralSummary();
      res.json(summary);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[GET /api/admin/referrals/summary]', e, 'Erro ao carregar resumo de referral.');
    }
  });

  /** Histórico paginado de comissões com filtros: período, indicador, indicado, min/max, texto livre. */
  app.get('/api/admin/referrals/commissions', isAdmin, async (req: Request, res: Response) => {
    try {
      const page = clampPage(parseInt(String(req.query.page ?? '1'), 10), 1);
      const limit = clamp(parseInt(String(req.query.limit ?? String(COMMISSIONS_DEFAULT_LIMIT)), 10), 1, COMMISSIONS_PAGE_LIMIT_MAX);
      const result = await listReferralCommissions({
        page,
        limit,
        startMs: parseDateMs(req.query.startDate),
        endMs: parseDateMs(req.query.endDate),
        referrer: typeof req.query.referrer === 'string' ? req.query.referrer.trim() : '',
        referred: typeof req.query.referred === 'string' ? req.query.referred.trim() : '',
        minCommission: parseFloat(String(req.query.minCommission ?? '')),
        maxCommission: parseFloat(String(req.query.maxCommission ?? '')),
        q: typeof req.query.q === 'string' ? req.query.q.trim() : ''
      });
      res.json(result);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[GET /api/admin/referrals/commissions]', e, 'Erro ao listar comissões.');
    }
  });

  /** Vínculos indicador↔indicado, com totais agregados (depósito, comissão). */
  app.get('/api/admin/referrals/links', isAdmin, async (req: Request, res: Response) => {
    try {
      const page = clampPage(parseInt(String(req.query.page ?? '1'), 10), 1);
      const limit = clamp(parseInt(String(req.query.limit ?? String(LINKS_DEFAULT_LIMIT)), 10), 1, COMMISSIONS_PAGE_LIMIT_MAX);
      const result = await listReferralLinks({ page, limit, q: typeof req.query.q === 'string' ? req.query.q.trim() : '' });
      res.json(result);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[GET /api/admin/referrals/links]', e, 'Erro ao listar vínculos.');
    }
  });

  /** Exporta o histórico de comissões (com os filtros aplicados) para CSV — tecto de 50k linhas. */
  app.get('/api/admin/referrals/export.csv', isAdmin, async (req: Request, res: Response) => {
    try {
      const csv = await buildReferralCommissionsCsv({
        startMs: parseDateMs(req.query.startDate),
        endMs: parseDateMs(req.query.endDate),
        referrer: typeof req.query.referrer === 'string' ? req.query.referrer.trim() : '',
        referred: typeof req.query.referred === 'string' ? req.query.referred.trim() : '',
        q: typeof req.query.q === 'string' ? req.query.q.trim() : ''
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="referral-commissions-${Date.now()}.csv"`);
      res.send(csv);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[GET /api/admin/referrals/export.csv]', e, 'Erro ao exportar comissões.');
    }
  });

  /**
   * Consulta rápida: quem indicou o utilizador, cadeia de uplines, indicados directos.
   * Aceita vários valores separados por vírgula/ponto-e-vírgula/quebra de linha.
   */
  app.get('/api/admin/referrals/lookup', isAdmin, async (req: Request, res: Response) => {
    try {
      const queries = parseLookupQueries(req.query.q);
      if (queries.length === 0) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Informe ao menos um username, email ou id em ?q=' });
        return;
      }

      const notFound: string[] = [];
      const results: Array<{
        query: string;
        user: ReferralUserBrief | null;
        referredByRaw: string | null;
        referrer: ReferralUserBrief | null;
        referrerChain: ReferralUserBrief[];
        referredLinkCount: number;
        referredCount: number;
        orphanLinkCount: number;
        referredUsers: ReferralUserBrief[];
      }> = [];

      for (const query of queries) {
        const user = await findUserByLookupToken(query);
        if (!user) {
          notFound.push(query);
          continue;
        }

        const referrer = await resolveReferrerUser(user.referred_by);
        const referrerChain = await buildReferrerChain(user);
        const network = await getReferredNetworkStats(Number(user.id));

        results.push({
          query,
          user: toReferralUserBrief(user),
          referredByRaw: user.referred_by ?? null,
          referrer: toReferralUserBrief(referrer),
          referrerChain,
          referredLinkCount: network.linkCount,
          referredCount: network.resolvableCount,
          orphanLinkCount: network.orphanLinkCount,
          referredUsers: network.rows.slice(0, NETWORK_ROWS_PREVIEW_MAX).map((row) => ({ id: Number(row.id), username: row.username ?? null, email: row.email ?? null, referralCode: row.referral_code ?? null }))
        });
      }

      res.json({ ok: true, results, notFound });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[GET /api/admin/referrals/lookup]', e, 'Erro ao consultar referral.');
    }
  });

  /** Bloqueia o indicador e todos os indicados directos (tabela `referrals`). */
  app.post('/api/admin/referrals/network-block', isAdmin, async (req: Request, res: Response) => {
    try {
      const result = await blockReferralNetwork((req.body ?? {}) as Record<string, unknown>);
      if (!result.ok) {
        res.status(HTTP_NOT_FOUND).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[POST /api/admin/referrals/network-block]', e, 'Erro ao bloquear rede de indicação.');
    }
  });

  /** Exclui em cascata o indicador e todos os indicados directos (destrutivo, sem undo). */
  app.post('/api/admin/referrals/network-delete', isAdmin, async (req: Request, res: Response) => {
    try {
      const target = await resolveNetworkTarget((req.body ?? {}) as Record<string, unknown>);
      if (!target?.email) {
        res.status(HTTP_NOT_FOUND).json({ ok: false, error: 'Utilizador não encontrado ou sem e-mail.' });
        return;
      }

      const referred = await listAllReferredUsers(Number(target.id));
      const network = await getReferredNetworkStats(Number(target.id));
      const allIds = [Number(target.id), ...referred.map((r) => Number(r.id))];

      if (!req.isSuperAdmin) {
        const adminRows = await prisma.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM users WHERE id = ANY(${allIds}::int[]) AND COALESCE(is_admin, 0) <> 0
        `;
        const actorId = Number(req.userId);
        const blocksOtherAdmin = adminRows.some((row) => Number(row.id) !== actorId);
        if (blocksOtherAdmin) {
          res.status(HTTP_FORBIDDEN).json({ ok: false, error: 'Apenas super administradores podem excluir outras contas administrador.' });
          return;
        }
      }

      const client = await pool.connect();
      const failed: string[] = [];
      let deletedCount = 0;
      try {
        await client.query('BEGIN');
        for (const row of referred) {
          const em = String(row.email || '').trim();
          if (!em) {
            failed.push(row.username || `#${row.id}`);
            continue;
          }
          const r = await deleteUserByEmail(em, client);
          if (r.ok) deletedCount += 1;
          else failed.push(em);
        }
        const main = await deleteUserByEmail(String(target.email).trim(), client);
        if (!main.ok) {
          await client.query('ROLLBACK');
          res.status(HTTP_BAD_REQUEST).json({ ok: false, error: main.error || 'Falha ao excluir o indicador.' });
          return;
        }
        deletedCount += 1;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({
        ok: true,
        deletedCount,
        referredDeleted: referred.length,
        referredLinkCount: network.linkCount,
        resolvableCount: network.resolvableCount,
        orphanLinkCount: network.orphanLinkCount,
        failed,
        referrer: toReferralUserBrief(target)
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, '[POST /api/admin/referrals/network-delete]', e, 'Erro ao excluir rede de indicação.');
    }
  });
}
