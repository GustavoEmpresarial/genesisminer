/**
 * Public (pré-login) support API — create ticket + lookup by email.
 */
import { apiFetch } from './http';

export type PublicSupportTicketSummary = {
  id: string;
  subject: string;
  status: string;
  created_at: number | string;
  contact_name: string;
  contact_email: string;
  admin_reply_count: number;
};

export type PublicSupportTicketDetail = PublicSupportTicketSummary & {
  message: string;
  attachments: unknown;
  replies: Array<{
    id: string;
    message: string;
    attachments: unknown;
    created_at: number | string;
    admin_username: string;
  }>;
};

export async function createPublicSupportTicket(input: {
  name: string;
  email: string;
  subject: string;
  message: string;
  files: File[];
}): Promise<{ ok: boolean; id?: string; error?: string; code?: string }> {
  const fd = new FormData();
  fd.set('name', input.name);
  fd.set('email', input.email);
  fd.set('subject', input.subject);
  fd.set('message', input.message);
  for (const f of input.files) fd.append('files', f);
  try {
    const res = await apiFetch('/api/public/support/tickets', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...(data as object) };
    return { ok: true, ...(data as object) };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function listPublicSupportTicketsByEmail(
  email: string
): Promise<{ ok: boolean; tickets?: PublicSupportTicketSummary[]; error?: string }> {
  try {
    const res = await apiFetch(`/api/public/support/tickets?email=${encodeURIComponent(email.trim())}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...(data as object) };
    return { ok: true, ...(data as object) };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getPublicSupportTicket(
  ticketId: string,
  email: string
): Promise<{ ok: boolean; ticket?: PublicSupportTicketDetail; error?: string }> {
  try {
    const res = await apiFetch(
      `/api/public/support/tickets/${encodeURIComponent(ticketId)}?email=${encodeURIComponent(email.trim())}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, ...(data as object) };
    return { ok: true, ...(data as object) };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
