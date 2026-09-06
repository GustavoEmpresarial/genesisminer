/** Migrado de legacy/backend/modules/support/supportState.service.ts (verbatim). */
import { callMiningWorkerSupportState } from '../../mining-engine/services/mining-worker-client.js';
import { SUPPORT_ALLOWED_EXT, SUPPORT_UPLOAD_MAX_BYTES, SUPPORT_UPLOAD_MAX_FILES } from './limits.js';
import { listMySupportTicketSummaries, type SupportTicketSummaryRow } from './ticket-model.js';

const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
const SUBJECT_MAX_LENGTH = 180;
const MESSAGE_MAX_LENGTH = 8000;

export type SupportPlayerTicketListItem = {
  publicId: string;
  subject: string;
  status: string;
  statusLabel: string;
  createdAt: number;
  adminReplyCount: number;
  lastActivityAt: number;
  unreadStaffReply: boolean;
};

export function mapSupportSummariesToPlayerTickets(summaries: SupportTicketSummaryRow[], pageLimit: number): { tickets: SupportPlayerTicketListItem[]; pagination: { limit: number; nextCursor: string | null } } {
  const tickets: SupportPlayerTicketListItem[] = summaries.map((r) => {
    const createdAt = Number(r.created_at) || 0;
    const lastAdmin = Number(r.last_admin_at) || 0;
    const lastPlayer = Number(r.last_player_at) || 0;
    const lastActivityAt = Math.max(createdAt, lastAdmin, lastPlayer);
    const adminCount = r.admin_reply_count ?? 0;
    const unreadStaff = adminCount > 0 && lastAdmin > 0 && (lastPlayer === 0 ? lastAdmin > createdAt : lastAdmin > lastPlayer);
    return {
      publicId: r.id,
      subject: r.subject,
      status: r.status,
      statusLabel: r.status === 'archived' ? 'Arquivado' : r.status === 'open' ? 'Aberto' : String(r.status),
      createdAt,
      adminReplyCount: adminCount,
      lastActivityAt,
      unreadStaffReply: unreadStaff
    };
  });
  const nextCursor = summaries.length === pageLimit ? String(Number(summaries[summaries.length - 1]!.created_at) || 0) : null;
  return { tickets, pagination: { limit: pageLimit, nextCursor } };
}

export async function listSupportTicketsPageForPlayer(userId: number, query: { limit?: string; cursor?: string }): Promise<{ tickets: SupportPlayerTicketListItem[]; pagination: { limit: number; nextCursor: string | null } }> {
  const lim = Math.min(MAX_PAGE, Math.max(1, parseInt(String(query.limit || String(DEFAULT_PAGE)), 10) || DEFAULT_PAGE));
  const cursorRaw = String(query.cursor || '').trim();
  const cursorBi = cursorRaw && /^\d+$/.test(cursorRaw) ? BigInt(cursorRaw) : null;
  const summaries = await listMySupportTicketSummaries(userId, { limit: lim, cursorCreatedAt: cursorBi });
  return mapSupportSummariesToPlayerTickets(summaries, lim);
}

const EMAIL_HINT_PREFIX_LENGTH = 3;

function maskEmailHint(email: string): string {
  const e = String(email).trim();
  const at = e.indexOf('@');
  if (at <= 1) return `${e.slice(0, EMAIL_HINT_PREFIX_LENGTH)}…`;
  return `${e[0]}…${e.slice(at - 1)}`;
}

export async function buildSupportStatePayload(userId: number, query: { limit?: string; cursor?: string }): Promise<Record<string, unknown>> {
  const lim = Math.min(MAX_PAGE, Math.max(1, parseInt(String(query.limit || String(DEFAULT_PAGE)), 10) || DEFAULT_PAGE));
  const cursorRaw = String(query.cursor || '').trim();
  const cursorBi = cursorRaw && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;

  const out = await callMiningWorkerSupportState({
    userId,
    limit: lim,
    ...(cursorBi != null ? { cursorCreatedAt: cursorBi } : {})
  });
  const summaries: SupportTicketSummaryRow[] = out.summaries.map((r) => ({
    id: r.id,
    subject: r.subject,
    status: r.status,
    created_at: r.createdAt,
    admin_reply_count: r.adminReplyCount,
    last_admin_at: r.lastAdminAt,
    last_player_at: r.lastPlayerAt
  }));

  const { tickets, pagination } = mapSupportSummariesToPlayerTickets(summaries, lim);
  const unreadStaffReplyCount = tickets.filter((t) => t.unreadStaffReply).length;

  return {
    ok: true,
    account: { emailHint: out.email ? maskEmailHint(out.email) : null, username: out.username ?? null },
    limits: { maxAttachmentBytes: SUPPORT_UPLOAD_MAX_BYTES, maxAttachmentCount: SUPPORT_UPLOAD_MAX_FILES, maxSubjectLength: SUBJECT_MAX_LENGTH, maxMessageLength: MESSAGE_MAX_LENGTH },
    allowedExtensions: Array.from(SUPPORT_ALLOWED_EXT).sort(),
    tickets,
    pagination,
    unreadStaffReplyCount,
    notice: 'Anexos: imagens e vídeo (png, jpeg, webp, gif, mp4, webm, mov). Validação final no servidor. Use idempotencyKey ao criar pedidos.'
  };
}
