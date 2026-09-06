/**
 * Migrado de legacy/backend/models/supportTicketModel.ts — inclui o
 * subconjunto usado pelas rotas de jogador e, agora, as funções de admin
 * (listar/responder tickets, stats, histórico por utilizador) usadas pelo
 * painel admin (`controllers/admin.controller.ts`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import {
  callMiningWorkerSupportAdminGet,
  callMiningWorkerSupportAdminHistory,
  callMiningWorkerSupportAdminList,
  callMiningWorkerSupportAdminReply,
  callMiningWorkerSupportAdminStats,
  callMiningWorkerSupportArchive,
  callMiningWorkerSupportAttachmentReferenced,
  callMiningWorkerSupportGet,
  callMiningWorkerSupportListMine,
  callMiningWorkerSupportReopen,
  callMiningWorkerSupportTicketForPlayer,
  type MiningWorkerSupportAdminReply,
  type MiningWorkerSupportAdminTicket,
  type MiningWorkerSupportHistorySummary,
  type MiningWorkerSupportPlayerReply,
  type MiningWorkerSupportSummary,
  type MiningWorkerSupportTicketDetail
} from '../../mining-engine/services/mining-worker-client.js';

export type SupportTicketSummaryRow = {
  id: string;
  subject: string;
  status: string;
  created_at: unknown;
  admin_reply_count: number;
  last_admin_at: unknown;
  last_player_at: unknown;
};

export async function insertSupportTicket(params: { id: string; userId: number; subject: string; message: string; attachmentsJson: string; createdAt: number }): Promise<void> {
  await insertSupportTicketInTx(prisma, params);
}

export async function insertSupportTicketInTx(tx: Prisma.TransactionClient, params: { id: string; userId: number; subject: string; message: string; attachmentsJson: string; createdAt: number }): Promise<void> {
  let attachments: Prisma.InputJsonValue;
  try {
    attachments = JSON.parse(params.attachmentsJson) as Prisma.InputJsonValue;
  } catch {
    attachments = [];
  }
  await tx.support_tickets.create({
    data: { id: params.id, user_id: params.userId, subject: params.subject, message: params.message, attachments, status: 'open', created_at: BigInt(params.createdAt) }
  });
}

function summaryFromWorker(r: MiningWorkerSupportSummary): SupportTicketSummaryRow {
  return {
    id: r.id,
    subject: r.subject,
    status: r.status,
    created_at: r.createdAt,
    admin_reply_count: r.adminReplyCount,
    last_admin_at: r.lastAdminAt,
    last_player_at: r.lastPlayerAt
  };
}

function ticketFromWorker(r: MiningWorkerSupportTicketDetail): SupportTicketRow {
  return {
    id: r.id,
    user_id: r.userId,
    subject: r.subject,
    message: r.message,
    attachments: r.attachments,
    status: r.status,
    created_at: r.createdAt
  };
}

function adminTicketFromWorker(r: MiningWorkerSupportAdminTicket): AdminTicketListRow {
  return { ...ticketFromWorker(r), username: r.username, email: r.email };
}

function adminReplyFromWorker(r: MiningWorkerSupportAdminReply): AdminReplyBatchRow {
  return {
    id: r.id,
    ticket_id: r.ticketId ?? '',
    admin_user_id: r.adminUserId ?? 0,
    message: r.message,
    attachments: r.attachments,
    created_at: r.createdAt,
    admin_username: r.adminUsername
  };
}

function playerReplyFromWorker(r: MiningWorkerSupportPlayerReply): PlayerReplyBatchRow {
  return {
    id: r.id,
    ticket_id: r.ticketId ?? '',
    message: r.message,
    attachments: r.attachments,
    created_at: r.createdAt
  };
}

function historyFromWorker(r: MiningWorkerSupportHistorySummary): UserSupportHistorySummaryRow {
  return {
    id: r.id,
    subject: r.subject,
    status: r.status,
    message: r.message,
    attachments: r.attachments,
    created_at: r.createdAt,
    message_count: r.messageCount,
    last_message_at: r.lastMessageAt,
    last_admin_username: r.lastAdminUsername
  };
}

export async function listMySupportTicketSummaries(userId: number, opts?: { limit?: number; cursorCreatedAt?: bigint | null }): Promise<SupportTicketSummaryRow[]> {
  const out = await callMiningWorkerSupportListMine({
    userId,
    ...(opts?.limit != null ? { limit: opts.limit } : {}),
    ...(opts?.cursorCreatedAt != null ? { cursorCreatedAt: Number(opts.cursorCreatedAt) } : {})
  });
  return out.summaries.map(summaryFromWorker);
}

/** Arquivar/reabrir apenas se o ticket pertencer ao utilizador. */
export async function updateSupportTicketStatusForUser(ticketId: string, userId: number, nextStatus: 'archived' | 'open', currentMustBe: 'open' | 'archived'): Promise<number> {
  const out =
    nextStatus === 'archived' && currentMustBe === 'open'
      ? await callMiningWorkerSupportArchive({ userId, ticketId })
      : await callMiningWorkerSupportReopen({ userId, ticketId });
  return out.updated;
}

export type SupportTicketRow = {
  id: string;
  user_id: number;
  subject: string;
  message: string;
  attachments: unknown;
  status: string;
  created_at: unknown;
};

export async function getTicketForPlayerAction(ticketId: string): Promise<{ id: string; user_id: number; status: string } | null> {
  return callMiningWorkerSupportTicketForPlayer(ticketId);
}

export async function getOwnedSupportTicketBundle(
  userId: number,
  ticketId: string
): Promise<{
  ticket: SupportTicketRow;
  adminReplies: SupportTicketReplyDbRow[];
  playerReplies: SupportTicketPlayerReplyDbRow[];
} | null> {
  const out = await callMiningWorkerSupportGet({ userId, ticketId });
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return null;
    throw new Error(out.error);
  }
  return {
    ticket: ticketFromWorker(out.ticket),
    adminReplies: out.adminReplies.map((r) => ({
      id: r.id,
      message: r.message,
      attachments: r.attachments,
      created_at: r.createdAt,
      admin_username: r.adminUsername
    })),
    playerReplies: out.playerReplies.map((r) => ({
      id: r.id,
      message: r.message,
      attachments: r.attachments,
      created_at: r.createdAt
    }))
  };
}

export async function getSupportTicketById(ticketId: string): Promise<SupportTicketRow | null> {
  const out = await callMiningWorkerSupportAdminGet(ticketId);
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return null;
    throw new Error(out.error);
  }
  return ticketFromWorker(out.ticket);
}

export type SupportTicketReplyDbRow = {
  id: string;
  message: string;
  attachments: unknown;
  created_at: unknown;
  admin_username: string;
};

export type SupportTicketPlayerReplyDbRow = {
  id: string;
  message: string;
  attachments: unknown;
  created_at: unknown;
};

export async function listAdminRepliesForTicket(ticketId: string): Promise<SupportTicketReplyDbRow[]> {
  const out = await callMiningWorkerSupportAdminGet(ticketId);
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return [];
    throw new Error(out.error);
  }
  return out.adminReplies.map((r) => ({
    id: r.id,
    message: r.message,
    attachments: r.attachments,
    created_at: r.createdAt,
    admin_username: r.adminUsername
  }));
}

export async function listPlayerRepliesForTicket(ticketId: string): Promise<SupportTicketPlayerReplyDbRow[]> {
  const out = await callMiningWorkerSupportAdminGet(ticketId);
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return [];
    throw new Error(out.error);
  }
  return out.playerReplies.map((r) => ({
    id: r.id,
    message: r.message,
    attachments: r.attachments,
    created_at: r.createdAt
  }));
}

// eslint-disable-next-line no-control-regex -- uso deliberado: rejeita caracteres de controlo em nomes de ficheiro vindos de query string.
const CONTROL_CHARS_OR_QUOTE_RE = /["\\\x00-\x1f]/;

/**
 * Confirma que `storedName` está mesmo referenciado nos anexos deste ticket
 * (ticket + respostas admin + respostas do jogador) — impede adivinhar nomes
 * de ficheiro de outro ticket via `GET /api/support/attachments/download`.
 */
export async function supportStoredNameReferencedOnTicket(ticketId: string, storedName: string): Promise<boolean> {
  if (!storedName || CONTROL_CHARS_OR_QUOTE_RE.test(storedName)) return false;
  return callMiningWorkerSupportAttachmentReferenced({ ticketId, storedName });
}

export async function insertSupportPlayerReply(params: { replyId: string; ticketId: string; userId: number; message: string; attachmentsJson: string; createdAt: number }): Promise<void> {
  await insertSupportPlayerReplyInTx(prisma, params);
}

export async function insertSupportPlayerReplyInTx(tx: Prisma.TransactionClient, params: { replyId: string; ticketId: string; userId: number; message: string; attachmentsJson: string; createdAt: number }): Promise<void> {
  let attachments: Prisma.InputJsonValue;
  try {
    attachments = JSON.parse(params.attachmentsJson) as Prisma.InputJsonValue;
  } catch {
    attachments = [];
  }
  await tx.support_ticket_player_replies.create({
    data: { id: params.replyId, ticket_id: params.ticketId, user_id: params.userId, message: params.message, attachments, created_at: BigInt(params.createdAt) }
  });
}

// ---------------------------------------------------------------------------
// Admin (painel de suporte da equipa) — migrado das funções admin-only de
// legacy/backend/models/supportTicketModel.ts.
// ---------------------------------------------------------------------------

export type AdminTicketListRow = SupportTicketRow & {
  username: string;
  email: string;
};

export type AdminReplyBatchRow = {
  id: string;
  ticket_id: string;
  admin_user_id: number;
  message: string;
  attachments: unknown;
  created_at: unknown;
  admin_username: string;
};

export type PlayerReplyBatchRow = {
  id: string;
  ticket_id: string;
  message: string;
  attachments: unknown;
  created_at: unknown;
};

export type UserSupportHistorySummaryRow = {
  id: string;
  subject: string;
  status: string;
  message: string;
  attachments: unknown;
  created_at: unknown;
  message_count: number;
  last_message_at: unknown;
  last_admin_username: string | null;
};

export type UserSupportTicketStatsRow = {
  total: number;
  open_count: number;
  archived_count: number;
  last_ticket_at: unknown;
};

export async function listTicketsForAdmin(limit: number): Promise<AdminTicketListRow[]> {
  const out = await callMiningWorkerSupportAdminList({ limit });
  return out.tickets.map(adminTicketFromWorker);
}

export async function getAdminTicketListRowById(ticketId: string): Promise<AdminTicketListRow | null> {
  const out = await callMiningWorkerSupportAdminGet(ticketId);
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return null;
    throw new Error(out.error);
  }
  return adminTicketFromWorker(out.ticket);
}

export async function listAdminRepliesForTicketIds(ticketIds: string[]): Promise<AdminReplyBatchRow[]> {
  if (ticketIds.length === 0) return [];
  const out = await callMiningWorkerSupportAdminList({ ticketIds });
  return out.adminReplies.map(adminReplyFromWorker);
}

export async function listPlayerRepliesForTicketIds(ticketIds: string[]): Promise<PlayerReplyBatchRow[]> {
  if (ticketIds.length === 0) return [];
  const out = await callMiningWorkerSupportAdminList({ ticketIds });
  return out.playerReplies.map(playerReplyFromWorker);
}

/** Número de linhas atualizadas (0 se o ticket não existir). */
export async function updateSupportTicketStatus(status: string, id: string): Promise<number> {
  const r = await prisma.support_tickets.updateMany({ where: { id }, data: { status } });
  return r.count;
}

export async function getTicketForAdminReply(ticketId: string): Promise<{ id: string; user_id: number } | null> {
  const t = await callMiningWorkerSupportTicketForPlayer(ticketId);
  if (!t) return null;
  return { id: t.id, user_id: t.user_id };
}

export async function insertSupportAdminReply(params: {
  replyId: string;
  ticketId: string;
  adminUserId: number;
  message: string;
  attachmentsJson: string;
  createdAt: number;
}): Promise<void> {
  const out = await callMiningWorkerSupportAdminReply(params);
  if (!out.ok) {
    throw new Error(out.error);
  }
}

/** Histórico completo de tickets de um utilizador (admin), mais recente primeiro. */
export async function listUserSupportTicketHistorySummaries(
  userId: number,
  opts?: { limit?: number; offset?: number }
): Promise<UserSupportHistorySummaryRow[]> {
  const out = await callMiningWorkerSupportAdminHistory({
    userId,
    ...(opts?.limit != null ? { limit: opts.limit } : {}),
    ...(opts?.offset != null ? { offset: opts.offset } : {})
  });
  return out.summaries.map(historyFromWorker);
}

export async function getUserSupportTicketStats(userId: number): Promise<UserSupportTicketStatsRow> {
  const out = await callMiningWorkerSupportAdminStats(userId);
  return {
    total: out.total,
    open_count: out.openCount,
    archived_count: out.archivedCount,
    last_ticket_at: out.lastTicketAt
  };
}
