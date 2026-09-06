import { apiFetch } from './http';

const base = '/api';

export const SUPPORT_TICKET_SUBJECT_MAX = 180;
export const SUPPORT_TICKET_MESSAGE_MAX = 8000;
export const SUPPORT_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_COUNT = 5;

const SUPPORT_PAYLOAD_TOO_LARGE =
  'Attachments exceed the allowed limit. Each file can be up to 12 MB (max 5). Try compressing or sending fewer files.';

function supportErrorFromJson(res: Response, data: Record<string, unknown>): string {
  if (res.status === 413) return SUPPORT_PAYLOAD_TOO_LARGE;
  const err = data.error;
  if (typeof err === 'string' && err.trim()) return err;
  return `HTTP ${res.status}`;
}

export type SupportTicketAttachment = { url: string; originalName: string; mime: string };

export type SupportTicketPlayerReplyRow = {
  id: string;
  message: string;
  attachments: SupportTicketAttachment[];
  createdAt: number;
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
  tickets?: SupportStateTicketRow[];
  unreadStaffReplyCount?: number;
};

/** Key 8–128 chars `[a-zA-Z0-9_.:-]` aligned with server `parseIdempotencyKey`. */
export function newSupportIdempotencyKey(): string {
  const u =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = `sup:${u}`;
  const safe = raw.replace(/[^a-zA-Z0-9_.:-]/g, 'x');
  return safe.length >= 8 ? safe.slice(0, 128) : `sup:${safe}xxxxxxxx`.slice(0, 36);
}

function parseAttachment(raw: unknown): SupportTicketAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    url: typeof o.url === 'string' ? o.url : '',
    originalName: typeof o.originalName === 'string' ? o.originalName : '',
    mime: typeof o.mime === 'string' ? o.mime : ''
  };
}

export async function getSupportState(query?: {
  limit?: string;
  cursor?: string;
}): Promise<SupportStatePayload | null> {
  const qs = new URLSearchParams();
  if (query?.limit) qs.set('limit', query.limit);
  if (query?.cursor) qs.set('cursor', query.cursor);
  const q = qs.toString();
  try {
    const res = await apiFetch(`${base}/support/state${q ? `?${q}` : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as SupportStatePayload;
  } catch {
    return null;
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
    const res = await apiFetch(`${base}/support/tickets`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: supportErrorFromJson(res, data),
        idempotentReplay: data.idempotentReplay === true
      };
    }
    const id =
      typeof data.publicId === 'string' ? data.publicId : typeof data.id === 'string' ? data.id : undefined;
    return { ok: true, id, idempotentReplay: data.idempotentReplay === true };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function getMySupportTicketDetail(ticketId: string): Promise<MySupportTicketDetail | null> {
  try {
    const res = await apiFetch(`${base}/support/tickets/${encodeURIComponent(ticketId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const ticketRaw = data.ticket;
    if (!ticketRaw || typeof ticketRaw !== 'object') return null;
    const t = ticketRaw as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id) return null;
    const adminReplies = Array.isArray(data.adminReplies) ? data.adminReplies : [];
    const playerReplies = Array.isArray(data.playerReplies) ? data.playerReplies : [];
    return {
      ticket: {
        id: t.id,
        subject: typeof t.subject === 'string' ? t.subject : '',
        message: typeof t.message === 'string' ? t.message : '',
        attachments: Array.isArray(t.attachments)
          ? t.attachments.map(parseAttachment).filter((x): x is SupportTicketAttachment => !!x)
          : [],
        status: typeof t.status === 'string' ? t.status : 'open',
        createdAt: Math.max(0, Number(t.createdAt) || 0)
      },
      adminReplies: adminReplies
        .map((r) => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          if (typeof o.id !== 'string') return null;
          return {
            id: o.id,
            adminUsername: typeof o.adminUsername === 'string' ? o.adminUsername : '',
            message: typeof o.message === 'string' ? o.message : '',
            attachments: Array.isArray(o.attachments)
              ? o.attachments.map(parseAttachment).filter((x): x is SupportTicketAttachment => !!x)
              : [],
            createdAt: Math.max(0, Number(o.createdAt) || 0)
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
      playerReplies: playerReplies
        .map((r) => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          if (typeof o.id !== 'string') return null;
          return {
            id: o.id,
            message: typeof o.message === 'string' ? o.message : '',
            attachments: Array.isArray(o.attachments)
              ? o.attachments.map(parseAttachment).filter((x): x is SupportTicketAttachment => !!x)
              : [],
            createdAt: Math.max(0, Number(o.createdAt) || 0)
          };
        })
        .filter((x): x is SupportTicketPlayerReplyRow => !!x)
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
    const res = await apiFetch(`${base}/support/tickets/${encodeURIComponent(payload.ticketId)}/messages`, {
      method: 'POST',
      body: fd
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: supportErrorFromJson(res, data),
        idempotentReplay: data.idempotentReplay === true
      };
    }
    const id =
      typeof data.messageId === 'string' ? data.messageId : typeof data.id === 'string' ? data.id : undefined;
    return { ok: true, id, idempotentReplay: data.idempotentReplay === true };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function archiveSupportTicket(ticketId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/support/tickets/${encodeURIComponent(ticketId)}/archive`, {
      method: 'POST'
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: supportErrorFromJson(res, data) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function reopenSupportTicket(ticketId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/support/tickets/${encodeURIComponent(ticketId)}/reopen`, {
      method: 'POST'
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: supportErrorFromJson(res, data) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
