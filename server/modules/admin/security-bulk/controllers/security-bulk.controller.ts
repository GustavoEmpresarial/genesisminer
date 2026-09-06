/**
 * Rotas admin de segurança em massa (`/api/admin/security/...`).
 *
 * Migrado de legacy/backend/controllers/adminSecurityBulk.controller.ts.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { resolveRequestUserId as uidNum } from '../../../../core/http/request-user-id.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import {
  blockInactiveUsersByDays,
  countInactiveUsers,
  countPasswordResetTargets,
  forcePasswordResetForPlayers,
  parseInactiveDays,
  readInactiveBlockConfig,
  saveInactiveBlockConfig
} from '../services/security-bulk.js';

export type AdminSecurityBulkModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const PASSWORD_RESET_CONFIRM_PHRASE = 'REDEFINIR';
const INACTIVE_BLOCK_CONFIRM_PHRASE = 'BLOQUEAR';

/**
 * Porta extra além de `isAdmin`: as rotas de escrita (config, aplicar bloqueio,
 * aplicar reset de senha) exigem `req.isSuperAdmin`, não só admin comum. Escreve
 * a resposta 403 e devolve `false` quando falha — quem chama deve `return`
 * imediatamente nesse caso.
 */
function requireSuperAdmin(req: Request, res: Response): boolean {
  if (!req.isSuperAdmin) {
    res.status(HTTP_FORBIDDEN).json({ ok: false, error: 'Apenas super administradores podem executar esta ação.' });
    return false;
  }
  return true;
}

export function registerAdminSecurityBulkModuleRoutes(app: Express, deps: AdminSecurityBulkModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/security/bulk-tools/config', isAdmin, async (_req: Request, res: Response) => {
    try {
      const cfg = await readInactiveBlockConfig();
      res.json({ ok: true, ...cfg });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/security/bulk-tools/config', e, 'Erro ao carregar configuração.');
    }
  });

  app.post('/api/admin/security/bulk-tools/config', isAdmin, async (req: Request, res: Response) => {
    try {
      if (!requireSuperAdmin(req, res)) return;
      const days = parseInactiveDays(req.body?.inactiveBlockDays);
      if (days == null) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Informe dias entre 1 e 3650.' });
        return;
      }
      const autoBlockEnabled = !!req.body?.autoBlockEnabled;
      await saveInactiveBlockConfig(days, autoBlockEnabled);
      res.json({ ok: true, inactiveBlockDays: days, autoBlockEnabled });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/security/bulk-tools/config', e, 'Erro ao guardar configuração.');
    }
  });

  app.get('/api/admin/security/inactive-block/preview', isAdmin, async (req: Request, res: Response) => {
    try {
      const days = parseInactiveDays(req.query.days) ?? (await readInactiveBlockConfig()).inactiveBlockDays;
      const count = await countInactiveUsers(days);
      res.json({ ok: true, days, inactiveCount: count, cutoffMs: Date.now() - days * MS_PER_DAY, excludesAdmins: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/security/inactive-block/preview', e, 'Erro na pré-visualização.');
    }
  });

  /**
   * Bloqueio em massa por inatividade — mesma dupla-guarda de
   * `/force-password-reset/apply`: exige super-admin E a frase de confirmação
   * `{ confirm: "BLOQUEAR" }` no corpo. Alinhado agora (era assimétrico: só
   * exigia super-admin, sem confirmação textual, apesar do blast-radius
   * comparável — bloqueia contas em massa e, desde a correção em
   * `blockInactiveUsersByDays`, também mata as sessões activas).
   */
  app.post('/api/admin/security/inactive-block/apply', isAdmin, async (req: Request, res: Response) => {
    try {
      if (!requireSuperAdmin(req, res)) return;
      const confirm = String(req.body?.confirm ?? '').trim().toUpperCase();
      if (confirm !== INACTIVE_BLOCK_CONFIRM_PHRASE) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Confirmação inválida. Envie { "confirm": "BLOQUEAR" } no corpo.' });
        return;
      }
      const days = parseInactiveDays(req.body?.days) ?? (await readInactiveBlockConfig()).inactiveBlockDays;
      if (days == null) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Informe dias entre 1 e 3650.' });
        return;
      }
      const blockedCount = await blockInactiveUsersByDays(days);
      console.log(`[AdminSecurityBulk] inactive-block days=${days} blocked=${blockedCount} by admin=${uidNum(req)}`);
      res.json({ ok: true, days, blockedCount });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/security/inactive-block/apply', e, 'Erro ao bloquear contas inativas.');
    }
  });

  app.get('/api/admin/security/force-password-reset/preview', isAdmin, async (_req: Request, res: Response) => {
    try {
      const targetCount = await countPasswordResetTargets();
      res.json({ ok: true, targetCount, excludesAdmins: true, excludesSuperAdmins: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/security/force-password-reset/preview', e, 'Erro na pré-visualização.');
    }
  });

  app.post('/api/admin/security/force-password-reset/apply', isAdmin, async (req: Request, res: Response) => {
    try {
      if (!requireSuperAdmin(req, res)) return;
      const confirm = String(req.body?.confirm ?? '').trim().toUpperCase();
      if (confirm !== PASSWORD_RESET_CONFIRM_PHRASE) {
        res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Confirmação inválida. Envie { "confirm": "REDEFINIR" } no corpo.' });
        return;
      }
      const resetCount = await forcePasswordResetForPlayers();
      console.log(`[AdminSecurityBulk] force-password-reset count=${resetCount} by admin=${uidNum(req)}`);
      res.json({ ok: true, resetCount, message: 'Senhas alteradas. Jogadores devem usar "Esqueci a senha" para definir uma nova.' });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/security/force-password-reset/apply', e, 'Erro ao redefinir senhas.');
    }
  });
}
