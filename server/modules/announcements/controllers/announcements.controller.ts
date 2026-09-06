/**
 * Admin announcements CRUD (`/api/admin/announcements`, legacy in-app aliases).
 * Player pending/dismiss/mini-blog owned by genesis-api.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../../../core/database/prisma.js';
import { getClientIpFromRequest } from '../../../core/http/client-ip.js';
import { sanitizeForLog } from '../../../shared/utils/safe-text.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';
import {
  AnnouncementValidationError,
  parseAnnouncementId,
  parseCreateInput,
  parseUpdateInput
} from '../services/validation.js';
import {
  createAnnouncementAdmin,
  deleteAnnouncementAdmin,
  listAnnouncementsAdmin,
  updateAnnouncementAdmin
} from '../services/announcements.js';
import { resolveRequestUserId as uidNum } from '../../../core/http/request-user-id.js';

export type AnnouncementsModuleDeps = {
  isAdmin: RequestHandler;
};

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CREATED = 201;
const ADMIN_MUTATE_LIMIT_MAX = 60;
const LOG_DETAILS_MAX_LENGTH = 200;
const USER_AGENT_MAX_LENGTH = 512;

const adminMutateLimiter = rateLimit({
  windowMs: MS_PER_HOUR,
  max: ADMIN_MUTATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `announcements-admin:${uidNum(req) ?? getClientIpFromRequest(req)}`,
  message: { error: 'Change limit reached. Try again later.', code: 'RATE_LIMIT' }
});

function sendValidationError(res: Response, e: AnnouncementValidationError): void {
  const code = e.code === 'INVALID_IMAGE_URL' ? 'INVALID_IMAGE_URL' : 'VALIDATION';
  const msg =
    code === 'INVALID_IMAGE_URL'
      ? 'Invalid image. Use internal upload only (PNG, JPG, or GIF).'
      : e.message || 'Invalid data.';
  res.status(HTTP_BAD_REQUEST).json({ error: msg, code });
}

async function logAdminAnnouncementAction(
  req: Request,
  action: string,
  announcementId: string | null,
  titleHint?: string
): Promise<void> {
  const adminId = uidNum(req);
  const ip = getClientIpFromRequest(req);
  const details = sanitizeForLog(
    `announcement.${action} admin=${adminId ?? '?'} id=${announcementId ?? '-'} title=${titleHint ?? ''}`,
    LOG_DETAILS_MAX_LENGTH
  );
  try {
    await prisma.admin_access_logs.create({
      data: {
        ip,
        attempted_url: String(req.originalUrl || req.url || '/api/admin/announcements'),
        user_agent:
          typeof req.headers['user-agent'] === 'string'
            ? req.headers['user-agent'].slice(0, USER_AGENT_MAX_LENGTH)
            : null,
        details,
        created_at: BigInt(Date.now())
      }
    });
  } catch (err) {
    console.error('[announcements audit]', err);
  }
}

export function registerAnnouncementsModuleRoutes(app: Express, deps: AnnouncementsModuleDeps): void {
  const { isAdmin } = deps;

  const listAdminHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const announcements = await listAnnouncementsAdmin();
      res.json({ ok: true, announcements });
    } catch (e) {
      console.error('[admin/announcements GET]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/announcements', e, 'Não foi possível listar os avisos.');
    }
  };

  const createAdminHandler = async (req: Request, res: Response): Promise<void> => {
    const adminId = uidNum(req);
    try {
      const validated = parseCreateInput((req.body || {}) as Record<string, unknown>);
      const created = await createAnnouncementAdmin(validated, adminId);
      await logAdminAnnouncementAction(req, 'create', created.id, created.title);
      res.status(HTTP_CREATED).json({ ok: true, announcement: created });
    } catch (e) {
      if (e instanceof AnnouncementValidationError) {
        sendValidationError(res, e);
        return;
      }
      console.error('[admin/announcements POST]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/announcements', e, 'Não foi possível criar o aviso.');
    }
  };

  const updateAdminHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      parseAnnouncementId(req.params.id);
      const validated = parseUpdateInput((req.body || {}) as Record<string, unknown>);
      const updated = await updateAnnouncementAdmin(req.params.id, validated);
      if (!updated) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Announcement not found.', code: 'NOT_FOUND' });
        return;
      }
      await logAdminAnnouncementAction(req, 'update', updated.id, updated.title);
      res.json({ ok: true, announcement: updated });
    } catch (e) {
      if (e instanceof AnnouncementValidationError) {
        sendValidationError(res, e);
        return;
      }
      console.error('[admin/announcements PUT]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT /api/admin/announcements/:id', e, 'Não foi possível atualizar o aviso.');
    }
  };

  const deleteAdminHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseAnnouncementId(req.params.id);
      const ok = await deleteAnnouncementAdmin(id);
      if (!ok) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Announcement not found.', code: 'NOT_FOUND' });
        return;
      }
      await logAdminAnnouncementAction(req, 'delete', id);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof AnnouncementValidationError) {
        sendValidationError(res, e);
        return;
      }
      console.error('[admin/announcements DELETE]', e);
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/announcements/:id', e, 'Não foi possível apagar o aviso.');
    }
  };

  app.get('/api/admin/announcements', isAdmin, listAdminHandler);
  app.post('/api/admin/announcements', isAdmin, adminMutateLimiter, createAdminHandler);
  app.put('/api/admin/announcements/:id', isAdmin, adminMutateLimiter, updateAdminHandler);
  app.delete('/api/admin/announcements/:id', isAdmin, adminMutateLimiter, deleteAdminHandler);

  app.get('/api/admin/in-app-announcements', isAdmin, listAdminHandler);
  app.post('/api/admin/in-app-announcements', isAdmin, adminMutateLimiter, createAdminHandler);
  app.put('/api/admin/in-app-announcements/:id', isAdmin, adminMutateLimiter, updateAdminHandler);
  app.delete('/api/admin/in-app-announcements/:id', isAdmin, adminMutateLimiter, deleteAdminHandler);
}
