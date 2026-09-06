/**
 * API de tickets de suporte (isolado de api.ts para deploy simples: copiar este ficheiro + reexports em api.ts).
 */
import { apiFetch } from './http';

const API_BASE = '/api';

const SUPPORT_PAYLOAD_TOO_LARGE_PT =
  'Os anexos excedem o limite permitido. Cada ficheiro pode ter até 12 MB (até 5 anexos). Tenta comprimir ou enviar menos ficheiros.';

function supportErrorFromJson(res: Response, data: Record<string, unknown>): string {
  if (res.status === 413) return SUPPORT_PAYLOAD_TOO_LARGE_PT;
  const err = data.error;
  if (typeof err === 'string' && err.trim()) return err;
  return `HTTP ${res.status}`;
}

export type SupportTicketAttachment = { url: string; originalName: string; mime: string };

export type SupportTicketReplyRow = {
  id: string;
  adminUserId: number;
  adminUsername: string;
  message: string;
  attachments: SupportTicketAttachment[];
  createdAt: number;
};

export type SupportTicketPlayerReplyRow = {
  id: string;
  message: string;
  attachments: SupportTicketAttachment[];
  createdAt: number;
};

export type SupportTicketRow = {
  id: string;
  userId: number;
  username: string;
  email: string;
  subject: string;
  message: string;
  attachments: SupportTicketAttachment[];
  status: string;
  createdAt: number;
  replies: SupportTicketReplyRow[];
  playerReplies?: SupportTicketPlayerReplyRow[];
};

export type MySupportTicketSummary = {
  id: string;
  subject: string;
  status: string;
  createdAt: number;
  adminReplyCount: number;
  lastActivityAt: number;
  unreadStaffReply?: boolean;
};

export type MySupportTicketDetail = {
  ticket: {
    id: string;
    subject: string;
    message: string;
    attachments: SupportTicketAttachment[];
    status: string;
    createdAt: number;
  };
  adminReplies: Array<{
    id: string;
    adminUsername: string;
    message: string;
    attachments: SupportTicketAttachment[];
    createdAt: number;
  }>;
  playerReplies: SupportTicketPlayerReplyRow[];
};

export type SupportStateTicketRow = {
  publicId: string;
  subject: string;
  status: string;
  statusLabel: string;
  createdAt: number;
  adminReplyCount: number;
  lastActivityAt: number;
  unreadStaffReply: boolean;
};

export type SupportStatePayload = {
  ok?: boolean;
  account?: { emailHint: string | null; username: string | null };
  limits?: {
    maxAttachmentBytes: number;
    maxAttachmentCount: number;
    maxSubjectLength: number;
    maxMessageLength: number;
  };
  allowedExtensions?: string[];
  tickets?: SupportStateTicketRow[];
  pagination?: { limit: number; nextCursor: string | null };
  unreadStaffReplyCount?: number;
  notice?: string;
};

/** Chave 8–128 caracteres `[a-zA-Z0-9_.:-]` alinhada ao `parseIdempotencyKey` do backend. */
export function newSupportIdempotencyKey(): string {
  const u =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = `sup:${u}`;
  const safe = raw.replace(/[^a-zA-Z0-9_.:-]/g, 'x');
  return safe.length >= 8 ? safe.slice(0, 128) : `sup:${safe}xxxxxxxx`.slice(0, 36);
}

export async function getSupportState(query?: { limit?: string; cursor?: string }): Promise<SupportStatePayload | null> {
  const qs = new URLSearchParams();
  if (query?.limit) qs.set('limit', query.limit);
  if (query?.cursor) qs.set('cursor', query.cursor);
  const q = qs.toString();
  try {
    const res = await apiFetch(`${API_BASE}/support/state${q ? `?${q}` : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as SupportStatePayload;
  } catch {
    return null;
  }
}

/** `multipart/form-data` com `action` (`submit_ticket` | `player_reply`) — legado. */
export async function postSupportMutate(
  fd: FormData
): Promise<{ ok: boolean; id?: string; error?: string; code?: string; idempotentReplay?: boolean }> {
  try {
    const res = await apiFetch(`${API_BASE}/support/mutate`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: supportErrorFromJson(res, data),
        code: typeof data.code === 'string' ? data.code : undefined
      };
    }
    const id = typeof data.id === 'string' ? data.id : undefined;
    return {
      ok: true,
      id,
      idempotentReplay: data.idempotentReplay === true
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function submitSupportTicket(payload: {
  subject: string;
  message: string;
  files?: File[];
  idempotencyKey?: string;
}): Promise<{ ok: boolean; id?: string; error?: string; idempotentReplay?: boolean }> {
  const fd = new FormData();
  fd.set('subject', payload.subject);
  fd.set('message', payload.message);
  fd.set('idempotencyKey', payload.idempotencyKey || newSupportIdempotencyKey());
  for (const f of payload.files || []) {
    if (f && f.size > 0) fd.append('files', f);
  }
  try {
    const res = await apiFetch(`${API_BASE}/support/tickets`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: supportErrorFromJson(res, data),
        idempotentReplay: data.idempotentReplay === true
      };
    }
    const id = typeof data.publicId === 'string' ? data.publicId : typeof data.id === 'string' ? data.id : undefined;
    return { ok: true, id, idempotentReplay: data.idempotentReplay === true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getAdminSupportTickets(): Promise<{ tickets: SupportTicketRow[] }> {
  const res = await apiFetch(`${API_BASE}/admin/support-tickets`);
  if (!res.ok) return { tickets: [] };
  try {
    const data = (await res.json()) as { tickets?: SupportTicketRow[] };
    const raw = Array.isArray(data.tickets) ? data.tickets : [];
    const tickets = raw.map((t) => ({
      ...t,
      replies: Array.isArray(t.replies) ? t.replies : [],
      playerReplies: Array.isArray(t.playerReplies) ? t.playerReplies : [],
      attachments: Array.isArray(t.attachments) ? t.attachments : [],
    }));
    return { tickets };
  } catch {
    return { tickets: [] };
  }
}

export async function postAdminSupportTicketReply(payload: {
  ticketId: string;
  message: string;
  files?: File[];
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const fd = new FormData();
  fd.set('ticketId', payload.ticketId);
  fd.set('message', payload.message);
  for (const f of payload.files || []) {
    if (f && f.size > 0) fd.append('files', f);
  }
  try {
    const res = await apiFetch(`${API_BASE}/admin/support-tickets/reply`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: supportErrorFromJson(res, data) };
    return { ok: true, id: typeof data.id === 'string' ? data.id : undefined };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getMySupportTickets(params?: {
  limit?: number;
  cursor?: string;
}): Promise<{ tickets: MySupportTicketSummary[]; pagination?: { limit: number; nextCursor: string | null } }> {
  const qs = new URLSearchParams();
  if (params?.limit != null) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  const q = qs.toString();
  const res = await apiFetch(`${API_BASE}/support/my-tickets${q ? `?${q}` : ''}`);
  if (!res.ok) return { tickets: [] };
  try {
    const data = (await res.json()) as {
      tickets?: MySupportTicketSummary[];
      pagination?: { limit: number; nextCursor: string | null };
    };
    return {
      tickets: Array.isArray(data.tickets) ? data.tickets : [],
      pagination: data.pagination
    };
  } catch {
    return { tickets: [] };
  }
}

export async function getMySupportTicketDetail(ticketId: string): Promise<MySupportTicketDetail | null> {
  const res = await apiFetch(`${API_BASE}/support/tickets/${encodeURIComponent(ticketId)}`);
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as MySupportTicketDetail;
    if (!data?.ticket?.id) return null;
    return {
      ticket: data.ticket,
      adminReplies: Array.isArray(data.adminReplies) ? data.adminReplies : [],
      playerReplies: Array.isArray(data.playerReplies) ? data.playerReplies : [],
    };
  } catch {
    return null;
  }
}

export async function postPlayerSupportTicketReply(payload: {
  ticketId: string;
  message: string;
  files?: File[];
  idempotencyKey?: string;
}): Promise<{ ok: boolean; id?: string; error?: string; idempotentReplay?: boolean }> {
  const fd = new FormData();
  fd.set('message', payload.message);
  fd.set('idempotencyKey', payload.idempotencyKey || newSupportIdempotencyKey());
  for (const f of payload.files || []) {
    if (f && f.size > 0) fd.append('files', f);
  }
  try {
    const res = await apiFetch(
      `${API_BASE}/support/tickets/${encodeURIComponent(payload.ticketId)}/messages`,
      { method: 'POST', body: fd }
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: supportErrorFromJson(res, data),
        idempotentReplay: data.idempotentReplay === true
      };
    }
    const id = typeof data.messageId === 'string' ? data.messageId : typeof data.id === 'string' ? data.id : undefined;
    return { ok: true, id, idempotentReplay: data.idempotentReplay === true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function archiveSupportTicket(ticketId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(
      `${API_BASE}/support/tickets/${encodeURIComponent(ticketId)}/archive`,
      { method: 'POST' }
    );
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: supportErrorFromJson(res, data as Record<string, unknown>) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function reopenSupportTicket(ticketId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(
      `${API_BASE}/support/tickets/${encodeURIComponent(ticketId)}/reopen`,
      { method: 'POST' }
    );
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: supportErrorFromJson(res, data as Record<string, unknown>) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function updateAdminSupportTicketStatus(
  id: string,
  status: 'open' | 'archived'
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${API_BASE}/admin/support-tickets/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status }),
  });
  try {
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type SupportUserHistoryTicketSummary = {
  id: string;
  subject: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  messageCount: number;
  hasAttachments: boolean;
  assignedTo: string | null;
  preview: string;
};

export type SupportUserHistoryResponse = {
  ok: true;
  user: { id: number; email: string; username: string; createdAt: number | null };
  summary: { total: number; open: number; archived: number; lastTicketAt: number };
  pagination: { page: number; limit: number; hasMore: boolean };
  tickets: SupportUserHistoryTicketSummary[];
};

export type SupportUserHistoryResult =
  | { ok: true; data: SupportUserHistoryResponse }
  | { ok: false; status: number; error: string; notFound?: boolean };

export async function getAdminSupportUserHistory(
  email: string,
  params?: { page?: number; limit?: number }
): Promise<SupportUserHistoryResult> {
  const qs = new URLSearchParams();
  qs.set('email', email.trim());
  if (params?.page != null) qs.set('page', String(params.page));
  if (params?.limit != null) qs.set('limit', String(params.limit));
  try {
    const res = await apiFetch(`${API_BASE}/admin/support/user-history?${qs.toString()}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: err, notFound: res.status === 404 };
    }
    if (data.ok !== true || !data.user || !data.summary || !Array.isArray(data.tickets)) {
      return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    }
    return { ok: true, data: data as unknown as SupportUserHistoryResponse };
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

export async function getAdminSupportTicketDetail(
  ticketId: string
): Promise<{ ok: true; ticket: SupportTicketRow } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(`${API_BASE}/admin/support/tickets/${encodeURIComponent(ticketId)}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    }
    const ticket = data.ticket as SupportTicketRow | undefined;
    if (!ticket?.id) {
      return { ok: false, error: 'Resposta inválida.' };
    }
    return {
      ok: true,
      ticket: {
        ...ticket,
        replies: Array.isArray(ticket.replies) ? ticket.replies : [],
        playerReplies: Array.isArray(ticket.playerReplies) ? ticket.playerReplies : [],
        attachments: Array.isArray(ticket.attachments) ? ticket.attachments : [],
      },
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}
