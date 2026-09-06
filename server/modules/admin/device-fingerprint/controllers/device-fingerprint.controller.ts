/**
 * `GET /api/admin/device-fingerprints` — auditoria de fingerprints (login/registo).
 *
 * Migrado de legacy/backend/controllers/deviceFingerprintAdminController.ts, verbatim.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../../core/http/error-response.js';
import { listDeviceFingerprintLogs } from '../services/logs.js';

export type DeviceFingerprintAdminModuleDeps = { isAdmin: RequestHandler };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerDeviceFingerprintAdminModuleRoutes(app: Express, deps: DeviceFingerprintAdminModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/device-fingerprints', isAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const et = req.query.eventType;
      const eventType = et === 'login' || et === 'register' ? et : null;
      const uidRaw = req.query.userId;
      const userIdParsed = uidRaw != null && String(uidRaw).trim() !== '' ? Math.floor(Number(uidRaw)) : NaN;
      const userId = Number.isFinite(userIdParsed) && userIdParsed > 0 ? userIdParsed : null;
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;

      const { rows, total } = await listDeviceFingerprintLogs({ limit, offset, eventType, userId, q });
      res.json({ rows, total, limit, offset });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/device-fingerprints', e, 'Erro ao listar fingerprints.');
    }
  });
}
