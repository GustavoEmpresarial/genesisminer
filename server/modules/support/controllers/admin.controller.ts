/**
 * Rotas admin de suporte (`/api/admin/support-tickets*`,
 * `/api/admin/support/*`).
 *
 * Migrado de legacy/backend/controllers/supportTicketController.ts (rotas
 * admin — as de jogador são servidas por genesis-api).
 *
 * ⚠️ Corte de escopo: o legado chama `compressUploadedMulterFiles` (imagem +
 * vídeo) antes de guardar os anexos da resposta admin. Só a variante de
 * imagem foi portada (`modules/admin/image-asset/services/compress-media.ts`,
 * ver o próprio ficheiro para o porquê do vídeo ter ficado de fora) e essa
 * variante recomprime um ficheiro de cada vez, não uma lista do multer — para
 * manter esta rota simples e sem duplicar lógica de best-effort, a
 * recompressão foi omitida aqui: os anexos de resposta admin ficam guardados
 * sem otimização de tamanho (mesmo comportamento visual, ficheiro maior).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { Express, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { prisma } from '../../../core/database/prisma.js';
import { sendInternalErrorSafeMessageOrPrisma } from '../../../core/http/error-response.js';
import { resolveRequestUserId as uidNum } from '../../../core/http/request-user-id.js';
import { findUserByEmail } from '../../auth/models/repository.js';
import { validateLoginEmail } from '../../auth/services/login-validation.js';
import { pipeSupportFilesToWorker, sendSupportMulterError } from '../services/attachments.js';
import { SUPPORT_ALLOWED_EXT, SUPPORT_UPLOAD_MAX_BYTES, SUPPORT_UPLOAD_MAX_FILES } from '../services/limits.js';
import {
  getAdminTicketListRowById,
  getTicketForAdminReply,
  getUserSupportTicketStats,
  insertSupportAdminReply,
  listAdminRepliesForTicketIds,
  listPlayerRepliesForTicketIds,
  listTicketsForAdmin,
  listUserSupportTicketHistorySummaries,
  updateSupportTicketStatus,
  type AdminTicketListRow
} from '../services/ticket-model.js';

export type SupportAdminModuleDeps = {
  isAdmin: RequestHandler;
  uploadsDir: string;
};

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;

const TICKET_ID_MAX_LENGTH = 80;
const MESSAGE_MAX_LENGTH = 8000;
const MESSAGE_MIN_LENGTH_REPLY = 3;
const ADMIN_TICKETS_DEFAULT_LIMIT = 100;
const ADMIN_TICKETS_MAX_LIMIT = 300;
const USER_HISTORY_DEFAULT_LIMIT = 100;
const USER_HISTORY_MAX_LIMIT = 200;
const PREVIEW_TEXT_MAX_LENGTH = 160;
function asJsonArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function attachmentsNonEmpty(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

function previewText(message: string, max: number = PREVIEW_TEXT_MAX_LENGTH): string {
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function mapAdminReplyRow(row: {
  id: string;
  admin_user_id: number;
  message: string;
  attachments: unknown;
  created_at: unknown;
  admin_username: string;
}) {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    adminUsername: row.admin_username,
    message: row.message,
    attachments: asJsonArray(row.attachments),
    createdAt: Number(row.created_at) || 0
  };
}

function toAdminTicketResponse(
  r: AdminTicketListRow,
  repliesByTicket: Record<string, ReturnType<typeof mapAdminReplyRow>[]>,
  playerRepliesByTicket: Record<string, { id: string; message: string; attachments: unknown[]; createdAt: number }[]>
) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    email: r.email,
    subject: r.subject,
    message: r.message,
    attachments: asJsonArray(r.attachments),
    status: r.status,
    createdAt: Number(r.created_at) || 0,
    replies: repliesByTicket[r.id] || [],
    playerReplies: playerRepliesByTicket[r.id] || []
  };
}

async function buildAdminTicketsPayload(adminTicketRows: AdminTicketListRow[]) {
  const ids = adminTicketRows.map((r) => r.id);
  const repliesByTicket: Record<string, ReturnType<typeof mapAdminReplyRow>[]> = {};
  const playerRepliesByTicket: Record<
    string,
    { id: string; message: string; attachments: unknown[]; createdAt: number }[]
  > = {};
  if (ids.length > 0) {
    const repRows = await listAdminRepliesForTicketIds(ids);
    for (const row of repRows) {
      const tid = row.ticket_id;
      if (!repliesByTicket[tid]) repliesByTicket[tid] = [];
      repliesByTicket[tid].push(mapAdminReplyRow(row));
    }
    const prRows = await listPlayerRepliesForTicketIds(ids);
    for (const row of prRows) {
      const tid = row.ticket_id;
      if (!playerRepliesByTicket[tid]) playerRepliesByTicket[tid] = [];
      playerRepliesByTicket[tid].push({
        id: row.id,
        message: row.message,
        attachments: asJsonArray(row.attachments),
        createdAt: Number(row.created_at) || 0
      });
    }
  }
  return adminTicketRows.map((r) => toAdminTicketResponse(r, repliesByTicket, playerRepliesByTicket));
}

/** Multer em memória; disco fica no mining-worker (`support-reply-` prefix). */
function createUploadSupportReply(): ReturnType<typeof multer> {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SUPPORT_UPLOAD_MAX_BYTES, files: SUPPORT_UPLOAD_MAX_FILES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (SUPPORT_ALLOWED_EXT.has(ext)) {
        cb(null, true);
        return;
      }
      cb(new Error('Tipo de ficheiro não permitido (imagens ou vídeo mp4/webm/mov).'));
    }
  });
}

export function registerSupportAdminModuleRoutes(app: Express, deps: SupportAdminModuleDeps): void {
  const { isAdmin } = deps;
  const uploadSupportReply = createUploadSupportReply();

  app.get('/api/admin/support-tickets', isAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(
        ADMIN_TICKETS_MAX_LIMIT,
        Math.max(1, parseInt(String(req.query.limit || String(ADMIN_TICKETS_DEFAULT_LIMIT)), 10) || ADMIN_TICKETS_DEFAULT_LIMIT)
      );
      const adminTicketRows = await listTicketsForAdmin(limit);
      const rows = await buildAdminTicketsPayload(adminTicketRows);
      res.status(HTTP_OK).json({ tickets: rows });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/support-tickets', e, 'Erro ao listar tickets.');
    }
  });

  app.get('/api/admin/support/user-history', isAdmin, async (req: Request, res: Response) => {
    const emailRaw = String(req.query.email ?? '').trim();
    if (!emailRaw) {
      res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Informe um email para buscar.' });
      return;
    }
    const emailCheck = validateLoginEmail(emailRaw);
    if (!emailCheck.ok) {
      res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Email inválido.' });
      return;
    }
    const normalizedEmail = emailRaw.trim().toLowerCase();
    try {
      const user = await findUserByEmail(normalizedEmail);
      if (!user) {
        res.status(HTTP_NOT_FOUND).json({ ok: false, error: 'Usuário não encontrado.' });
        return;
      }
      const userId = Number(user.id);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(HTTP_NOT_FOUND).json({ ok: false, error: 'Usuário não encontrado.' });
        return;
      }
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limit = Math.min(
        USER_HISTORY_MAX_LIMIT,
        Math.max(1, parseInt(String(req.query.limit || String(USER_HISTORY_DEFAULT_LIMIT)), 10) || USER_HISTORY_DEFAULT_LIMIT)
      );
      const offset = (page - 1) * limit;

      const [stats, summaryRows, gameState] = await Promise.all([
        getUserSupportTicketStats(userId),
        listUserSupportTicketHistorySummaries(userId, { limit, offset }),
        prisma.game_states.findUnique({ where: { user_id: userId }, select: { start_time: true } })
      ]);

      const ticketIds = summaryRows.map((r) => r.id);
      const replyAttachmentIds = new Set<string>();
      if (ticketIds.length > 0) {
        const repRows = await listAdminRepliesForTicketIds(ticketIds);
        const prRows = await listPlayerRepliesForTicketIds(ticketIds);
        for (const row of [...repRows, ...prRows]) {
          if (attachmentsNonEmpty(row.attachments)) {
            replyAttachmentIds.add(row.ticket_id);
          }
        }
      }

      const tickets = summaryRows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        createdAt: Number(r.created_at) || 0,
        updatedAt: Number(r.last_message_at) || Number(r.created_at) || 0,
        lastMessageAt: Number(r.last_message_at) || Number(r.created_at) || 0,
        messageCount: Number(r.message_count) || 1,
        hasAttachments: attachmentsNonEmpty(r.attachments) || replyAttachmentIds.has(r.id),
        assignedTo: r.last_admin_username || null,
        preview: previewText(r.message)
      }));

      const accountCreatedAt =
        gameState?.start_time != null && Number(gameState.start_time) > 0 ? Number(gameState.start_time) : null;

      res.status(HTTP_OK).json({
        ok: true,
        user: {
          id: userId,
          email: String(user.email ?? normalizedEmail),
          username: String(user.username ?? ''),
          createdAt: accountCreatedAt
        },
        summary: {
          total: Number(stats.total) || 0,
          open: Number(stats.open_count) || 0,
          archived: Number(stats.archived_count) || 0,
          lastTicketAt: Number(stats.last_ticket_at) || 0
        },
        pagination: {
          page,
          limit,
          hasMore: offset + summaryRows.length < (Number(stats.total) || 0)
        },
        tickets
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/support/user-history', e, 'Erro ao buscar histórico.');
    }
  });

  app.get('/api/admin/support/tickets/:ticketId', isAdmin, async (req: Request, res: Response) => {
    const ticketId = String(req.params.ticketId || '').trim().slice(0, TICKET_ID_MAX_LENGTH);
    if (!ticketId) {
      res.status(HTTP_BAD_REQUEST).json({ ok: false, error: 'Pedido inválido.' });
      return;
    }
    try {
      const row = await getAdminTicketListRowById(ticketId);
      if (!row) {
        res.status(HTTP_NOT_FOUND).json({ ok: false, error: 'Ticket não encontrado.' });
        return;
      }
      const [ticket] = await buildAdminTicketsPayload([row]);
      res.status(HTTP_OK).json({ ok: true, ticket });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/support/tickets/:ticketId', e, 'Erro ao carregar ticket.');
    }
  });

  app.post('/api/admin/support-tickets/status', isAdmin, async (req: Request, res: Response) => {
    const body = req.body as { id?: unknown; status?: unknown } | undefined;
    const id = body?.id;
    const status = body?.status;
    if (!id || typeof id !== 'string') {
      res.status(HTTP_BAD_REQUEST).json({ error: 'id obrigatório.' });
      return;
    }
    const st = status === 'archived' ? 'archived' : 'open';
    try {
      const updated = await updateSupportTicketStatus(st, id);
      if (updated === 0) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Ticket não encontrado.' });
        return;
      }
      res.status(HTTP_OK).json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/support-tickets/status', e, 'Erro ao atualizar estado.');
    }
  });

  app.post('/api/admin/support-tickets/reply', isAdmin, (req: Request, res: Response) => {
    uploadSupportReply.array('files', SUPPORT_UPLOAD_MAX_FILES)(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        sendSupportMulterError(res, uploadErr);
        return;
      }
      const adminId = uidNum(req);
      if (!adminId) {
        res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
        return;
      }
      const ticketIdRaw = req.body?.ticketId != null ? String(req.body.ticketId) : '';
      const ticketId = ticketIdRaw.trim().slice(0, TICKET_ID_MAX_LENGTH);
      if (!ticketId) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'ticketId obrigatório.' });
        return;
      }
      const messageRaw = req.body?.message != null ? String(req.body.message) : '';
      const message = messageRaw.trim().slice(0, MESSAGE_MAX_LENGTH);
      const files = req.files as Express.Multer.File[] | undefined;
      const arr = Array.isArray(files) ? files : [];
      if (message.length < MESSAGE_MIN_LENGTH_REPLY && arr.length === 0) {
        res.status(HTTP_BAD_REQUEST).json({
          error: 'Escreva uma mensagem (mín. 3 caracteres) ou anexe ficheiros.'
        });
        return;
      }
      const piped = await pipeSupportFilesToWorker({
        files,
        userId: adminId,
        namePrefix: 'support-reply'
      });
      if ('error' in piped) {
        res.status(piped.status || HTTP_BAD_REQUEST).json({ error: piped.error, code: piped.code });
        return;
      }
      const { list: attachments } = piped;
      try {
        const t = await getTicketForAdminReply(ticketId);
        if (!t) {
          res.status(HTTP_NOT_FOUND).json({ error: 'Ticket não encontrado.' });
          return;
        }
        const replyId = crypto.randomUUID();
        const now = Date.now();
        await insertSupportAdminReply({
          replyId,
          ticketId,
          adminUserId: adminId,
          message,
          attachmentsJson: JSON.stringify(attachments),
          createdAt: now
        });
        res.status(HTTP_OK).json({ ok: true, id: replyId });
      } catch (e) {
        sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/support-tickets/reply', e, 'Erro ao registar a resposta.');
      }
    });
  });
}
