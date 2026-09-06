/**
 * Rotas admin: relatório de emails/contas suspeitas
 * (`/api/admin/users/suspicious-emails*`).
 *
 * Migrado de legacy/backend/server.ts (rotas inline, linhas ~5716-5790) — o
 * legado registava estas 3 rotas directamente no `server.ts` monolítico, sem
 * controller próprio; aqui seguem o padrão do resto do projeto.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { respondIfHttpControlledError, sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { resolveRequestUserId as uidNum } from '../../../../core/http/request-user-id.js';
import { buildSuspiciousEmailsCsv, deactivateFilteredSuspiciousUsers, fetchSuspiciousEmailsReport } from '../services/report.js';

export type AdminSuspiciousEmailsModuleDeps = { isAdmin: RequestHandler };

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const EXPORT_PAGE_LIMIT = 5000;
const DEACTIVATE_CONFIRM_PHRASE = 'DESATIVAR';

export function registerAdminSuspiciousEmailsModuleRoutes(app: Express, deps: AdminSuspiciousEmailsModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/users/suspicious-emails', isAdmin, async (req: Request, res: Response) => {
    try {
      const report = await fetchSuspiciousEmailsReport({
        q: req.query.q as string | undefined,
        reason: req.query.reason as string | undefined,
        status: req.query.status as string | undefined,
        domain: req.query.domain as string | undefined,
        activity: req.query.activity as string | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
        sort: req.query.sort as string | undefined
      });
      res.json(report);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao carregar contas suspeitas.');
    }
  });

  app.get('/api/admin/users/suspicious-emails/export.csv', isAdmin, async (req: Request, res: Response) => {
    try {
      const report = await fetchSuspiciousEmailsReport(
        {
          q: req.query.q as string | undefined,
          reason: req.query.reason as string | undefined,
          status: req.query.status as string | undefined,
          domain: req.query.domain as string | undefined,
          activity: req.query.activity as string | undefined,
          page: 1,
          limit: EXPORT_PAGE_LIMIT,
          sort: req.query.sort as string | undefined
        },
        { exportMode: true }
      );
      const csv = buildSuspiciousEmailsCsv(report.users);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="suspicious-emails.csv"');
      res.send(csv);
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao exportar contas suspeitas.');
    }
  });

  /**
   * Desactivação em massa (blast-radius alto): mesma dupla-guarda das rotas
   * equivalentes em `security-bulk` — exige super-admin (`req.isSuperAdmin`,
   * não só `isAdmin`) e a frase de confirmação `{ confirm: "DESATIVAR" }` no
   * corpo. Alinhado agora (era assimétrico: qualquer admin comum podia
   * chamar, sem confirmação textual, apesar do blast-radius comparável).
   *
   * Também protegido contra desactivar por engano quem só *parece* inactivo
   * pela aproximação usada na listagem — ver `services/report.ts`
   * (`resolveSuspiciousUsersWorkingSet` e `deactivateFilteredSuspiciousUsers`)
   * sobre a dupla-checagem de contagem (`expectedCount`) e a refinação por
   * hash real de mineração (`excludedByRealMining` na resposta conta quantos
   * candidatos foram poupados por essa refinação).
   */
  app.post('/api/admin/users/suspicious-emails/deactivate-filtered', isAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const expectedCount = Math.floor(Number(body.expectedCount) || 0);
      const adminUserId = uidNum(req);
      if (!adminUserId) {
        res.status(HTTP_UNAUTHORIZED).json({ ok: false, error: 'Não autenticado.' });
        return;
      }
      if (!req.isSuperAdmin) {
        res.status(HTTP_FORBIDDEN).json({ ok: false, error: 'Apenas super administradores podem executar esta ação.' });
        return;
      }
      const confirm = String(body.confirm ?? '').trim().toUpperCase();
      if (confirm !== DEACTIVATE_CONFIRM_PHRASE) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Confirmação inválida. Envie { "confirm": "DESATIVAR" } no corpo.' });
        return;
      }
      const result = await deactivateFilteredSuspiciousUsers(
        {
          q: body.q != null ? String(body.q) : undefined,
          reason: body.reason != null ? String(body.reason) : undefined,
          status: body.status != null ? String(body.status) : undefined,
          domain: body.domain != null ? String(body.domain) : undefined,
          activity: body.activity != null ? String(body.activity) : undefined
        },
        { expectedCount, adminUserId }
      );
      if (!result.ok) {
        if (result.code === 'COUNT_MISMATCH') {
          res.status(HTTP_CONFLICT).json({
            ok: false,
            code: 'COUNT_MISMATCH',
            error: `Contagem desactualizada: esperado ${result.expected}, actual ${result.actual}. Actualize a lista.`,
            expected: result.expected,
            actual: result.actual
          });
          return;
        }
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: result.error || 'Pedido inválido.' });
        return;
      }
      res.json({ ok: true, deactivated: result.deactivated, alreadyBlocked: result.alreadyBlocked, excludedByRealMining: result.excludedByRealMining });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, req.originalUrl || 'api', e, 'Erro ao desactivar contas suspeitas.');
    }
  });
}
