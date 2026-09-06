/**
 * In-app popup announcements — player pending/dismiss + admin CRUD.
 * Extracted from admin-legacy to shrink the monolith and clarify ownership.
 */
import { apiFetch } from './http';
import { isSafeHttpsLink, normalizeSafeInAppImagePath } from '../utils/inAppAnnouncementSafe';

const base = '/api';

export type InAppAnnouncementPayload = {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl?: string | null;
  priority?: number;
  createdAt?: number;
};

export type InAppAnnouncementAdminPayload = InAppAnnouncementPayload & {
  isActive: boolean;
  startsAt: number | null;
  endsAt: number | null;
  createdBy: number | null;
  readCount: number;
};

const IN_APP_ANNOUNCEMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseInAppAnnouncement(raw: unknown): InAppAnnouncementPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const message = typeof o.message === 'string' ? o.message : '';
  if (!id || !title || !message) return null;
  if (!IN_APP_ANNOUNCEMENT_ID_RE.test(id)) return null;
  const rawLink = typeof o.link === 'string' && o.link.trim() ? o.link.trim() : null;
  const link = rawLink && isSafeHttpsLink(rawLink) ? rawLink : null;
  const imageUrlRaw = o.imageUrl ?? o.image_url;
  const imageUrl =
    typeof imageUrlRaw === 'string' ? normalizeSafeInAppImagePath(imageUrlRaw) : null;
  return { id, title, message, link, imageUrl };
}

/** GET /api/announcements/pending */
export async function getPendingInAppAnnouncements(): Promise<InAppAnnouncementPayload[]> {
  try {
    const res = await apiFetch(`${base}/announcements/pending`);
    if (!res.ok) return [];
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.announcements) ? raw.announcements : [];
    return list.map(parseInAppAnnouncement).filter((x): x is InAppAnnouncementPayload => x != null);
  } catch {
    return [];
  }
}

/** POST /api/announcements/:id/dismiss */
export async function dismissInAppAnnouncement(id: string): Promise<boolean> {
  try {
    const safeId = encodeURIComponent(String(id || '').trim());
    if (!safeId) return false;
    const res = await apiFetch(`${base}/announcements/${safeId}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** GET /api/admin/announcements */
export async function getAdminInAppAnnouncements(): Promise<{
  list: InAppAnnouncementAdminPayload[];
  error: string | null;
}> {
  try {
    const res = await apiFetch(`${base}/admin/announcements`);
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = typeof raw?.error === 'string' ? raw.error : `Erro ao carregar avisos (HTTP ${res.status}).`;
      return { list: [], error: msg };
    }
    const list = Array.isArray(raw?.announcements) ? raw.announcements : [];
    const out: InAppAnnouncementAdminPayload[] = [];
    for (const item of list) {
      const baseAnn = parseInAppAnnouncement(item);
      if (!baseAnn) continue;
      const o = item as Record<string, unknown>;
      out.push({
        ...baseAnn,
        isActive: o.isActive === true || o.is_active === 1,
        startsAt:
          typeof o.startsAt === 'number'
            ? o.startsAt
            : typeof o.starts_at === 'number'
              ? o.starts_at
              : null,
        endsAt:
          typeof o.endsAt === 'number' ? o.endsAt : typeof o.ends_at === 'number' ? o.ends_at : null,
        createdBy:
          typeof o.createdBy === 'number'
            ? o.createdBy
            : typeof o.created_by === 'number'
              ? o.created_by
              : null,
        readCount:
          typeof o.readCount === 'number'
            ? o.readCount
            : typeof o.read_count === 'number'
              ? o.read_count
              : 0
      });
    }
    return { list: out, error: null };
  } catch {
    return { list: [], error: 'Falha de rede ao carregar avisos popup.' };
  }
}

export async function createAdminInAppAnnouncement(body: {
  title: string;
  message: string;
  link?: string;
  imageUrl?: string | null;
  priority?: number;
  isActive?: boolean;
  startsAt?: number | null;
  endsAt?: number | null;
}): Promise<{ announcement: InAppAnnouncementAdminPayload | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/admin/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = typeof raw?.error === 'string' ? raw.error : `Erro ao criar aviso (HTTP ${res.status}).`;
      return { announcement: null, error: msg };
    }
    const ann = parseInAppAnnouncement(raw?.announcement);
    if (!ann) return { announcement: null, error: 'Resposta inválida do servidor.' };
    const o = (raw?.announcement || {}) as Record<string, unknown>;
    return {
      announcement: {
        ...ann,
        isActive: o.isActive === true || o.is_active === 1,
        startsAt: typeof o.startsAt === 'number' ? o.startsAt : null,
        endsAt: typeof o.endsAt === 'number' ? o.endsAt : null,
        createdBy: typeof o.createdBy === 'number' ? o.createdBy : null,
        readCount: typeof o.readCount === 'number' ? o.readCount : 0
      },
      error: null
    };
  } catch {
    return { announcement: null, error: 'Falha de rede ao criar aviso popup.' };
  }
}

export async function updateAdminInAppAnnouncement(
  id: string,
  body: Partial<{
    title: string;
    message: string;
    link: string;
    imageUrl: string | null;
    priority: number;
    isActive: boolean;
    startsAt: number | null;
    endsAt: number | null;
  }>
): Promise<{ announcement: InAppAnnouncementAdminPayload | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/admin/announcements/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = typeof raw?.error === 'string' ? raw.error : `Erro ao atualizar aviso (HTTP ${res.status}).`;
      return { announcement: null, error: msg };
    }
    const ann = parseInAppAnnouncement(raw?.announcement);
    if (!ann) return { announcement: null, error: 'Resposta inválida do servidor.' };
    const o = (raw?.announcement || {}) as Record<string, unknown>;
    return {
      announcement: {
        ...ann,
        isActive: o.isActive === true || o.is_active === 1,
        startsAt: typeof o.startsAt === 'number' ? o.startsAt : null,
        endsAt: typeof o.endsAt === 'number' ? o.endsAt : null,
        createdBy: typeof o.createdBy === 'number' ? o.createdBy : null,
        readCount: typeof o.readCount === 'number' ? o.readCount : 0
      },
      error: null
    };
  } catch {
    return { announcement: null, error: 'Falha de rede ao atualizar aviso popup.' };
  }
}

export async function deleteAdminInAppAnnouncement(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${base}/admin/announcements/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    return res.ok;
  } catch {
    return false;
  }
}
