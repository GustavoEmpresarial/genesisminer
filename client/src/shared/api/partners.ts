/**
 * Player Partners (YouTube) API — DECISIONS #99.
 * Server: `GET/POST /api/partners/*`.
 */
import { apiFetch } from './http';

const base = '/api';

export type PartnerYoutubeMySubmission = {
  id: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  description?: string;
  status: string;
  createdAt: number;
  reviewedAt?: number;
  rejectReason?: string;
};

export type PartnersShowcaseVideoDto = {
  publicId: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  thumbnailUrl: string;
  embedUrl: string;
  description?: string;
  publishedAt: number;
  creator: { displayName: string; channelUrl: string; avatarUrl: string };
};

export type PartnersStatePayload = {
  ok?: boolean;
  page?: { emptyMessage?: string; subtitle?: string; title?: string; rules?: Record<string, unknown> };
  showcase?: {
    videos: PartnersShowcaseVideoDto[];
    pagination?: { nextCursor: string | null; limit: number };
    empty?: boolean;
  };
  auth?: {
    authenticated?: boolean;
    isPartner?: boolean;
    canSubmitToday?: boolean;
    submissionsToday?: number;
    canApply?: boolean;
    application?: {
      id: string;
      status: string;
      channelName: string;
      channelUrl: string;
      avatarUrl: string;
      description?: string;
      createdAt: number;
      rejectReason?: string;
    } | null;
  };
  creatorProfile?: {
    channelName: string;
    channelUrl: string;
    avatarUrl: string;
    description?: string;
    canEditChannelUrl: boolean;
  } | null;
  nftRoom?: {
    active: boolean;
    compliant: boolean;
    overdue: boolean;
    requiredIntervalDays: number;
    lastApprovedAt: number | null;
    nextDeadlineAt: number | null;
    approvedLast60d: number;
  } | null;
  mySubmissions?: Array<{
    publicId: string;
    title: string;
    youtubeUrl: string;
    youtubeVideoId: string;
    description?: string;
    status: string;
    createdAt: number;
    reviewedAt?: number;
    rejectReasonPublic?: string;
  }>;
};

export function mapMySubmissionsFromState(st: PartnersStatePayload): PartnerYoutubeMySubmission[] {
  const ms = Array.isArray(st.mySubmissions) ? st.mySubmissions : [];
  return ms.map((s) => ({
    id: s.publicId,
    title: s.title,
    youtubeUrl: s.youtubeUrl,
    youtubeVideoId: s.youtubeVideoId,
    description: s.description,
    status: s.status,
    createdAt: s.createdAt,
    reviewedAt: s.reviewedAt,
    rejectReason: s.rejectReasonPublic
  }));
}

export async function getPartnersState(opts?: {
  limit?: number;
  cursor?: string;
}): Promise<{ data: PartnersStatePayload | null; error: string | null }> {
  try {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    if (opts?.cursor) qs.set('cursor', opts.cursor);
    const res = await apiFetch(`${base}/partners/state?${qs.toString()}`);
    if (!res.ok) {
      if (res.status === 401) return { data: null, error: 'SESSION' };
      return { data: null, error: 'LOAD_FAILED' };
    }
    const data = (await res.json().catch(() => null)) as PartnersStatePayload | null;
    if (!data?.ok) return { data: null, error: 'INVALID' };
    return { data, error: null };
  } catch {
    return { data: null, error: 'NETWORK' };
  }
}

export async function submitPartnerYoutubeVideo(payload: {
  title: string;
  youtubeUrl: string;
  description?: string;
}): Promise<{ ok: boolean; error?: string; code?: string; id?: string; status?: string }> {
  try {
    const res = await apiFetch(`${base}/partners/videos/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      code?: string;
      id?: string;
      status?: string;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    }
    return { ok: true, id: data.id, status: data.status };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function uploadPartnerYoutubeAvatar(
  file: File
): Promise<{ ok: boolean; avatarUrl?: string; error?: string }> {
  try {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await apiFetch(`${base}/partners/youtube/avatar-upload`, { method: 'POST', body: fd });
    if (res.status === 413) {
      return { ok: false, error: 'Imagem muito grande. Use uma foto menor (até ~1 MB).' };
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; avatarUrl?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, avatarUrl: data.avatarUrl };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function submitPartnerYoutubeApplication(payload: {
  channelName: string;
  channelUrl: string;
  avatarUrl: string;
  description?: string;
}): Promise<{ ok: boolean; error?: string; code?: string; id?: string }> {
  try {
    const res = await apiFetch(`${base}/partners/youtube/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      code?: string;
      id?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function updatePartnerYoutubeMyProfile(payload: {
  channelName: string;
  avatarUrl: string;
  /** Only honoured while the stored channel URL is still empty (first set). */
  channelUrl?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  channelName?: string;
  avatarUrl?: string;
  channelUrl?: string;
}> {
  try {
    const res = await apiFetch(`${base}/partners/youtube/my-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channelName?: string;
      avatarUrl?: string;
      channelUrl?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return {
      ok: true,
      channelName: data.channelName,
      avatarUrl: data.avatarUrl,
      channelUrl: data.channelUrl
    };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
