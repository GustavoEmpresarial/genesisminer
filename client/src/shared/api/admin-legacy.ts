// @ts-nocheck — Admin/legacy API facade: domain modules re-exported where extracted; remainder still lives here.
import { AccessLevel, GameState, LootBox, SystemNews, Upgrade, User, Web3Settings, MiningCoin, SeasonPass, SeasonPurchase, AdminUpgrade, MarketListing, RigRoom, MonetizationSettings, EconomySettings, SecurityStats, GameUserActivityEntry, TransparencyEntry, TransparencyCategory, DeviceFingerprintPayload, AdminDeviceFingerprintLog, PlacedRack, StoredBattery, P2PMarketTradeHistory, P2PMarketTradeHistoryEntry } from '../../features/admin/lib/adminTypes';
import { GAME_NAV_LABEL_KEYS, UI_DISPLAY_LABEL_VALUE_MAX } from '../constants/gameNavLabels';
import { apiFetch, setSessionHint } from './http';
export {
  getReferralModels,
  saveReferralModel,
  deleteReferralModel,
  getAccessLevelReferralAssignments,
  saveAccessLevelReferralAssignments
} from './admin-users';

const base = '/api';


/** JSON de endpoints que devem ser listas — evita `x.filter is not a function` se a API devolver `{}` ou outro tipo. */
function parseJsonArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/** Log de atividade do jogador (auditoria); falhas não devem bloquear o jogo. */
export async function logPlayerActivity(
  action: string,
  meta: Record<string, unknown>,
  clientHints?: Record<string, unknown>
): Promise<void> {
  try {
    await apiFetch(`${base}/player-activity-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, meta, clientHints: clientHints && typeof clientHints === 'object' ? clientHints : {} })
    });
  } catch {
    /* ignore */
  }
}

export type PartnerYoutubeVideoPublic = {
  id: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  description?: string;
  createdAt: number;
  approvedAt?: number;
  username: string;
  /** Dono do vídeo (perfil vitrine editável no admin). */
  userId?: number;
  partnerChannelUrl?: string;
  partnerAvatarUrl?: string;
  /** Vitrine modular: URL de miniatura validada no servidor. */
  thumbnailUrl?: string;
  embedUrl?: string;
  publishedAt?: number;
  creator?: { displayName: string; channelUrl: string; avatarUrl: string };
};

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

function mapShowcaseToLegacyVideos(videos: PartnersShowcaseVideoDto[]): PartnerYoutubeVideoPublic[] {
  return videos.map((v) => ({
    id: v.publicId,
    title: v.title,
    youtubeUrl: v.youtubeUrl,
    youtubeVideoId: v.youtubeVideoId,
    description: v.description,
    createdAt: v.publishedAt,
    approvedAt: v.publishedAt,
    username: v.creator?.displayName || 'Parceiro',
    userId: undefined,
    partnerChannelUrl: v.creator?.channelUrl,
    partnerAvatarUrl: v.creator?.avatarUrl,
    thumbnailUrl: v.thumbnailUrl,
    embedUrl: v.embedUrl,
    publishedAt: v.publishedAt,
    creator: v.creator
  }));
}

export async function getPartnersState(opts?: { limit?: number; cursor?: string }): Promise<PartnersStatePayload | null> {
  try {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    if (opts?.cursor) qs.set('cursor', opts.cursor);
    const res = await apiFetch(`${base}/partners/state?${qs.toString()}`);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as PartnersStatePayload | null;
  } catch {
    return null;
  }
}

export async function getPartnerYoutubeVideosPublic(
  limit = 24,
  offset = 0
): Promise<{ videos: PartnerYoutubeVideoPublic[]; pagination?: { nextCursor: string | null; limit: number } }> {
  try {
    if (offset === 0) {
      const st = await getPartnersState({ limit });
      const raw = Array.isArray(st?.showcase?.videos) ? st!.showcase!.videos : [];
      return {
        videos: mapShowcaseToLegacyVideos(raw),
        pagination: st?.showcase?.pagination
      };
    }
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const res = await apiFetch(`${base}/partner-videos/public?${q.toString()}`);
    const data = (await res.json().catch(() => ({}))) as {
      videos?: PartnerYoutubeVideoPublic[];
      pagination?: { nextCursor: string | null; limit: number };
    };
    if (!res.ok) return { videos: [] };
    return { videos: Array.isArray(data.videos) ? data.videos : [], pagination: data.pagination };
  } catch {
    return { videos: [] };
  }
}

export async function getPartnerYoutubeMyContext(): Promise<{
  isPartner: boolean;
  canSubmitToday: boolean;
  submissionsToday: number;
  submissions: PartnerYoutubeMySubmission[];
}> {
  try {
    const st = await getPartnersState({ limit: 24 });
    if (!st?.ok) {
      return { isPartner: false, canSubmitToday: false, submissionsToday: 0, submissions: [] };
    }
    const auth = st.auth || {};
    const raw = Array.isArray(st.mySubmissions) ? st.mySubmissions : [];
    const submissions: PartnerYoutubeMySubmission[] = raw.map((s) => ({
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
    return {
      isPartner: !!auth.isPartner,
      canSubmitToday: !!auth.canSubmitToday,
      submissionsToday: Number(auth.submissionsToday) || 0,
      submissions
    };
  } catch {
    return { isPartner: false, canSubmitToday: false, submissionsToday: 0, submissions: [] };
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
    return { ok: false, error: 'Network error' };
  }
}

export async function uploadPartnerYoutubeAvatar(file: File): Promise<{ ok: boolean; avatarUrl?: string; error?: string }> {
  try {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await apiFetch(`${base}/partners/youtube/avatar-upload`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; avatarUrl?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, avatarUrl: data.avatarUrl };
  } catch {
    return { ok: false, error: 'Falha no upload.' };
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
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; id?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function updatePartnerYoutubeMyProfile(payload: {
  channelName: string;
  avatarUrl: string;
}): Promise<{ ok: boolean; error?: string; channelName?: string; avatarUrl?: string; channelUrl?: string }> {
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
    return { ok: true, channelName: data.channelName, avatarUrl: data.avatarUrl, channelUrl: data.channelUrl };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type AdminPartnerYoutubeApplicationRow = {
  id: string;
  userId: number;
  username: string;
  email: string;
  channelName: string;
  channelUrl: string;
  avatarUrl: string;
  description?: string;
  status: string;
  createdAt: number;
  reviewedAt?: number;
  rejectReason?: string;
};

export async function getAdminPartnerYoutubeApplications(
  status: 'all' | 'pending' | 'approved' | 'rejected' = 'pending'
): Promise<{ applications: AdminPartnerYoutubeApplicationRow[] }> {
  const q = status === 'pending' ? '' : `?status=${encodeURIComponent(status)}`;
  const res = await apiFetch(`${base}/admin/partner-youtube-applications${q}`);
  const data = (await res.json().catch(() => ({}))) as {
    applications?: AdminPartnerYoutubeApplicationRow[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { applications: Array.isArray(data.applications) ? data.applications : [] };
}

export async function adminApprovePartnerYoutubeApplication(id: string): Promise<{ ok: boolean; error?: string; userId?: number }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-applications/${encodeURIComponent(id)}/approve`, {
    method: 'POST'
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; userId?: number };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok, userId: data.userId };
}

export async function adminRejectPartnerYoutubeApplication(
  id: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-applications/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '' })
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok };
}

export type AdminPartnerYoutubeRow = {
  id: string;
  userId: number;
  username: string;
  email: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  description?: string;
  status: string;
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: number | null;
  rejectReason?: string;
};

export type AdminPartnerYoutubePartnerRow = {
  userId: number;
  username: string;
  email: string;
  approvedCount: number;
  approvedLast365d?: number;
  lastApprovedAt?: number | null;
  channelUrl: string;
  avatarUrl: string;
  allowlisted?: boolean;
  nftRoom?: {
    requiredApprovedPerYear: number;
    requiredIntervalDays: number;
    approvedLast365d: number;
    lastApprovedAt?: number | null;
    nextDeadlineAt?: number | null;
    active: boolean;
    overdue: boolean;
    compliant: boolean;
  };
};

export async function getAdminPartnerYoutubePartners(): Promise<{ partners: AdminPartnerYoutubePartnerRow[] }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-partners`);
  const data = (await res.json().catch(() => ({}))) as { partners?: AdminPartnerYoutubePartnerRow[]; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { partners: Array.isArray(data.partners) ? data.partners : [] };
}

export async function postAdminDeactivatePartnerNftRoom(
  userId: number
): Promise<{ ok: boolean; roomId?: string; removedRackCount?: number; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-partners/${encodeURIComponent(String(userId))}/deactivate-nft-room`, {
    method: 'POST'
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    roomId?: string;
    removedRackCount?: number;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return {
    ok: !!data.ok,
    roomId: data.roomId,
    removedRackCount: typeof data.removedRackCount === 'number' ? data.removedRackCount : 0
  };
}

export interface AdminStreamerRoomUser {
  userId: number;
  username: string;
  email: string;
  lastApprovedAt: number | null;
  approvedLast60d: number;
  overdue: boolean;
}

export async function getAdminStreamerRoomUsers(): Promise<{ users: AdminStreamerRoomUser[]; error?: string }> {
  const res = await apiFetch(`${base}/admin/streamer-room-users`);
  const data = (await res.json().catch(() => ({}))) as { users?: AdminStreamerRoomUser[]; error?: string };
  if (!res.ok) return { users: [], error: data.error || `HTTP ${res.status}` };
  return { users: Array.isArray(data.users) ? data.users : [] };
}

export async function postAdminDeactivateStreamerRoom(
  userId: number
): Promise<{ ok: boolean; removedRackCount?: number; error?: string }> {
  const res = await apiFetch(`${base}/admin/streamer-room-users/${encodeURIComponent(String(userId))}/deactivate`, {
    method: 'POST'
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; removedRackCount?: number; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok, removedRackCount: typeof data.removedRackCount === 'number' ? data.removedRackCount : 0 };
}

export async function postAdminPartnerYoutubeAllowlist(payload: {
  userId?: number;
  username?: string;
}): Promise<{ ok: boolean; inserted?: boolean; userId?: number; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    inserted?: boolean;
    userId?: number;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok, inserted: data.inserted, userId: data.userId };
}

export async function deleteAdminPartnerYoutubeAllowlist(userId: number): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-allowlist/${encodeURIComponent(String(userId))}`, {
    method: 'DELETE'
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok };
}

export async function getAdminPartnerYoutubeSubmissions(
  status: 'all' | 'pending' | 'approved' | 'rejected' = 'all'
): Promise<{ submissions: AdminPartnerYoutubeRow[] }> {
  const q = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
  const res = await apiFetch(`${base}/admin/partner-videos${q}`);
  const data = (await res.json().catch(() => ({}))) as { submissions?: AdminPartnerYoutubeRow[] };
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return { submissions: Array.isArray(data.submissions) ? data.submissions : [] };
}

export async function adminApprovePartnerYoutube(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-videos/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok };
}

export async function adminRejectPartnerYoutube(
  id: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-videos/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '' })
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok };
}

export async function adminDeletePartnerYoutube(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${base}/admin/partner-videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok };
}

export async function getAdminPartnerYoutubeCreatorProfile(
  userId: number
): Promise<{ channelUrl: string; avatarUrl: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-creators/${userId}`);
  const data = (await res.json().catch(() => ({}))) as { channelUrl?: string; avatarUrl?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return {
    channelUrl: typeof data.channelUrl === 'string' ? data.channelUrl : '',
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : ''
  };
}

export async function putAdminPartnerYoutubeCreatorProfile(
  userId: number,
  payload: { channelUrl: string; avatarUrl: string }
): Promise<{ ok: boolean; error?: string; channelUrl?: string; avatarUrl?: string }> {
  const res = await apiFetch(`${base}/admin/partner-youtube-creators/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelUrl: payload.channelUrl, avatarUrl: payload.avatarUrl })
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    channelUrl?: string;
    avatarUrl?: string;
  };
  if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
  return { ok: !!data.ok, channelUrl: data.channelUrl, avatarUrl: data.avatarUrl };
}

/** Transferências USDC (Polygon) para o treasury — só admin; chave Etherscan fica no servidor. */
export async function getAdminTreasuryTokenTxs(page: number, offset: number, treasuryAddress?: string): Promise<unknown> {
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const o = Math.min(1000, Math.max(1, Math.floor(Number(offset)) || 20));
  const q = new URLSearchParams({ page: String(p), offset: String(o) });
  const addr = typeof treasuryAddress === 'string' ? treasuryAddress.trim() : '';
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    q.set('address', addr);
  }
  const res = await apiFetch(`${base}/admin/etherscan/treasury-token-txs?${q.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data;
}

export type UpgradesCatalogPayload = {
  upgrades: Upgrade[];
  catalogRevision: number;
};

export async function getUpgrades(): Promise<Upgrade[]> {
  const pack = await getUpgradesCatalog();
  return pack.upgrades;
}

/** GET /api/upgrades — catálogo + revision OCC. */
export async function getUpgradesCatalog(): Promise<UpgradesCatalogPayload> {
  try {
    const res = await apiFetch(`${base}/upgrades`);
    if (!res.ok) return { upgrades: [], catalogRevision: 0 };
    try {
      const raw = await res.json();
      if (Array.isArray(raw)) {
        // Compat legado (array puro) — sem revision útil.
        return { upgrades: parseJsonArray<Upgrade>(raw), catalogRevision: 0 };
      }
      if (raw && typeof raw === 'object') {
        const o = raw as { upgrades?: unknown; catalogRevision?: unknown };
        const upgrades = Array.isArray(o.upgrades) ? parseJsonArray<Upgrade>(o.upgrades) : [];
        const catalogRevision =
          typeof o.catalogRevision === 'number' && Number.isFinite(o.catalogRevision)
            ? Math.floor(o.catalogRevision)
            : Number(o.catalogRevision) || 0;
        return { upgrades, catalogRevision };
      }
      return { upgrades: [], catalogRevision: 0 };
    } catch {
      return { upgrades: [], catalogRevision: 0 };
    }
  } catch {
    return { upgrades: [], catalogRevision: 0 };
  }
}

export type SetUpgradesResult =
  | { ok: true; catalogRevision: number }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      forceReload?: boolean;
      catalogRevision?: number;
    };

export async function setUpgrades(
  upgrades: Upgrade[],
  expectedCatalogRevision: number
): Promise<SetUpgradesResult> {
  const res = await apiFetch(`${base}/upgrades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upgrades, expectedCatalogRevision })
  });
  if (!res.ok) {
    let errorMsg = `Server Error: ${res.status}`;
    let code: string | undefined;
    let forceReload = false;
    let catalogRevision: number | undefined;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        if (json.error) errorMsg = String(json.error);
        else errorMsg += ' ' + text.substring(0, 100);
        if (typeof json.code === 'string') code = json.code;
        forceReload = json.forceReload === true;
        if (typeof json.catalogRevision === 'number') catalogRevision = json.catalogRevision;
      } catch {
        errorMsg += ' ' + text.substring(0, 100);
      }
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, error: errorMsg, code, forceReload, catalogRevision };
  }
  try {
    const json = (await res.json()) as { catalogRevision?: number };
    const catalogRevision =
      typeof json.catalogRevision === 'number' && Number.isFinite(json.catalogRevision)
        ? Math.floor(json.catalogRevision)
        : expectedCatalogRevision + 1;
    return { ok: true, catalogRevision };
  } catch {
    return { ok: true, catalogRevision: expectedCatalogRevision + 1 };
  }
}

export async function getAccessLevels(): Promise<AccessLevel[]> {
  try {
    const res = await apiFetch(`${base}/access-levels`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<AccessLevel>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function setAccessLevels(levels: AccessLevel[]): Promise<void> {
  const res = await apiFetch(`${base}/access-levels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(levels) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Server error: ${res.status}`);
  }
}

/** Prefixo em `ui_display_labels` para itens da barra de navegação (alinhado ao backend). */
const GAME_NAV_DB_PREFIX = 'nav.';

export function gameNavLabelsFromDisplayLabelsPayload(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const short of GAME_NAV_LABEL_KEYS) {
    const v = data[`${GAME_NAV_DB_PREFIX}${short}`];
    if (typeof v === 'string' && v.trim()) out[short] = v.trim();
  }
  return out;
}

/** Mapa cru de chaves `ui_display_labels` (GET público `/api/display-labels`). */
export async function getDisplayLabelsRaw(): Promise<Record<string, unknown>> {
  try {
    const res = await apiFetch(`${base}/display-labels`);
    if (!res.ok) return {};
    const data = (await res.json().catch(() => ({}))) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Rótulos do menu do jogo (via GET /api/display-labels; chaves `nav.*` no servidor). */
export async function getGameNavLabels(): Promise<Record<string, string>> {
  try {
    const res = await apiFetch(`${base}/display-labels`);
    if (!res.ok) return {};
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return gameNavLabelsFromDisplayLabelsPayload(data);
  } catch {
    return {};
  }
}

/** Catálogo + economia + notícias + menu num único GET (`GET /api/bootstrap`). */
export type PublicBootstrapPayload = {
  upgrades: Upgrade[];
  accessLevels: AccessLevel[];
  lootBoxes: LootBox[];
  miningCoins: MiningCoin[];
  economySettings: EconomySettings | null;
  web3Settings: Web3Settings | null;
  systemNews: SystemNews[];
  gameNavLabels: Record<string, string>;
  /** Quando `false`, o separador «Roleta» não aparece no menu (definição em `ui_display_labels.nav.roleta_tab_visible`). */
  showRoletaInNav: boolean;
  /** Kill-switch Gerência (`ACCOUNT_MANAGER_ENABLED` no backend). Default false. */
  accountManagerEnabled: boolean;
  /** Kill-switch Merge Station (`merge_settings.enabled`). Default true. */
  mergeEnabled: boolean;
  /** Cor de destaque do layout (`settings.ui_accent`) — hex `#rrggbb`. */
  uiAccent: string;
};

export type PublicBootstrapLitePayload = Pick<
  PublicBootstrapPayload,
  'accessLevels' | 'miningCoins' | 'economySettings' | 'lootBoxes' | 'web3Settings'
>;

function normalizePublicBootstrapPayload(raw: unknown): PublicBootstrapPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    upgrades: Array.isArray(d.upgrades) ? (d.upgrades as Upgrade[]) : [],
    accessLevels: Array.isArray(d.accessLevels) ? (d.accessLevels as AccessLevel[]) : [],
    lootBoxes: Array.isArray(d.lootBoxes) ? (d.lootBoxes as LootBox[]) : [],
    miningCoins: Array.isArray(d.miningCoins) ? (d.miningCoins as MiningCoin[]) : [],
    economySettings:
      d.economySettings != null && typeof d.economySettings === 'object' && !Array.isArray(d.economySettings)
        ? (d.economySettings as EconomySettings)
        : null,
    web3Settings:
      d.web3Settings != null && typeof d.web3Settings === 'object' && !Array.isArray(d.web3Settings)
        ? (d.web3Settings as Web3Settings)
        : null,
    systemNews: Array.isArray(d.systemNews) ? (d.systemNews as SystemNews[]) : [],
    gameNavLabels:
      d.gameNavLabels != null && typeof d.gameNavLabels === 'object' && !Array.isArray(d.gameNavLabels)
        ? (d.gameNavLabels as Record<string, string>)
        : {},
    showRoletaInNav: d.showRoletaInNav === false ? false : true,
    accountManagerEnabled: d.accountManagerEnabled === true,
    mergeEnabled: d.mergeEnabled !== false,
    uiAccent: typeof d.uiAccent === 'string' && d.uiAccent.trim() ? d.uiAccent.trim() : '#f59e0b'
  };
}

export async function getPublicBootstrap(): Promise<PublicBootstrapPayload | null> {
  try {
    const res = await apiFetch(`${base}/bootstrap`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    return normalizePublicBootstrapPayload(raw);
  } catch {
    return null;
  }
}

/** Subconjunto para refresh periódico (`GET /api/bootstrap?lite=1`). */
export async function getPublicBootstrapLite(): Promise<PublicBootstrapLitePayload | null> {
  try {
    const res = await apiFetch(`${base}/bootstrap?lite=1`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    const norm = normalizePublicBootstrapPayload(
      raw && typeof raw === 'object'
        ? { ...(raw as object), upgrades: [], systemNews: [], gameNavLabels: {} }
        : null
    );
    if (!norm) return null;
    return {
      accessLevels: norm.accessLevels,
      miningCoins: norm.miningCoins,
      economySettings: norm.economySettings,
      lootBoxes: norm.lootBoxes,
      web3Settings: norm.web3Settings
    };
  } catch {
    return null;
  }
}

export type ProfilePageBundle = {
  seasonPasses: SeasonPass[];
  seasonPurchases: SeasonPurchase[];
  accessLevels: AccessLevel[];
  referrals: string[];
  lootBoxes: LootBox[];
  newsFee: number;
  profileGame: { usdc: number; claimedReferrals: number };
};

/** Estado consolidado do perfil (`GET /api/profile/state`). */
export type ProfileApiState = {
  ok: true;
  identity: {
    email: string;
    username: string;
    displayName: string;
    accessLevelId: string;
    accessLevelLabel: string;
    status: string;
    emailReadOnly: boolean;
  };
  permissions: {
    canChangeUsername: boolean;
    canBindReferral: boolean;
    canConnectWallet: boolean;
    canRemoveWallet: boolean;
  };
  limits: { usernameMin: number; usernameMax: number; passwordMax: number; referralCodeMax: number };
  referral: {
    code: string | null;
    inviteUrl: string;
    invitedCount: number;
    commissionPercent: number;
    commissionRule: string;
    referredBy: string | null;
  };
  wallet: { network: string; chainId: number; address: string | null };
  badges: Array<{
    passId: string;
    seasonId: string;
    name: string;
    imageUrl: string | null;
    purchasedAt: number;
  }>;
  bundle: ProfilePageBundle;
  accessLevelsCatalog: Array<{ id: string; name: string; isActive: boolean; newsPostingEnabled: boolean }>;
  userAccessLevelIds: string[];
};

/** Resposta de `GET /api/me/upgrade-shop-bundle` (página Upgrade). */
export type UpgradeShopBundle = {
  seasonPasses: SeasonPass[];
  seasonPurchases: SeasonPurchase[];
  adminUpgrades: AdminUpgrade[];
  upgrades: Upgrade[];
  lootBoxes: LootBox[];
  adminUpgradePurchases: string[];
  miningCoins: MiningCoin[];
  rigRooms: RigRoom[];
};

export async function getUpgradeShopBundle(): Promise<UpgradeShopBundle | null> {
  try {
    const res = await apiFetch(`${base}/me/upgrade-shop-bundle`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    return {
      seasonPasses: Array.isArray(d.seasonPasses) ? (d.seasonPasses as SeasonPass[]) : [],
      seasonPurchases: Array.isArray(d.seasonPurchases) ? (d.seasonPurchases as SeasonPurchase[]) : [],
      adminUpgrades: Array.isArray(d.adminUpgrades) ? (d.adminUpgrades as AdminUpgrade[]) : [],
      upgrades: Array.isArray(d.upgrades) ? (d.upgrades as Upgrade[]) : [],
      lootBoxes: Array.isArray(d.lootBoxes) ? (d.lootBoxes as LootBox[]) : [],
      adminUpgradePurchases: Array.isArray(d.adminUpgradePurchases) ? (d.adminUpgradePurchases as string[]) : [],
      miningCoins: Array.isArray(d.miningCoins) ? (d.miningCoins as MiningCoin[]) : [],
      rigRooms: Array.isArray(d.rigRooms) ? (d.rigRooms as RigRoom[]) : []
    };
  } catch {
    return null;
  }
}

export type ProfileWalletHistoryDto = {
  id: string;
  action: string;
  walletAddress: string | null;
  network: string;
  previousWalletAddress: string | null;
  newWalletAddress: string | null;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  actorType?: string | null;
  actorUserId?: number | null;
  source?: string | null;
  notes?: string | null;
  metadata?: unknown;
};

export async function getProfileWallet(limit = 100): Promise<{
  ok: boolean;
  wallet: { address: string; network: string; connectedAt: string | null } | null;
  history: ProfileWalletHistoryDto[];
  error?: string;
} | null> {
  try {
    const lim = Math.min(200, Math.max(1, limit));
    const res = await apiFetch(`${base}/profile/wallet?limit=${lim}`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object') {
      const err =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : null;
      return { ok: false, wallet: null, history: [], error: err || `Erro ${res.status}` };
    }
    const d = raw as Record<string, unknown>;
    const hist = Array.isArray(d.history) ? (d.history as ProfileWalletHistoryDto[]) : [];
    const w =
      d.wallet && typeof d.wallet === 'object'
        ? (d.wallet as { address: string; network: string; connectedAt: string | null })
        : null;
    return { ok: true, wallet: w, history: hist };
  } catch {
    return null;
  }
}

export type AdminUserWalletCurrent = {
  address: string;
  network: string;
  connectedAt: string | null;
  status: 'connected';
};

export type AdminUserWalletHistoryEntry = {
  id: string;
  action: string;
  network: string;
  walletAddress: string | null;
  previousWalletAddress: string | null;
  newWalletAddress: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  actorType: string;
  actorUserId: number | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
  metadata?: unknown;
};

/** GET /api/admin/users/:userId/wallet-history — só admin. */
export async function getAdminUserWalletHistory(userId: number): Promise<{
  ok: boolean;
  currentWallet: AdminUserWalletCurrent | null;
  history: AdminUserWalletHistoryEntry[];
  error?: string;
}> {
  const id = Math.floor(Number(userId));
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, currentWallet: null, history: [], error: 'ID inválido.' };
  }
  try {
    const res = await apiFetch(`${base}/admin/users/${id}/wallet-history`);
    const raw = await res.json().catch(() => null);
    if (res.status === 403) {
      return { ok: false, currentWallet: null, history: [], error: 'Acesso negado (403).' };
    }
    if (!res.ok || !raw || typeof raw !== 'object') {
      const err =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ok: false, currentWallet: null, history: [], error: err };
    }
    const d = raw as Record<string, unknown>;
    const cur =
      d.currentWallet && typeof d.currentWallet === 'object'
        ? (d.currentWallet as AdminUserWalletCurrent)
        : null;
    const hist = Array.isArray(d.history) ? (d.history as AdminUserWalletHistoryEntry[]) : [];
    return { ok: true, currentWallet: cur, history: hist };
  } catch {
    return { ok: false, currentWallet: null, history: [], error: 'Erro de rede.' };
  }
}

/** Remove a carteira Polygon do perfil (sessão autenticada; sem palavra-passe). */
export async function postProfileWalletRemove(): Promise<{
  ok: boolean;
  removed?: boolean;
  message?: string;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      message?: string;
      removed?: boolean;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    }
    return {
      ok: true,
      removed: data.removed === true,
      message:
        typeof data.message === 'string'
          ? data.message
          : data.removed === true
            ? 'Carteira removida com sucesso.'
            : 'Nenhuma carteira conectada.'
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

/** @deprecated O parâmetro de palavra-passe é ignorado; use `postProfileWalletRemove`. */
export async function clearMyPolygonWallet(
  _currentPassword?: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  return postProfileWalletRemove();
}

/** Overview do Programa Genesis Referral do utilizador autenticado. */
export type ReferralOverview = {
  ok: true;
  referralCode: string | null;
  inviteUrl: string | null;
  referredBy: string | null;
  stats: {
    invitedCount: number;
    totalReferredDepositsUsdc: number;
    totalCommissionUsdc: number;
    paidCommissionUsdc: number;
    pendingCommissionUsdc: number;
    commissionRate: number;
    commissionPercent: number;
    commissionsCount: number;
  };
  referredUsers: Array<{
    id: number;
    username: string | null;
    emailMasked: string | null;
    createdAt: number;
    linkId: number;
    totalDepositedUsdc: number;
    totalCommissionUsdc: number;
    commissionsCount: number;
  }>;
  commissions: Array<{
    id: string;
    createdAt: number;
    referredUser: { id: number; username: string | null; emailMasked: string | null };
    depositAmountUsdc: number;
    commissionRate: number;
    commissionAmountUsdc: number;
    sourceType: string;
    sourceTransactionId: string;
    status: 'paid';
  }>;
};

export async function getReferralOverview(): Promise<ReferralOverview | null> {
  try {
    const res = await apiFetch(`${base}/profile/referral/overview`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as ReferralOverview;
  } catch {
    return null;
  }
}

/** Vincula código de indicação usando o endpoint moderno do perfil. */
export async function postProfileReferralBind(
  code: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/referral/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export type AdminReferralSummary = {
  ok: true;
  commissionPercent: number;
  commissionRate: number;
  stats: {
    uniqueReferrers: number;
    totalLinks: number;
    referredDistinct: number;
    commissionsCount: number;
    totalReferredDepositsUsdc: number;
    totalCommissionPaidUsdc: number;
    pendingCommissionUsdc: number;
  };
  topReferrers: Array<{
    id: number;
    username: string | null;
    email: string | null;
    invitedCount: number;
    commissionTotalUsdc: number;
  }>;
};

export type AdminReferralCommissionRow = {
  id: string;
  createdAt: number;
  sourceType: string;
  sourceTransactionId: string;
  depositAmountUsdc: number;
  commissionPercent: number;
  commissionRate: number;
  commissionAmountUsdc: number;
  referrer: { id: number; username: string | null; email: string | null };
  referred: { id: number; username: string | null; email: string | null };
  status: 'paid';
};

export type AdminReferralLinkRow = {
  linkId: number;
  referrer: { id: number; username: string | null; email: string | null };
  referred: { id: number | null; username: string | null; email: string | null };
  firstCommissionAt: number;
  totalDepositedUsdc: number;
  totalCommissionUsdc: number;
};

export async function getAdminReferralSummary(): Promise<AdminReferralSummary | null> {
  try {
    const res = await apiFetch(`${base}/admin/referrals/summary`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as AdminReferralSummary;
  } catch {
    return null;
  }
}

export async function getAdminReferralCommissions(filters: {
  page?: number;
  limit?: number;
  startDate?: number | null;
  endDate?: number | null;
  referrer?: string;
  referred?: string;
  minCommission?: number | null;
  maxCommission?: number | null;
  q?: string;
}): Promise<{
  ok: boolean;
  page: number;
  limit: number;
  total: number;
  rows: AdminReferralCommissionRow[];
} | null> {
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.startDate) params.set('startDate', String(filters.startDate));
  if (filters.endDate) params.set('endDate', String(filters.endDate));
  if (filters.referrer) params.set('referrer', filters.referrer);
  if (filters.referred) params.set('referred', filters.referred);
  if (filters.minCommission != null) params.set('minCommission', String(filters.minCommission));
  if (filters.maxCommission != null) params.set('maxCommission', String(filters.maxCommission));
  if (filters.q) params.set('q', filters.q);
  try {
    const res = await apiFetch(`${base}/admin/referrals/commissions?${params.toString()}`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as {
      ok: boolean;
      page: number;
      limit: number;
      total: number;
      rows: AdminReferralCommissionRow[];
    };
  } catch {
    return null;
  }
}

export async function getAdminReferralLinks(filters: {
  page?: number;
  limit?: number;
  q?: string;
}): Promise<{
  ok: boolean;
  page: number;
  limit: number;
  total: number;
  rows: AdminReferralLinkRow[];
} | null> {
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.q) params.set('q', filters.q);
  try {
    const res = await apiFetch(`${base}/admin/referrals/links?${params.toString()}`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as {
      ok: boolean;
      page: number;
      limit: number;
      total: number;
      rows: AdminReferralLinkRow[];
    };
  } catch {
    return null;
  }
}

export function buildAdminReferralCsvUrl(filters: {
  startDate?: number | null;
  endDate?: number | null;
  referrer?: string;
  referred?: string;
  q?: string;
}): string {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', String(filters.startDate));
  if (filters.endDate) params.set('endDate', String(filters.endDate));
  if (filters.referrer) params.set('referrer', filters.referrer);
  if (filters.referred) params.set('referred', filters.referred);
  if (filters.q) params.set('q', filters.q);
  return `${base}/admin/referrals/export.csv?${params.toString()}`;
}


export type AdminReferralLookupUser = {
  id: number;
  username: string | null;
  email: string | null;
  referralCode: string | null;
};

export type AdminReferralLookupResult = {
  query: string;
  user: AdminReferralLookupUser | null;
  referredByRaw: string | null;
  referrer: AdminReferralLookupUser | null;
  referrerChain: AdminReferralLookupUser[];
  /** Vínculos na tabela referrals (histórico). */
  referredLinkCount: number;
  /** Contas reais encontradas para bloquear/apagar. */
  referredCount: number;
  /** Vínculos sem conta correspondente (apagada ou inválida). */
  orphanLinkCount: number;
  referredUsers: AdminReferralLookupUser[];
};

export async function getAdminReferralLookup(q: string): Promise<{
  ok: boolean;
  results: AdminReferralLookupResult[];
  notFound: string[];
} | null> {
  const params = new URLSearchParams();
  params.set('q', q);
  try {
    const res = await apiFetch(`${base}/admin/referrals/lookup?${params.toString()}`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as {
      ok: boolean;
      results: AdminReferralLookupResult[];
      notFound: string[];
    };
  } catch {
    return null;
  }
}

export type AdminReferralNetworkActionResult = {
  ok: boolean;
  error?: string;
  blockedCount?: number;
  deletedCount?: number;
  referredDeleted?: number;
  referredLinkCount?: number;
  resolvableCount?: number;
  orphanLinkCount?: number;
  failed?: string[];
  referrer?: AdminReferralLookupUser | null;
  referred?: AdminReferralLookupUser[];
};

export async function adminReferralNetworkBlock(input: {
  userId?: number;
  email?: string;
  username?: string;
}): Promise<AdminReferralNetworkActionResult | null> {
  try {
    const res = await apiFetch(`${base}/admin/referrals/network-block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as AdminReferralNetworkActionResult;
  } catch {
    return null;
  }
}

export async function adminReferralNetworkDelete(input: {
  userId?: number;
  email?: string;
  username?: string;
}): Promise<AdminReferralNetworkActionResult | null> {
  try {
    const res = await apiFetch(`${base}/admin/referrals/network-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as AdminReferralNetworkActionResult;
  } catch {
    return null;
  }
}

export type AdminMiningDistributionTotals = {
  totalCoins: number;
  totalUsd: number;
  creditRows: number;
  uniqueUsers: number;
};

export type AdminMiningDistributionOverview = {
  generatedAtMs: number;
  timezone: 'UTC';
  periods: {
    today: AdminMiningDistributionTotals & { label: string; fromMs: number; toMs: number };
    last7Days: AdminMiningDistributionTotals & { label: string; fromMs: number; toMs: number };
    last30Days: AdminMiningDistributionTotals & { label: string; fromMs: number; toMs: number };
    custom: (AdminMiningDistributionTotals & { label: string; fromMs: number; toMs: number }) | null;
  };
};

export type AdminMiningDistributionByCoinRow = {
  coinId: string;
  symbol: string;
  name: string;
  totalCoins: number;
  totalUsd: number;
  creditRows: number;
  uniqueUsers: number;
  pctOfTotalUsd: number;
  theoreticalEmissionCoins: number | null;
  emissionUtilizationPct: number | null;
};

export type AdminMiningCreditLedgerRow = {
  id: string;
  userId: number;
  username: string | null;
  email: string | null;
  coinId: string;
  coinSymbol: string | null;
  roomId: string | null;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
  createdAtMs: number;
};

export async function getAdminMiningDistributionOverview(customFrom?: string, customTo?: string): Promise<AdminMiningDistributionOverview | null> {
  const params = new URLSearchParams();
  if (customFrom) params.set('customFrom', customFrom);
  if (customTo) params.set('customTo', customTo);
  try {
    const q = params.toString();
    const res = await apiFetch(`${base}/admin/mining-distribution/overview${q ? `?${q}` : ''}`);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as AdminMiningDistributionOverview | null;
  } catch {
    return null;
  }
}

export async function getAdminMiningDistributionByCoin(fromYmd: string, toYmd: string): Promise<{
  fromMs: number;
  toMs: number;
  rows: AdminMiningDistributionByCoinRow[];
  totals: AdminMiningDistributionTotals;
} | null> {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd });
  try {
    const res = await apiFetch(`${base}/admin/mining-distribution/by-coin?${params}`);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as {
      fromMs: number;
      toMs: number;
      rows: AdminMiningDistributionByCoinRow[];
      totals: AdminMiningDistributionTotals;
    } | null;
  } catch {
    return null;
  }
}

export async function getAdminMiningDistributionTimeline(
  fromYmd: string,
  toYmd: string,
  bucket: 'day' | 'week',
  coinId?: string
): Promise<{
  bucket: 'day' | 'week';
  rows: Array<{
    bucketStartMs: number;
    bucketLabel: string;
    totalCoins: number;
    totalUsd: number;
    creditRows: number;
    uniqueUsers: number;
  }>;
} | null> {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd, bucket });
  if (coinId) params.set('coinId', coinId);
  try {
    const res = await apiFetch(`${base}/admin/mining-distribution/timeline?${params}`);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as {
      bucket: 'day' | 'week';
      rows: Array<{
        bucketStartMs: number;
        bucketLabel: string;
        totalCoins: number;
        totalUsd: number;
        creditRows: number;
        uniqueUsers: number;
      }>;
    } | null;
  } catch {
    return null;
  }
}

export async function getAdminMiningDistributionCredits(filters: {
  fromYmd: string;
  toYmd: string;
  page?: number;
  limit?: number;
  userId?: number;
  coinId?: string;
  roomId?: string;
  q?: string;
}): Promise<{ total: number; page: number; limit: number; rows: AdminMiningCreditLedgerRow[] } | null> {
  const params = new URLSearchParams({ from: filters.fromYmd, to: filters.toYmd });
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.userId != null) params.set('userId', String(filters.userId));
  if (filters.coinId) params.set('coinId', filters.coinId);
  if (filters.roomId) params.set('roomId', filters.roomId);
  if (filters.q) params.set('q', filters.q);
  try {
    const res = await apiFetch(`${base}/admin/mining-distribution/credits?${params}`);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as {
      total: number;
      page: number;
      limit: number;
      rows: AdminMiningCreditLedgerRow[];
    } | null;
  } catch {
    return null;
  }
}

export function buildAdminMiningDistributionCsvUrl(filters: {
  fromYmd: string;
  toYmd: string;
  userId?: number;
  coinId?: string;
  roomId?: string;
  q?: string;
}): string {
  const params = new URLSearchParams({ from: filters.fromYmd, to: filters.toYmd });
  if (filters.userId != null) params.set('userId', String(filters.userId));
  if (filters.coinId) params.set('coinId', filters.coinId);
  if (filters.roomId) params.set('roomId', filters.roomId);
  if (filters.q) params.set('q', filters.q);
  return `${base}/admin/mining-distribution/credits/export.csv?${params.toString()}`;
}

export async function getAdminMiningDistributionUserSummary(
  userId: number,
  fromYmd: string,
  toYmd: string
): Promise<{
  userId: number;
  fromMs: number;
  toMs: number;
  totals: AdminMiningDistributionTotals;
  byCoin: AdminMiningDistributionByCoinRow[];
} | null> {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd });
  try {
    const res = await apiFetch(
      `${base}/admin/mining-distribution/users/${userId}/summary?${params}`
    );
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as {
      userId: number;
      fromMs: number;
      toMs: number;
      totals: AdminMiningDistributionTotals;
      byCoin: AdminMiningDistributionByCoinRow[];
    } | null;
  } catch {
    return null;
  }
}

export async function postAdminMiningDistributionRebuildRollups(body?: {
  fromDay?: string;
  toDay?: string;
  daysBack?: number;
}): Promise<{ ok: boolean; daysProcessed?: number; rowsUpserted?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/mining-distribution/rebuild-rollups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      daysProcessed?: number;
      rowsUpserted?: number;
    };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}` };
    return { ok: true, daysProcessed: data.daysProcessed, rowsUpserted: data.rowsUpserted };
  } catch {
    return { ok: false, error: 'Erro de rede' };
  }
}

export async function getProfileState(): Promise<ProfileApiState | null> {
  try {
    const res = await apiFetch(`${base}/profile/state`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as ProfileApiState;
  } catch {
    return null;
  }
}

export async function patchProfileIdentity(username: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/identity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, ...(typeof data === 'object' ? data : {}) } as { ok: boolean; error?: string; code?: string };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfilePasswordChange(payload: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<{ ok: boolean; error?: string; code?: string; message?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/password/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      message?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, message: data.message };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfileWalletChallenge(): Promise<{
  ok: boolean;
  challengeId?: string;
  message?: string;
  expiresAt?: number;
  chainId?: number;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/connect/challenge`, { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: (data.error as string) || `Erro ${res.status}`,
        code: data.code as string | undefined
      };
    }
    return {
      ok: true,
      challengeId: typeof data.challengeId === 'string' ? data.challengeId : undefined,
      message: typeof data.message === 'string' ? data.message : undefined,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
      chainId: typeof data.chainId === 'number' ? data.chainId : undefined
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfileWalletVerify(payload: {
  challengeId: string;
  address: string;
  signature: string;
  chainId: number;
}): Promise<{ ok: boolean; error?: string; code?: string; address?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/connect/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      address?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, address: data.address };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function getProfilePageBundle(): Promise<ProfilePageBundle | null> {
  try {
    const res = await apiFetch(`${base}/me/profile-bundle`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    const pg = d.profileGame as { usdc?: unknown; claimedReferrals?: unknown } | undefined;
    return {
      seasonPasses: Array.isArray(d.seasonPasses) ? (d.seasonPasses as SeasonPass[]) : [],
      seasonPurchases: Array.isArray(d.seasonPurchases) ? (d.seasonPurchases as SeasonPurchase[]) : [],
      accessLevels: Array.isArray(d.accessLevels) ? (d.accessLevels as AccessLevel[]) : [],
      referrals: Array.isArray(d.referrals) ? (d.referrals as string[]) : [],
      lootBoxes: Array.isArray(d.lootBoxes) ? (d.lootBoxes as LootBox[]) : [],
      newsFee: typeof d.newsFee === 'number' && Number.isFinite(d.newsFee) ? d.newsFee : Number(d.newsFee) || 0,
      profileGame: {
        usdc: Number(pg?.usdc ?? 0) || 0,
        claimedReferrals: Number(pg?.claimedReferrals ?? 0) || 0
      }
    };
  } catch {
    return null;
  }
}

/** Salva rótulos do menu (admin) em POST /api/admin/display-labels. */
export async function saveGameNavLabels(labels: Record<string, string>): Promise<Record<string, string>> {
  const payload: Record<string, string> = {};
  for (const short of GAME_NAV_LABEL_KEYS) {
    const raw = labels[short];
    const s = typeof raw === 'string' ? raw.trim().slice(0, UI_DISPLAY_LABEL_VALUE_MAX) : '';
    payload[`${GAME_NAV_DB_PREFIX}${short}`] = s;
  }
  const res = await apiFetch(`${base}/admin/display-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: payload })
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; labels?: unknown };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const merged = data.labels;
  if (!merged || typeof merged !== 'object' || Array.isArray(merged)) return {};
  return gameNavLabelsFromDisplayLabelsPayload(merged as Record<string, unknown>);
}

export type UiAccentApiPreset = { id: string; label: string; hex?: string };

export async function getAdminUiAccent(): Promise<{
  ok: boolean;
  accent?: string;
  presets?: UiAccentApiPreset[];
  error?: string;
}> {
  try {
    const res = await apiFetch(`${base}/admin/ui-accent`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    const accent = typeof data.accent === 'string' ? data.accent : '#f59e0b';
    const presetsRaw = Array.isArray(data.presets) ? data.presets : [];
    const presets: UiAccentApiPreset[] = [];
    for (const p of presetsRaw) {
      if (!p || typeof p !== 'object') continue;
      const row = p as Record<string, unknown>;
      if (typeof row.id !== 'string') continue;
      presets.push({
        id: row.id,
        label: typeof row.label === 'string' ? row.label : row.id,
        hex: typeof row.hex === 'string' ? row.hex : undefined
      });
    }
    return { ok: true, accent, presets };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function putAdminUiAccent(
  accent: string
): Promise<{ ok: boolean; accent?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/ui-accent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accent })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    return { ok: true, accent: typeof data.accent === 'string' ? data.accent : accent };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Visibilidade do separador «Roleta» no menu (`ui_display_labels.nav.roleta_tab_visible`). */
export async function saveRoletaTabNavVisible(visible: boolean): Promise<void> {
  const res = await apiFetch(`${base}/admin/display-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      labels: { 'nav.roleta_tab_visible': visible ? '1' : '0' }
    })
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

/** Lê `nav.roleta_tab_visible` a partir do mapa cru de `/api/display-labels`. */
export function parseShowRoletaTabNavFromDisplayLabels(all: Record<string, unknown>): boolean {
  const v = all['nav.roleta_tab_visible'];
  const s = v != null ? String(v).trim().toLowerCase() : '';
  if (!s) return true;
  if (['0', 'false', 'no', 'off', 'hidden', 'hide'].includes(s)) return false;
  return true;
}

export async function getLootBoxes(): Promise<LootBox[]> {
  try {
    const res = await apiFetch(`${base}/loot-boxes`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<LootBox>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/** Resposta de `POST /api/loot-boxes` (admin). */
export type SetLootBoxesResult = { ok: true; warnings?: string[] };

/** `replaceCatalog: true` = lista completa do painel de caixas; desativa no DB as que sumiram da lista. */
export async function setLootBoxes(
  boxes: LootBox[],
  options?: { replaceCatalog?: boolean }
): Promise<SetLootBoxesResult> {
  const replaceCatalog = options?.replaceCatalog === true;
  const res = await apiFetch(`${base}/loot-boxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boxes, replaceCatalog })
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: unknown } = {};
    try {
      parsed = JSON.parse(text) as { error?: unknown };
    } catch {
      /* corpo não-JSON */
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      throw new Error(parsed.error);
    }
    throw new Error((text || '').slice(0, 800) || `Erro ao salvar caixas: ${res.status}`);
  }
  let data: SetLootBoxesResult = { ok: true };
  try {
    if (text) data = JSON.parse(text) as SetLootBoxesResult;
  } catch {
    /* resposta vazia ou não-JSON — ok */
  }
  return { ok: true, warnings: Array.isArray(data.warnings) ? data.warnings : undefined };
}

/** Resumo do DELETE em cascata na base de dados (admin). */
export type LootBoxDeleteSummary = {
  lootBoxItemsRemoved: number;
  unopenedBoxesRows: number;
  playerClaimedRows: number;
  adminUpgradeBoxesRows: number;
  promoCodesCleared: number;
  referralModelsSenderCleared: number;
  referralModelsReceiverCleared: number;
  lootBoxesRemoved: number;
};

/**
 * Remove a caixa do PostgreSQL (itens, inventários, shop_once, pacotes admin, promo_codes, referral_models).
 * Use `brokenOnly: true` para apagar apenas caixas sem itens ou com soma de probabilidades ≤ 0.
 */
export async function deleteLootBox(
  boxId: string,
  options?: { brokenOnly?: boolean }
): Promise<{ ok: true; summary: LootBoxDeleteSummary }> {
  const enc = encodeURIComponent(boxId);
  const qs = options?.brokenOnly ? '?brokenOnly=1' : '';
  const res = await apiFetch(`${base}/admin/loot-boxes/${enc}${qs}`, { method: 'DELETE' });
  const text = await res.text();
  let data: { ok?: boolean; summary?: LootBoxDeleteSummary; error?: string } = {};
  try {
    if (text) data = JSON.parse(text) as typeof data;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(data.error || text || `Erro ao apagar caixa: ${res.status}`);
  }
  if (!data.ok || !data.summary) {
    throw new Error('Resposta inválida do servidor.');
  }
  return { ok: true, summary: data.summary };
}

export async function getRigRooms(): Promise<RigRoom[]> {
  try {
    const res = await apiFetch(`${base}/rig-rooms`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<RigRoom>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function setRigRooms(rooms: RigRoom[]): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/rig-rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rooms) });
    if (!res.ok) return { ok: false };
    try { return await res.json(); } catch { return { ok: true } };
  } catch { return { ok: false } }
}

export async function getMyRigRooms(email: string): Promise<RigRoom[]> {
  try {
    const res = await apiFetch(`${base}/my-rig-rooms/${encodeURIComponent(email)}`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<RigRoom>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/** Estado consolidado da área Servidores (fonte de verdade no backend). */
export type ServersStatePayload = {
  version: 1;
  usdc: number;
  serverUpdatedAt: number;
  /** Igual a `serverUpdatedAt` — controlo de versão para mutações autoritativas. */
  stateVersion?: number;
  inventoryVersion?: number;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  placedRacks: PlacedRack[];
  rigRooms: RigRoom[];
  miningCoins: MiningCoin[];
  upgrades: Upgrade[];
};

export async function getServersState(): Promise<ServersStatePayload | null> {
  try {
    const res = await apiFetch(`${base}/servers/state`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<ServersStatePayload>;
    if (j.version !== 1 || !Array.isArray(j.rigRooms)) return null;
    const serverUpdatedAt =
      typeof j.serverUpdatedAt === 'number' && Number.isFinite(j.serverUpdatedAt) ? j.serverUpdatedAt : 0;
    const stateVersion =
      typeof j.stateVersion === 'number' && Number.isFinite(j.stateVersion) ? j.stateVersion : serverUpdatedAt;
    const inventoryVersion = parseAdminInventoryVersionValue(j.inventoryVersion);
    if (typeof j.inventoryVersion === 'number' || typeof j.inventoryVersion === 'string') {
      replaceGlobalInventoryVersion(inventoryVersion);
    }
    return {
      version: 1,
      usdc: typeof j.usdc === 'number' && Number.isFinite(j.usdc) ? j.usdc : 0,
      serverUpdatedAt,
      stateVersion,
      inventoryVersion,
      stock: j.stock && typeof j.stock === 'object' && !Array.isArray(j.stock) ? (j.stock as Record<string, number>) : {},
      storedBatteries: Array.isArray(j.storedBatteries) ? (j.storedBatteries as StoredBattery[]) : [],
      placedRacks: Array.isArray(j.placedRacks) ? (j.placedRacks as PlacedRack[]) : [],
      rigRooms: j.rigRooms as RigRoom[],
      miningCoins: Array.isArray(j.miningCoins) ? (j.miningCoins as MiningCoin[]) : [],
      upgrades: Array.isArray(j.upgrades) ? (j.upgrades as Upgrade[]) : []
    };
  } catch {
    return null;
  }
}

export type ServersRackAuxIntentOk = {
  ok: true;
  serverUpdatedAt: number;
  stateVersion: number;
  inventoryVersion: number;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  placedRacks: PlacedRack[];
};

function parseServersRackAuxIntentOk(raw: Record<string, unknown>): ServersRackAuxIntentOk | null {
  const hasState =
    raw.stock && typeof raw.stock === 'object' && !Array.isArray(raw.stock) &&
    Array.isArray(raw.storedBatteries) &&
    Array.isArray(raw.placedRacks);
  if (raw.ok !== true && !hasState) return null;
  const su = Number(raw.serverUpdatedAt);
  return {
    ok: true,
    serverUpdatedAt: Number.isFinite(su) ? su : 0,
    stateVersion: Number(raw.stateVersion) || su || 0,
    inventoryVersion: parseAdminInventoryVersionValue(raw.inventoryVersion),
    stock:
      raw.stock && typeof raw.stock === 'object' && !Array.isArray(raw.stock)
        ? (raw.stock as Record<string, number>)
        : {},
    storedBatteries: Array.isArray(raw.storedBatteries) ? (raw.storedBatteries as StoredBattery[]) : [],
    placedRacks: Array.isArray(raw.placedRacks) ? (raw.placedRacks as PlacedRack[]) : []
  };
}

function rememberServersRackAuxVersions(raw: Record<string, unknown>, parsed: ServersRackAuxIntentOk): void {
  const su = Number(raw.serverUpdatedAt);
  if (Number.isFinite(su) && su > 0) setGlobalLastLoadTime(su);
  setGlobalInventoryVersion(parsed.inventoryVersion);
}

/** Equipar auxiliar na rig (bateria / cablagem / multiplicador) — mutação autoritativa. */
export async function postServersRackAuxEquip(
  rackId: string,
  body: {
    kind: 'battery' | 'wiring' | 'multiplier';
    storedBatteryId?: string;
    catalogItemId?: string;
    multiplierSlotIndex?: number;
  }
): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  const inventoryVersion = getGlobalInventoryVersion();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/aux/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, idempotencyKey: idem, clientStateVersion, inventoryVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Colocar nova rig a partir do stock (mutação autoritativa; substitui save legado neste fluxo). */
export async function postServersPlaceRack(body: {
  catalogItemId: string;
  roomId: string;
  slotIndex: number;
  idempotencyKey: string;
  clientStateVersion: number;
  inventoryVersion: number;
}): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  try {
    const res = await apiFetch(`${base}/servers/racks/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Desmontar rig a partir do servidor, devolvendo componentes válidos ao estoque. */
export async function postServersRemoveRack(
  rackId: string
): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  const inventoryVersion = getGlobalInventoryVersion();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: idem, clientStateVersion, inventoryVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Equipar GPU/minerador em slot da rig via servidor. */
export async function postServersRackMinerEquip(
  rackId: string,
  slotIndex: number,
  catalogItemId: string
): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  const inventoryVersion = getGlobalInventoryVersion();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/miners/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotIndex, catalogItemId, idempotencyKey: idem, clientStateVersion, inventoryVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Remover GPU/minerador de slot da rig via servidor. */
export async function postServersRackMinerUnequip(
  rackId: string,
  slotIndex: number
): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  const inventoryVersion = getGlobalInventoryVersion();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/miners/unequip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotIndex, idempotencyKey: idem, clientStateVersion, inventoryVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

/** Desequipar auxiliar na rig. */
export async function postServersRackAuxUnequip(
  rackId: string,
  body: { kind: 'battery' | 'wiring' | 'multiplier'; multiplierSlotIndex?: number }
): Promise<
  | ServersRackAuxIntentOk
  | { ok: false; status: number; error: string; code?: string; forceReload?: boolean }
> {
  const idem = newServerIntentIdempotencyKey();
  const clientStateVersion = getGlobalLastLoadTime();
  const inventoryVersion = getGlobalInventoryVersion();
  try {
    const res = await apiFetch(`${base}/servers/racks/${encodeURIComponent(rackId)}/aux/unequip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, idempotencyKey: idem, clientStateVersion, inventoryVersion })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' ? raw.error : 'Pedido falhou.';
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const forceReload = raw.forceReload === true;
      return { ok: false, status: res.status, error: err, code, forceReload };
    }
    const parsed = parseServersRackAuxIntentOk(raw);
    if (!parsed) return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    rememberServersRackAuxVersions(raw, parsed);
    return parsed;
  } catch {
    return { ok: false, status: 0, error: 'Erro de rede.' };
  }
}

export async function purchaseRoomSlot(
  email: string,
  roomId: string,
  quantity = 1
): Promise<{ ok: boolean; newUsdc?: number; slotsPurchased?: number; totalPaid?: number; error?: string; missing?: number }> {
  try {
    const res = await apiFetch(`${base}/rig-rooms/purchase-slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, quantity })
    });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Purchase failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' } }
}

export async function getSystemNews(): Promise<SystemNews[]> {
  try {
    const res = await apiFetch(`${base}/news`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<SystemNews>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function addOrUpdateNews(item: { id: string; text: string; link?: string; duration?: number; authorName?: string; adType?: string; imageUrl?: string }): Promise<void> {
  await apiFetch(`${base}/news`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
}

export async function uploadAdImage(file: File): Promise<{ ok: boolean; imageUrl?: string; error?: string }> {
  const formData = new FormData();
  formData.append('image', file);
  try {
    const res = await apiFetch(`${base}/admin/upload-ad`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Server returned ${res.status}: ${text.slice(0, 100)}` };
    }
    return await res.json();
  } catch (err: unknown) {
    return { ok: false, error: 'Network error: ' + (err.message || 'unknown') };
  }
}

export async function deleteNews(id: string): Promise<void> {
  await apiFetch(`${base}/news/${id}`, { method: 'DELETE' });
}

export async function getNewsFee(): Promise<number> {
  try {
    const res = await apiFetch(`${base}/news-fee`);
    if (!res.ok) return 0;
    try { const j = await res.json(); return j.feeUsdc || 0; } catch { return 0; }
  } catch { return 0; }
}

export async function setNewsFee(feeUsdc: number): Promise<void> {
  await apiFetch(`${base}/news-fee`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feeUsdc }) });
}

export async function getPendingPlayerNews(): Promise<Array<{ id: string; userId: number; username: string; email: string; text: string; link?: string; status: string; createdAt: number }>> {
  try {
    const res = await apiFetch(`${base}/player-news/pending`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch { return []; }
}

export async function getNewsExpireDays(): Promise<number> {
  try {
    const res = await apiFetch(`${base}/news-expire-days`);
    if (!res.ok) return 0;
    try { const j = await res.json(); return j.days || 0; } catch { return 0; }
  } catch { return 0; }
}

export async function setNewsExpireDays(days: number): Promise<void> {
  await apiFetch(`${base}/news-expire-days`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
}
export async function submitPlayerNews(email: string, text: string, link?: string): Promise<{ ok: boolean; newUsdc?: number; error?: string; missing?: number }> {
  try {
    const res = await apiFetch(`${base}/player-news/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, text, link }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Submit failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' } }
}

export async function approvePlayerNews(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${base}/player-news/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  try { return await res.json(); } catch { return { ok: false } }
}

export async function rejectPlayerNews(id: string): Promise<{ ok: boolean }> {
  const res = await apiFetch(`${base}/player-news/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  try { return await res.json(); } catch { return { ok: false } }
}
export async function getUsers(
  page: number = 1,
  limit: number = 50,
  search: string = '',
  sortBy: string = 'creation',
  sortDir: 'asc' | 'desc' = 'asc',
  filterStatus: string = 'all',
  filterLevel: string = 'all',
  filterAdminsOnly: boolean = false,
  filterRoom: string = 'all',
  userId?: number
): Promise<{
  users: User[];
  total: number;
  pages: number;
  levels: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  error?: string;
  code?: string;
  status?: number;
}> {
  const empty = { users: [] as User[], total: 0, pages: 0, levels: [] as { id: string; name: string }[], rooms: [] as { id: string; name: string }[] };
  const RATE_LIMIT_FALLBACK = 'Too many admin users requests.';
  const HTTP_TOO_MANY_REQUESTS = 429;
  try {
    const uid =
      userId != null && Number.isFinite(userId) && userId > 0 ? Math.floor(userId) : undefined;
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      search: search,
      sortBy,
      sortDir,
      filterStatus,
      filterLevel,
      filterRoom,
      ...(filterAdminsOnly ? { filterAdmins: '1' } : {}),
      ...(uid != null ? { userId: String(uid) } : {})
    }).toString();
    const res = await apiFetch(`${base}/users?${query}`);
    if (!res.ok) {
      let error = `Erro ${res.status}`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* ignore */
      }
      if (res.status === HTTP_TOO_MANY_REQUESTS) {
        return {
          ...empty,
          error: error || RATE_LIMIT_FALLBACK,
          code: code || 'RATE_LIMIT',
          status: res.status
        };
      }
      return { ...empty, error, code, status: res.status };
    }
    try {
      return await res.json();
    } catch {
      return { ...empty, error: 'Resposta inválida do servidor.' };
    }
  } catch {
    return { ...empty, error: 'Erro de rede.' };
  }
}

/** Admin user map — canonical: `./admin-dashboard`. */
export { getAdminUserMap } from './admin-dashboard';

export async function toggleUserBlocked(
  email: string,
  blocked: boolean
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/users/block`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, blocked })
    });
    if (!res.ok) {
      let err = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) err = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function updateUser(user: User & { newReferralFor?: string; turnstileToken?: string }): Promise<{ ok: boolean; error?: string; code?: string; requiresEmailVerification?: boolean; message?: string }> {
  try {
    const res = await apiFetch(`${base}/user`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: (data as { error?: string }).error || `Erro ${res.status}`,
        code: (data as { code?: string }).code
      };
    }
    return { ok: true, ...(typeof data === 'object' && data ? data : {}) } as { ok: boolean; error?: string; code?: string; requiresEmailVerification?: boolean; message?: string };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function deleteUser(email: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/user/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Delete failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true } };
  } catch { return { ok: false, error: 'Network error' } }
}

export async function deactivateStreamerRoomByAdmin(
  userId: number,
  currentState: GameState,
  streamerRoomId?: string
): Promise<{ ok: boolean; removedRackCount?: number; error?: string }> {
  const rid = String(streamerRoomId || '').trim();
  if (!rid) {
    return { ok: false, error: 'Sala Streamer não está no catálogo activo.' };
  }
  try {
    const nextPlacedRacks = (currentState.placedRacks || []).filter(
      (rack) => String(rack.roomId || '').trim() !== rid
    );
    const removedRackCount = Math.max(0, (currentState.placedRacks || []).length - nextPlacedRacks.length);
    const res = await saveGameStateAdminOverride(
      userId,
      { placedRacks: nextPlacedRacks },
      { reason: 'admin_disable_streamer_room' }
    );
    if (!res.ok) {
      return { ok: false, error: res.error || 'Não foi possível devolver os itens da sala streamer.' };
    }
    return { ok: true, removedRackCount };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function bulkDeleteUsers(emails: string[]): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const res = await apiFetch(`${base}/admin/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function bulkGiftUsers(emails: string[], gift: { type: string; id?: string; qty: number }): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const res = await apiFetch(`${base}/admin/bulk-gift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, gift })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getGameState(
  email: string,
  opts?: { adminOverride?: boolean }
): Promise<{ data: GameState | null; status: number; error?: string }> {
  // Use 'me' if it's the current session user to leverage the backend's session-based auth
  const target = email === 'me' ? 'me' : encodeURIComponent(email);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts?.adminOverride) headers['X-Admin-Edit'] = '1';
    const res = await apiFetch(`${base}/game-state/${target}?t=${Date.now()}`, { headers });
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
      } catch {
        /* corpo não-JSON */
      }
      return { data: null, status: res.status, error };
    }
    const data = await res.json();
    if (data && data.serverUpdatedAt) {
      globalLastLoadTime = data.serverUpdatedAt;
    }
    return { data, status: res.status };
  } catch (e) {
    console.error('[APIService] getGameState failed', e);
    return { data: null, status: 500 };
  }
}

/** Resposta canónica GET `/api/inventory/me` (stock + baterias UUID infinitas). */
export type PlayerInventoryMeOk = {
  ok: true;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  serverUpdatedAt: number;
};

function parseStoredBatteryRows(raw: unknown): StoredBattery[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredBattery[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const itemId =
      typeof o.itemId === 'string'
        ? o.itemId.trim()
        : typeof o.item_id === 'string'
          ? o.item_id.trim()
          : '';
    if (!id || !itemId) continue;
    const dn = o.displayName ?? o.display_name;
    const iu = o.imageUrl ?? o.image_url;
    out.push({
      id,
      itemId,
      displayName: typeof dn === 'string' && dn.trim() ? dn.trim() : null,
      imageUrl: typeof iu === 'string' && iu.trim() ? iu.trim() : null
    });
  }
  return out;
}

/**
 * Inventário servidor-autoritário (depósito): stock + baterias fora de rack separadas por carga cheia vs parcial.
 * Não envia corpo — o dono vem só da sessão.
 */
export async function getPlayerInventoryMe(): Promise<
  PlayerInventoryMeOk | { ok: false; status: number; error?: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/inventory/me?t=${Date.now()}`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: 'Demasiados pedidos. Aguarda um minuto.',
        code: 'RATE_LIMIT'
      };
    }
    if (!res.ok) {
      let error: string | undefined;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j?.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* corpo não-JSON */
      }
      return { ok: false, status: res.status, error, code };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    if (body.ok !== true) {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const stockRaw = body.stock;
    const stock: Record<string, number> =
      stockRaw && typeof stockRaw === 'object' && !Array.isArray(stockRaw)
        ? Object.fromEntries(
            Object.entries(stockRaw as Record<string, unknown>).filter(
              ([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'number' && Number.isFinite(v) && v > 0
            )
          ) as Record<string, number>
        : {};
    const storedBatteries = parseStoredBatteryRows(body.storedBatteries);
    const su = Number(body.serverUpdatedAt);
    const serverUpdatedAt = Number.isFinite(su) ? su : 0;
    if (serverUpdatedAt > 0) globalLastLoadTime = serverUpdatedAt;
    return { ok: true, stock, storedBatteries, serverUpdatedAt };
  } catch (e) {
    console.error('[APIService] getPlayerInventoryMe failed', e);
    return { ok: false, status: 500, error: 'Erro de rede ao carregar o inventário.' };
  }
}

/** Linha de item empilhável vinda de `GET /api/inventory/state`. */
export type InventoryStackableRowApi = {
  stockKey: string;
  catalogItemId: string;
  displayQuantity: number;
  availableQuantity: number;
  name: string;
  description: string;
  category: string;
  type: string;
  image: string | null;
  icon: string;
  baseProduction: number;
  powerConsumption: number;
  powerCapacity: number;
  slotsCapacity: number;
  aiSlotsCapacity: number;
  isNft: boolean;
};

export type InventoryStackableCategoryApi = {
  category: string;
  items: InventoryStackableRowApi[];
};

export type PlayerInventoryStateOk = {
  ok: true;
  version: 1;
  serverUpdatedAt: number;
  stateVersion: number;
  stock: Record<string, number>;
  storedBatteries: StoredBattery[];
  stackableCategories: InventoryStackableCategoryApi[];
};

function parseInventoryBatteryInstance(raw: unknown): StoredBattery | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const itemId = typeof o.itemId === 'string' ? o.itemId.trim() : '';
  if (!id || !itemId) return null;
  const dn = o.displayName;
  const iu = o.imageUrl;
  const pr = o.publicRef;
  return {
    id,
    itemId,
    publicRef: typeof pr === 'string' && pr.trim() ? pr.trim() : null,
    displayName: typeof dn === 'string' && dn.trim() ? dn.trim() : null,
    imageUrl: typeof iu === 'string' && iu.trim() ? iu.trim() : null
  };
}

function parseStackableCategories(raw: unknown): InventoryStackableCategoryApi[] {
  if (!Array.isArray(raw)) return [];
  const out: InventoryStackableCategoryApi[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const co = c as Record<string, unknown>;
    const cat = typeof co.category === 'string' ? co.category : '';
    const itemsRaw = co.items;
    const items: InventoryStackableRowApi[] = [];
    if (Array.isArray(itemsRaw)) {
      for (const it of itemsRaw) {
        if (!it || typeof it !== 'object') continue;
        const r = it as Record<string, unknown>;
        const stockKey = typeof r.stockKey === 'string' ? r.stockKey : '';
        const catalogItemId = typeof r.catalogItemId === 'string' ? r.catalogItemId : '';
        if (!stockKey || !catalogItemId) continue;
        const dq = Number(r.displayQuantity);
        const aq = Number(r.availableQuantity);
        items.push({
          stockKey,
          catalogItemId,
          displayQuantity: Number.isFinite(dq) ? dq : 0,
          availableQuantity: Number.isFinite(aq) ? aq : 0,
          name: typeof r.name === 'string' ? r.name : stockKey,
          description: typeof r.description === 'string' ? r.description : '',
          category: typeof r.category === 'string' ? r.category : 'Outros',
          type: typeof r.type === 'string' ? r.type : 'other',
          image: typeof r.image === 'string' ? r.image : null,
          icon: typeof r.icon === 'string' ? r.icon : '',
          baseProduction: Number(r.baseProduction) || 0,
          powerConsumption: Number(r.powerConsumption) || 0,
          powerCapacity: Number(r.powerCapacity) || 0,
          slotsCapacity: Number(r.slotsCapacity) || 0,
          aiSlotsCapacity: Number(r.aiSlotsCapacity) || 0,
          isNft: !!r.isNft
        });
      }
    }
    if (cat) out.push({ category: cat, items });
  }
  return out;
}

/**
 * Inventário consolidado (`GET /api/inventory/state`) — grupos para a UI + stock + baterias.
 */
export async function getPlayerInventoryState(): Promise<
  PlayerInventoryStateOk | { ok: false; status: number; error?: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/inventory/state?t=${Date.now()}`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: 'Demasiados pedidos. Aguarda um minuto.',
        code: 'RATE_LIMIT'
      };
    }
    if (!res.ok) {
      let error: string | undefined;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j?.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error, code };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    if (body.version !== 1) {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const stockRaw = body.stock;
    const stock: Record<string, number> =
      stockRaw && typeof stockRaw === 'object' && !Array.isArray(stockRaw)
        ? Object.fromEntries(
            Object.entries(stockRaw as Record<string, unknown>).filter(
              ([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'number' && Number.isFinite(v) && v > 0
            )
          ) as Record<string, number>
        : {};
    const storedBatteries: StoredBattery[] = [];
    if (Array.isArray(body.storedBatteries)) {
      for (const x of body.storedBatteries) {
        const b = parseInventoryBatteryInstance(x);
        if (b) storedBatteries.push(b);
      }
    }
    const su = Number(body.serverUpdatedAt);
    const serverUpdatedAt = Number.isFinite(su) ? su : 0;
    const sv = Number(body.stateVersion);
    const stateVersion = Number.isFinite(sv) ? sv : serverUpdatedAt;
    if (serverUpdatedAt > 0) globalLastLoadTime = serverUpdatedAt;
    return {
      ok: true,
      version: 1,
      serverUpdatedAt,
      stateVersion,
      stock,
      storedBatteries,
      stackableCategories: parseStackableCategories(body.stackableCategories)
    };
  } catch (e) {
    console.error('[APIService] getPlayerInventoryState failed', e);
    return { ok: false, status: 500, error: 'Erro de rede ao carregar o inventário.' };
  }
}

/** Shop player API — canonical: `./shop`. */
export type { ShopProductApi, ShopCartLineApi, ShopStateV1Ok, ShopCheckoutApiResult } from './shop';
export {
  parseShopStateV1Body,
  getShopState,
  postShopCartItem,
  patchShopCartLine,
  postShopCheckout,
  deleteShopCartLine as deleteShopCartLineApi,
  clearShopCart as clearShopCartApi
} from './shop';

/** Resposta GET `/api/calculator/me` — projeções calculadas no servidor. */
export type PlayerCalculatorCoinComparison = {
  id: string;
  symbol: string;
  name: string;
  priceUSD: number;
  isActivelyMining: boolean;
  dailyCoins: number;
  dailyUsd: number;
  projection30Usd: number;
  rows: Array<{ label: string; coins: number; usd: number }>;
};

export type PlayerCalculatorMeOk = {
  ok: true;
  scope: string;
  scopesUi: { id: string; name: string }[];
  generalPowerHps: number;
  coinComparisons: PlayerCalculatorCoinComparison[];
  coins: Array<{
    id: string;
    symbol: string;
    name: string;
    priceUSD: number;
    networkHashrate: number;
    blockReward: number;
    blockTime: number;
    userPowerHps: number;
    dailyCoins: number;
    dailyUsd: number;
    projection30Usd: number;
    rows: Array<{ label: string; coins: number; usd: number }>;
    blockHistory: Array<{
      id: string;
      roomId: string | null;
      windowStartMs: number;
      windowEndMs: number;
      creditedBlocks: number;
      amountCoins: number;
      amountUsd: number;
      userHashHps: number;
      networkHashrate: number;
      blockReward: number;
      blockTime: number;
    }>;
  }>;
};

function parsePlayerCalculatorRows(raw: unknown): { label: string; coins: number; usd: number }[] {
  const rows: { label: string; coins: number; usd: number }[] = [];
  if (!Array.isArray(raw)) return rows;
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label : '';
    const coinsN = Number(row.coins);
    const usdN = Number(row.usd);
    if (label && Number.isFinite(coinsN) && Number.isFinite(usdN)) rows.push({ label, coins: coinsN, usd: usdN });
  }
  return rows;
}

function parsePlayerCalculatorMeBody(body: Record<string, unknown>): PlayerCalculatorMeOk | null {
  if (body.ok !== true) return null;
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'total';
  const scopesRaw = body.scopesUi;
  const scopesUi: { id: string; name: string }[] = [];
  if (Array.isArray(scopesRaw)) {
    for (const x of scopesRaw) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (id && name) scopesUi.push({ id, name });
    }
  }
  const generalPowerHps = Number(body.generalPowerHps);
  const coinComparisons: PlayerCalculatorCoinComparison[] = [];
  if (Array.isArray(body.coinComparisons)) {
    for (const x of body.coinComparisons) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      coinComparisons.push({
        id,
        symbol: typeof o.symbol === 'string' ? o.symbol : id,
        name: typeof o.name === 'string' ? o.name : id,
        priceUSD: Number(o.priceUSD),
        isActivelyMining: Boolean(o.isActivelyMining),
        dailyCoins: Number(o.dailyCoins),
        dailyUsd: Number(o.dailyUsd),
        projection30Usd: Number(o.projection30Usd),
        rows: parsePlayerCalculatorRows(o.rows)
      });
    }
  }
  const coinsRaw = body.coins;
  const coins: PlayerCalculatorMeOk['coins'] = [];
  if (Array.isArray(coinsRaw)) {
    for (const x of coinsRaw) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      const rows = parsePlayerCalculatorRows(o.rows);
      const blockHistory: PlayerCalculatorMeOk['coins'][number]['blockHistory'] = [];
      if (Array.isArray(o.blockHistory)) {
        for (const h of o.blockHistory) {
          if (!h || typeof h !== 'object') continue;
          const item = h as Record<string, unknown>;
          const idRaw = item.id;
          const id = typeof idRaw === 'string' ? idRaw : String(idRaw ?? '').trim();
          if (!id) continue;
          blockHistory.push({
            id,
            roomId:
              typeof item.roomId === 'string' && item.roomId.trim()
                ? item.roomId.trim()
                : null,
            windowStartMs: Number(item.windowStartMs),
            windowEndMs: Number(item.windowEndMs),
            creditedBlocks: Number(item.creditedBlocks),
            amountCoins: Number(item.amountCoins),
            amountUsd: Number(item.amountUsd),
            userHashHps: Number(item.userHashHps),
            networkHashrate: Number(item.networkHashrate),
            blockReward: Number(item.blockReward),
            blockTime: Number(item.blockTime)
          });
        }
      }
      coins.push({
        id,
        symbol: typeof o.symbol === 'string' ? o.symbol : id,
        name: typeof o.name === 'string' ? o.name : id,
        priceUSD: Number(o.priceUSD),
        networkHashrate: Number(o.networkHashrate),
        blockReward: Number(o.blockReward),
        blockTime: Number(o.blockTime),
        userPowerHps: Number(o.userPowerHps),
        dailyCoins: Number(o.dailyCoins),
        dailyUsd: Number(o.dailyUsd),
        projection30Usd: Number(o.projection30Usd),
        rows,
        blockHistory
      });
    }
  }
  return {
    ok: true,
    scope,
    scopesUi,
    generalPowerHps: Number.isFinite(generalPowerHps) ? generalPowerHps : 0,
    coinComparisons,
    coins
  };
}

/**
 * Calculadora de mineração (servidor): hashrate efectivo por moeda, ganhos e tabela de projeções.
 * `scope`: `total` ou id de sala pertencente ao jogador.
 */
export async function getPlayerCalculatorMe(
  scope: string,
  signal?: AbortSignal
): Promise<PlayerCalculatorMeOk | { ok: false; status: number; error?: string; code?: string }> {
  const s = !scope || String(scope).trim() === '' ? 'total' : String(scope).trim();
  const params = new URLSearchParams({ scope: s });
  try {
    const res = await apiFetch(
      `${base}/calculator/me?${params.toString()}&t=${Date.now()}`,
      { headers: { 'Content-Type': 'application/json' }, signal },
      true
    );
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Demasiados pedidos. Aguarda um minuto.', code: 'RATE_LIMIT' };
    }
    if (!res.ok) {
      let error: string | undefined;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j?.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error, code };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    }
    const parsed = parsePlayerCalculatorMeBody(body);
    if (!parsed) return { ok: false, status: 502, error: 'Resposta inválida do servidor.' };
    return parsed;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, status: 0, error: 'aborted', code: 'ABORTED' };
    }
    console.error('[APIService] getPlayerCalculatorMe failed', e);
    return { ok: false, status: 500, error: 'Erro de rede ao carregar a calculadora.' };
  }
}

export async function getMarketListings(): Promise<MarketListing[]> {
  try {
    const res = await apiFetch(`${base}/market/listings?t=${Date.now()}`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch {
    return [];
  }
}

function parseMarketListingRow(raw: unknown): MarketListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const sellerName = typeof r.sellerName === 'string' ? r.sellerName.trim() : '';
  const sellerIdRaw = r.sellerId ?? r.seller_id;
  const sellerId =
    typeof sellerIdRaw === 'number' && Number.isFinite(sellerIdRaw) && sellerIdRaw > 0
      ? Math.floor(sellerIdRaw)
      : typeof sellerIdRaw === 'string' && /^\d+$/.test(sellerIdRaw.trim())
        ? parseInt(sellerIdRaw.trim(), 10)
        : undefined;
  const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : '';
  if (!id || !itemId) return null;
  const price = Number(r.price);
  const qty = Math.max(1, Math.floor(Number(r.qty)) || 1);
  const lineTotal =
    r.lineTotal != null && Number.isFinite(Number(r.lineTotal)) ? Number(r.lineTotal) : price * qty;
  return {
    id,
    sellerId,
    sellerName,
    itemId,
    price: Number.isFinite(price) ? price : 0,
    qty,
    lineTotal,
    buyerPaidUsdc: r.buyerPaidUsdc != null ? Number(r.buyerPaidUsdc) : undefined,
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : parseInt(String(r.expiresAt ?? '0'), 10) || 0,
    reservedBy: typeof r.reservedBy === 'string' ? r.reservedBy : undefined,
    reservedUntil:
      typeof r.reservedUntil === 'number' ? r.reservedUntil : r.reservedUntil != null ? Number(r.reservedUntil) : undefined,
    status: r.status === 'active' || r.status === 'sold' ? r.status : undefined
  };
}

export type BlackMarketStateV1Ok = {
  ok: true;
  version: 1;
  enabled: boolean;
  usdc: number;
  blackMarketBalance: number;
  priceBandPercent: number;
  listings: { items: MarketListing[]; total: number; limit: number; offset: number };
  myActiveListings: MarketListing[];
  custody: MarketListing[];
  sellableStock: Array<{ itemId: string; qty: number }>;
  buyFilterCategories: string[];
  history: { purchases: P2PMarketTradeHistoryEntry[]; sales: P2PMarketTradeHistoryEntry[]; limit: number };
};

export async function getBlackMarketState(): Promise<
  BlackMarketStateV1Ok | { ok: false; status: number; error?: string }
> {
  try {
    const res = await apiFetch(`${base}/black-market/state?t=${Date.now()}`);
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j?.error === 'string') error = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    if (raw.version !== 1) return { ok: false, status: 502, error: 'Resposta inválida.' };
    const listingsRaw = raw.listings;
    const items: MarketListing[] = [];
    if (listingsRaw && typeof listingsRaw === 'object' && !Array.isArray(listingsRaw)) {
      const lr = listingsRaw as Record<string, unknown>;
      const arr = Array.isArray(lr.items) ? lr.items : [];
      for (const x of arr) {
        const m = parseMarketListingRow(x);
        if (m) items.push(m);
      }
      const total = Number((lr as { total?: unknown }).total);
      const limit = Number((lr as { limit?: unknown }).limit);
      const offset = Number((lr as { offset?: unknown }).offset);
      const myRaw = Array.isArray(raw.myActiveListings) ? raw.myActiveListings : [];
      const myActiveListings = myRaw.map(parseMarketListingRow).filter((x): x is MarketListing => x != null);
      const custRaw = Array.isArray(raw.custody) ? raw.custody : [];
      const custody = custRaw.map(parseMarketListingRow).filter((x): x is MarketListing => x != null);
      const sellRaw = Array.isArray(raw.sellableStock) ? raw.sellableStock : [];
      const sellableStock = sellRaw
        .map((s) => {
          if (!s || typeof s !== 'object') return null;
          const o = s as Record<string, unknown>;
          const itemId = typeof o.itemId === 'string' ? o.itemId : '';
          const qty = Math.floor(Number(o.qty));
          if (!itemId || !Number.isFinite(qty)) return null;
          return { itemId, qty };
        })
        .filter((x): x is { itemId: string; qty: number } => x != null);
      const catRaw = Array.isArray(raw.buyFilterCategories) ? raw.buyFilterCategories : [];
      const buyFilterCategories = catRaw
        .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        .map((c) => c.trim());
      const histRaw = raw.history;
      const histPurch: P2PMarketTradeHistoryEntry[] = [];
      const histSales: P2PMarketTradeHistoryEntry[] = [];
      if (histRaw && typeof histRaw === 'object' && !Array.isArray(histRaw)) {
        const h = histRaw as Record<string, unknown>;
        const parseHist = (row: unknown): P2PMarketTradeHistoryEntry | null => {
          if (!row || typeof row !== 'object') return null;
          const r = row as Record<string, unknown>;
          const itemId = typeof r.itemId === 'string' ? r.itemId : '';
          if (!itemId) return null;
          return {
            at: typeof r.at === 'number' ? r.at : parseInt(String(r.at ?? '0'), 10) || 0,
            itemId,
            qty: Math.max(1, parseInt(String(r.qty ?? 1), 10) || 1),
            unitPrice: Number(r.unitPrice) || 0,
            buyerPaidUsdc: Number(r.buyerPaidUsdc) || 0,
            sellerReceivedUsdc: Number(r.sellerReceivedUsdc) || 0,
            taxUsdc: Number(r.taxUsdc) || 0,
            counterpartName: typeof r.counterpartName === 'string' ? r.counterpartName : '—'
          };
        };
        if (Array.isArray(h.purchases)) for (const x of h.purchases) {
          const p = parseHist(x);
          if (p) histPurch.push(p);
        }
        if (Array.isArray(h.sales)) for (const x of h.sales) {
          const p = parseHist(x);
          if (p) histSales.push(p);
        }
      }
      return {
        ok: true,
        version: 1,
        enabled: raw.enabled !== false,
        usdc: Number(raw.usdc) || 0,
        blackMarketBalance: Number(raw.blackMarketBalance) || 0,
        priceBandPercent: Number(raw.priceBandPercent) || 20,
        listings: {
          items,
          total: Number.isFinite(total) ? total : items.length,
          limit: Number.isFinite(limit) ? limit : 60,
          offset: Number.isFinite(offset) ? offset : 0
        },
        myActiveListings,
        custody,
        sellableStock,
        buyFilterCategories,
        history: {
          purchases: histPurch,
          sales: histSales,
          limit: typeof (histRaw as Record<string, unknown>)?.limit === 'number' ? (histRaw as { limit: number }).limit : 80
        }
      };
    }
    return { ok: false, status: 502, error: 'Resposta inválida.' };
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export type BlackMarketListingsPageOk = {
  ok: true;
  items: MarketListing[];
  total: number;
  limit: number;
  offset: number;
};

export async function getBlackMarketListingsPage(params: {
  search?: string;
  category?: string;
  type?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): Promise<BlackMarketListingsPageOk | { ok: false; status: number; error?: string }> {
  const sp = new URLSearchParams();
  if (params.search?.trim()) sp.set('q', params.search.trim());
  if (params.category?.trim()) sp.set('category', params.category.trim());
  if (params.type?.trim()) sp.set('type', params.type.trim());
  if (params.sort) sp.set('sort', params.sort);
  if (params.limit != null) sp.set('limit', String(params.limit));
  if (params.offset != null) sp.set('offset', String(params.offset));
  try {
    const res = await apiFetch(`${base}/black-market/listings?${sp.toString()}&t=${Date.now()}`);
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j?.error === 'string') error = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    if (raw.version !== 1) return { ok: false, status: 502, error: 'Resposta inválida.' };
    const arr = Array.isArray(raw.items) ? raw.items : [];
    const items = arr.map(parseMarketListingRow).filter((x): x is MarketListing => x != null);
    return {
      ok: true,
      items,
      total: Number(raw.total) || 0,
      limit: Number(raw.limit) || 60,
      offset: Number(raw.offset) || 0
    };
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

const emptyP2pHistory: P2PMarketTradeHistory = { purchases: [], sales: [] };

export async function getMarketTradeHistory(): Promise<P2PMarketTradeHistory> {
  try {
    const res = await apiFetch(`${base}/market/history?limit=100&t=${Date.now()}`);
    if (!res.ok) return emptyP2pHistory;
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      return emptyP2pHistory;
    }
    if (!j || typeof j !== 'object') return emptyP2pHistory;
    const o = j as Record<string, unknown>;
    const purchases = Array.isArray(o.purchases) ? o.purchases : [];
    const sales = Array.isArray(o.sales) ? o.sales : [];
    const norm = (row: unknown): P2PMarketTradeHistoryEntry | null => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const at = typeof r.at === 'number' ? r.at : parseInt(String(r.at ?? '0'), 10) || 0;
      const itemId = typeof r.itemId === 'string' ? r.itemId : String(r.itemId ?? '');
      const qty = Math.max(1, parseInt(String(r.qty ?? 1), 10) || 1);
      const unitPrice = Number(r.unitPrice);
      const buyerPaidUsdc = Number(r.buyerPaidUsdc);
      const sellerReceivedUsdc = Number(r.sellerReceivedUsdc);
      const taxUsdc = Number(r.taxUsdc);
      const counterpartName = typeof r.counterpartName === 'string' ? r.counterpartName : '—';
      if (!itemId) return null;
      return {
        at,
        itemId,
        qty,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
        buyerPaidUsdc: Number.isFinite(buyerPaidUsdc) ? buyerPaidUsdc : 0,
        sellerReceivedUsdc: Number.isFinite(sellerReceivedUsdc) ? sellerReceivedUsdc : 0,
        taxUsdc: Number.isFinite(taxUsdc) ? taxUsdc : 0,
        counterpartName
      };
    };
    return {
      purchases: purchases.map(norm).filter((x): x is P2PMarketTradeHistoryEntry => x != null),
      sales: sales.map(norm).filter((x): x is P2PMarketTradeHistoryEntry => x != null)
    };
  } catch {
    return emptyP2pHistory;
  }
}

export async function reserveMarketListing(listingId: string): Promise<{ ok: boolean; error?: string; reservedUntil?: number }> {
  try {
    const res = await apiFetch(`${base}/market/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId }) });
    try { return await res.json(); } catch { return { ok: false, error: 'Reserve failed' }; }
  } catch { return { ok: false, error: 'Network error' } }
}

export async function cancelMarketReservation(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/cancel-reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId }) });
    try { return await res.json(); } catch { return { ok: false, error: 'Cancel failed' }; }
  } catch { return { ok: false, error: 'Network error' } }
}

export type BuyMarketListingResult = {
  ok: boolean;
  error?: string;
  missing?: number;
  message?: string;
  purchasedQty?: number;
  totalUsdc?: number;
  unitPrice?: number;
};

/** Alinhar com nginx `proxy_read_timeout` 300s em /api/market/ (evitar abort aos 100s com servidor lento). */
const MARKET_BUY_FETCH_MS = 300_000;

export async function buyMarketListing(
  listingId: string,
  qty?: number,
  opts?: { idempotencyKey?: string }
): Promise<BuyMarketListingResult> {
  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), MARKET_BUY_FETCH_MS);
  try {
    const body: Record<string, unknown> = { listingId };
    if (qty != null) {
      const q = Math.floor(Number(qty));
      if (Number.isFinite(q) && q >= 1) {
        body.qty = q;
        body.quantity = q;
      }
    }
    const ik = opts?.idempotencyKey?.trim();
    if (ik) body.idempotencyKey = ik.slice(0, 128);
    const res = await apiFetch(`${base}/market/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      if (res.status === 524 || res.status === 504) {
        return {
          ok: false,
          error:
            'Timeout (Cloudflare ou servidor). No painel Cloudflare aumenta o tempo máximo da origem para a API; na VPS confirma nginx com proxy_read_timeout alto em /api/market/. Recarrega e verifica o saldo antes de repetir.'
        };
      }
      try {
        return await res.json();
      } catch {
        return { ok: false, error: `Erro HTTP ${res.status}` };
      }
    }
    try {
      return await res.json();
    } catch {
      return { ok: true };
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error:
          'Pedido cancelado após vários minutos sem resposta do servidor. Se o saldo mudou, a compra pode ter concluído na mesma — recarrega antes de tentar outra vez. Se repetir, verifica Cloudflare/nginx e carga na base de dados.'
      };
    }
    return { ok: false, error: 'Network error' };
  } finally {
    clearTimeout(kill);
  }
}

export async function claimMarketFunds(): Promise<{ ok: boolean; claimed?: number; newUsdc?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/claim`, { method: 'POST' });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Claim failed' }; }
    }
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function sellMarketListing(itemId: string, price: number, qty: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/sell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, price, qty }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Sell failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function cancelMarketListing(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Cancel failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function getCustodyListings(): Promise<MarketListing[]> {
  try {
    const res = await apiFetch(`${base}/market/custody?t=${Date.now()}`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch {
    return [];
  }
}

export async function claimCustodyItem(listingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/claim-item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' }; }
}

/**
 * Resgata, numa única transação no backend, todos os itens em custódia do
 * utilizador. O servidor responde 400 amigável se não houver nada para resgatar.
 */
export async function claimAllCustodyItems(): Promise<{ ok: boolean; claimed?: number; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/market/claim-all`, { method: 'POST' });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function getTopWithdrawalsByCoin(): Promise<Array<{ coinId: string; coinName: string; top: { username: string; email: string; total: number }[] }>> {
  try {
    const res = await apiFetch(`${base}/stats/top-withdrawals-by-coin`);
    if (!res.ok) return [];
    try {
      return parseJsonArray(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function getAdminUpgrades(): Promise<AdminUpgrade[]> {
  try {
    const res = await apiFetch(`${base}/admin-upgrades`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<AdminUpgrade>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function getAdminUpgradePurchases(email: string): Promise<string[]> {
  try {
    const res = await apiFetch(`${base}/admin-upgrade-purchases/${encodeURIComponent(email)}`);
    if (!res.ok) return [];
    try {
      return parseJsonArray<string>(await res.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function createAdminUpgrade(upgrade: AdminUpgrade): Promise<{ ok: boolean; id?: string }> {
  try {
    const payload: unknown = {
      id: upgrade.id,
      name: upgrade.name,
      description: upgrade.description || '',
      priceUsdc: upgrade.priceUsdc || 0,
      grantUsdc: upgrade.grantUsdc || 0,
      grantAccessLevelId: upgrade.grantAccessLevelId || null,
      isActive: upgrade.isActive === false ? false : true,
      items: (upgrade.items || []).map(it => ({ itemId: it.itemId, qty: it.qty })),
      boxes: (upgrade.boxes || []).map(b => ({ boxId: b.boxId, qty: b.qty })),
      passes: Array.isArray(upgrade.passes) ? upgrade.passes : [],
      coins: (upgrade.coins || []).map(c => ({ coinId: c.coinId, amount: c.amount })),
      visibleToAccessLevelIds: upgrade.visibleToAccessLevelIds || []
    };
    const res = await apiFetch(`${base}/admin-upgrades`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) return { ok: false };
    try { return await res.json(); } catch { return { ok: true } };
  } catch { return { ok: false } }
}

export async function deleteAdminUpgrade(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin-upgrades/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: txt };
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e.message || 'Error' };
  }
}

export async function purchaseAdminUpgrade(email: string, upgradeId: string): Promise<{ ok: boolean; newUsdc?: number; error?: string; missing?: number }> {
  try {
    const res = await apiFetch(`${base}/admin-upgrades/purchase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upgradeId }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Purchase failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true } };
  } catch { return { ok: false, error: 'Network error' } }
}

export type UpgradesStatePackagePreview = {
  rewardType: string;
  catalogId: string;
  quantity: number;
  label: string;
};

export type UpgradesStatePackage = {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category: string;
  currency: string;
  finalPrice: string;
  originalPrice: string | null;
  discountPercent: number | null;
  version: number;
  isPurchasable: boolean;
  unpurchasableReason: string | null;
  stockRemaining: number | null;
  maxPerUser: number;
  startsAt: number | null;
  endsAt: number | null;
  sortOrder: number;
  alreadyOwned: boolean;
  itemsPreview: UpgradesStatePackagePreview[];
};

export type UpgradesStatePayload = {
  ok: boolean;
  title: string;
  usdcBalance: number;
  categories: string[];
  packages: UpgradesStatePackage[];
  purchaseHistory: Array<{
    upgradeId: string;
    name: string;
    paidUsdc: string;
    purchasedAt: number;
  }>;
  notice?: string;
};

export async function getUpgradesState(): Promise<UpgradesStatePayload | null> {
  try {
    const res = await apiFetch(`${base}/upgrades/state`);
    if (!res.ok) return null;
    const j = (await res.json()) as UpgradesStatePayload;
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

export type UpgradesPurchaseResult =
  | {
      ok: true;
      newUsdc: number;
      idempotentReplay: boolean;
      packageVersion: number;
      /** Caixa criada para o pacote em Caixas da Sorte. */
      box?: { id: string; name: string; quantity: number };
    }
  | { ok: false; error?: string; status?: number; missing?: number };

/** Compra de pacote (Upgrades) — idempotência obrigatória. */
export async function postUpgradesPurchase(params: {
  packageId: string;
  idempotencyKey: string;
  clientPackageVersion?: number;
}): Promise<UpgradesPurchaseResult> {
  try {
    const res = await apiFetch(`${base}/upgrades/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: params.packageId,
        idempotencyKey: params.idempotencyKey,
        clientPackageVersion: params.clientPackageVersion
      })
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: 'Resposta inválida do servidor.', status: res.status };
    }
    if (!res.ok) {
      const missing = typeof json.missing === 'number' ? json.missing : undefined;
      return {
        ok: false,
        error: typeof json.error === 'string' ? json.error : 'Pedido rejeitado.',
        status: res.status,
        missing
      };
    }
    const boxRaw = json.box;
    const box =
      boxRaw && typeof boxRaw === 'object' && boxRaw !== null
        ? {
            id: typeof (boxRaw as Record<string, unknown>).id === 'string' ? String((boxRaw as Record<string, unknown>).id) : '',
            name:
              typeof (boxRaw as Record<string, unknown>).name === 'string'
                ? String((boxRaw as Record<string, unknown>).name)
                : '',
            quantity:
              typeof (boxRaw as Record<string, unknown>).quantity === 'number'
                ? Number((boxRaw as Record<string, unknown>).quantity)
                : 1
          }
        : undefined;
    return {
      ok: true,
      newUsdc: typeof json.newUsdc === 'number' ? json.newUsdc : 0,
      idempotentReplay: json.idempotentReplay === true,
      packageVersion: typeof json.packageVersion === 'number' ? json.packageVersion : 1,
      box: box && box.id ? box : undefined
    };
  } catch {
    return { ok: false, error: 'Erro de rede' };
  }
}

/** Web3 settings — canonical: `./wallet`. */
export { web3DepositFlagDisabled, getWeb3Settings, setWeb3Settings } from './wallet';

/** Wheel (code/spin) — canonical: `./wheel`. */
export type { WheelStatePayload } from './wheel';
export {
  getPendingRoletaCode,
  newWheelIdempotencyKey,
  getWheelState,
  postWheelSpin,
  postWheelRedeemCode,
  rollWheel,
  claimRoletaPrize
} from './wheel';

/** Mining coins admin catalog — canonical: `./admin-economy`. */
export {
  getMiningCoins,
  MINING_BLOCK_TIME_SECONDS,
  normalizeMiningCoinPayload,
  saveMiningCoin,
  deleteMiningCoin
} from './admin-economy';

export async function getNfts(contract: string, owner: string): Promise<Array<{ contract: string; tokenId: string; ownerAddress: string; metadata?: unknown }>> {
  try {
    const params = new URLSearchParams({ contract, owner });
    const res = await apiFetch(`${base}/nfts?${params.toString()}`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch {
    return [];
  }
}

export async function receiveNft(payload: { contract: string; tokenId: string; toAddress: string }): Promise<void> {
  await apiFetch(`${base}/nfts/receive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

export async function sendNft(payload: { contract: string; tokenId: string; fromAddress: string; toAddress: string }): Promise<void> {
  await apiFetch(`${base}/nfts/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

export async function login(
  email: string,
  password: string,
  deviceFingerprint?: DeviceFingerprintPayload,
  turnstileToken?: string
): Promise<unknown> {
  try {
    const body: Record<string, unknown> = { email, password };
    if (deviceFingerprint) body.deviceFingerprint = deviceFingerprint;
    if (turnstileToken) body.turnstileToken = turnstileToken;
    const res = await apiFetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok) setSessionHint(true);
    if (!res.ok) return { error: data.error || 'Erro desconhecido', code: data.code, emailVerificationRequired: data.emailVerificationRequired };
    return data;
  } catch (err: unknown) {
    return { error: 'Network Error: ' + err.message };
  }
}

export async function requestEmailVerification(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/request-email-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, message: data.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Erro de rede' };
  }
}

export async function verifyEmailToken(token: string): Promise<{ ok: boolean; message?: string; error?: string; alreadyVerified?: boolean }> {
  try {
    const res = await apiFetch(`${base}/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network Error' };
  }
}

export async function getSession(): Promise<User | null> {
  // Sempre tenta resolver sessão no arranque da página.
  // Isso evita ficar preso no /login quando a hint local foi limpa,
  // mas o cookie HTTP-only da sessão ainda está válido.
  try {
    const res = await apiFetch(`${base}/session`);
    if (!res.ok) {
      /** 404/401 após migração ou conta removida: limpar hint evita martelar APIs com cookies fantasma. */
      if (res.status === 401 || res.status === 404) setSessionHint(false);
      return null;
    }
    setSessionHint(true);
    try { return await res.json(); } catch { return null; }
  } catch {
    // Falha de rede transitória não deve matar a hint de sessão.
    return null;
  }
}

export async function logout(): Promise<void> {
  setSessionHint(false);
  await apiFetch(`${base}/logout`, { method: 'POST' });
}

let globalLastLoadTime = 0;
const INVENTORY_VERSION_MIN = 0;
let globalInventoryVersion = INVENTORY_VERSION_MIN;

function parseAdminInventoryVersionValue(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= INVENTORY_VERSION_MIN) return Math.floor(n);
  return INVENTORY_VERSION_MIN;
}

/** Revisão do servidor usada em saves e mutações autoritárias (ex.: oficina). */
export function getGlobalLastLoadTime(): number {
  return globalLastLoadTime;
}

export function setGlobalLastLoadTime(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) globalLastLoadTime = ms;
}

/** `game_states.inventory_version` — OCC de mutações rack (não usar serverUpdatedAt). */
export function getGlobalInventoryVersion(): number {
  return globalInventoryVersion;
}

export function setGlobalInventoryVersion(version: number): void {
  if (!Number.isFinite(version) || version < INVENTORY_VERSION_MIN) return;
  const next = Math.floor(version);
  if (next >= globalInventoryVersion) globalInventoryVersion = next;
}

/** Load autoritativo de estado — substitui mesmo se menor (ex.: troca conta gerente→dono). */
export function replaceGlobalInventoryVersion(version: number): void {
  if (!Number.isFinite(version) || version < INVENTORY_VERSION_MIN) return;
  globalInventoryVersion = Math.floor(version);
}

/** Chave idempotência para mutações de intenção na área Servidores (8–128 chars seguros). */
export function newServerIntentIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `srv_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

// fetchGameState removida em favor de getGameState unificada

/** Bateria em massa na sala (Servidores) — servidor aplica regras e persiste. */
export async function postServerRoomBulkBatteries(payload: {
  roomId: string;
  batteryUpgradeId?: string;
  smartFill?: boolean;
  rigSort?: string;
  idempotencyKey: string;
  clientStateVersion?: number;
}): Promise<
  | {
      ok: true;
      serverUpdatedAt: number;
      stateVersion: number;
      stock: Record<string, number>;
      storedBatteries: StoredBattery[];
      placedRacks: PlacedRack[];
      appliedRigs: number;
      compatibleRigs: number;
      smartFill?: boolean;
      idempotentReplay?: boolean;
    }
  | { ok: false; error: string; status?: number; code?: string; forceReload?: boolean }
> {
  try {
    const res = await apiFetch(`${base}/server-room/bulk-batteries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      const code = typeof data.code === 'string' ? data.code : undefined;
      const forceReload = data.forceReload === true;
      return { ok: false, error: err, status: res.status, code, forceReload };
    }
    const su = Number(data.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) globalLastLoadTime = su;
    return {
      ok: true,
      serverUpdatedAt: su,
      stateVersion: Number(data.stateVersion) || su || 0,
      stock: (data.stock as Record<string, number>) || {},
      storedBatteries: Array.isArray(data.storedBatteries) ? (data.storedBatteries as StoredBattery[]) : [],
      placedRacks: Array.isArray(data.placedRacks) ? (data.placedRacks as PlacedRack[]) : [],
      appliedRigs: Math.max(0, Math.floor(Number(data.appliedRigs) || 0)),
      compatibleRigs: Math.max(0, Math.floor(Number(data.compatibleRigs) || 0)),
      smartFill: !!data.smartFill,
      idempotentReplay: data.idempotentReplay === true
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Gravação de estado completo como admin (rota dedicada; não usar `saveGameState` com adminOverride). */
export async function saveGameStateAdminOverride(
  targetUserId: number,
  state: Partial<GameState>,
  options?: { reason?: string; keepalive?: boolean }
): Promise<{
  ok: boolean;
  forceReload?: boolean;
  error?: string;
  code?: string;
  fields?: unknown;
  serverUpdatedAt?: number;
  nftAutoSanitized?: boolean;
  placedRacks?: PlacedRack[];
  stock?: Record<string, number>;
  storedBatteries?: StoredBattery[];
}> {
  const payload: Record<string, unknown> = {
    changes: { ...state, lastLoadTime: globalLastLoadTime }
  };
  if (options?.reason) payload.reason = options.reason;
  const url = `${base}/admin/users/${encodeURIComponent(String(targetUserId))}/save-game-override`;
  try {
    const body = JSON.stringify(payload);
    const useKeepalive = !!options?.keepalive && body.length < SAVE_GAME_KEEPALIVE_MAX_BYTES;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(useKeepalive ? { keepalive: true as const } : {})
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        return { ok: false, ...(errBody as object) };
      } catch {
        return { ok: false, error: `HTTP ${res.status}` };
      }
    }
    try {
      const data = await res.json();
      if (data && data.serverUpdatedAt) {
        globalLastLoadTime = data.serverUpdatedAt;
      }
      return data;
    } catch {
      console.warn('[saveGameStateAdminOverride] Resposta não-JSON após HTTP OK.');
      return { ok: false, error: 'Resposta inválida ao guardar. Recarregue (F5).' };
    }
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Moeda em todas as rigs da sala (Servidores) — servidor valida e persiste. */
export async function postServerRoomRoomCoins(
  roomId: string,
  coinId: string
): Promise<{ ok: true; serverUpdatedAt: number; placedRacks: PlacedRack[] } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(`${base}/server-room/room-coins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, coinId })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      return { ok: false, error: err };
    }
    const su = Number(data.serverUpdatedAt);
    if (Number.isFinite(su) && su > 0) globalLastLoadTime = su;
    return {
      ok: true,
      serverUpdatedAt: su,
      placedRacks: Array.isArray(data.placedRacks) ? (data.placedRacks as PlacedRack[]) : []
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** fetch + keepalive: corpos grandes falham no browser (~64 KiB). */
const SAVE_GAME_KEEPALIVE_MAX_BYTES = 61440;

export type GameSaveDomainHeader = 'inventory' | 'servers';

export async function saveGameState(
  email: string,
  state: Partial<GameState>,
  options: { adminOverride?: boolean; keepalive?: boolean; domain?: GameSaveDomainHeader } = {}
): Promise<{
  ok: boolean;
  forceReload?: boolean;
  error?: string;
  serverUpdatedAt?: number;
  nftAutoSanitized?: boolean;
  placedRacks?: PlacedRack[];
  stock?: Record<string, number>;
  storedBatteries?: StoredBattery[];
}> {
  // email is now redundant but kept in signature for compatibility
  const domain = options.domain;
  let url = `${base}/save-game`;
  let payload: Record<string, unknown>;
  if (domain === 'inventory') {
    url = `${base}/game/save-inventory`;
    payload = { lastLoadTime: globalLastLoadTime };
    if (state.stock != null) payload.stock = state.stock;
    if (state.storedBatteries != null) payload.storedBatteries = state.storedBatteries;
  } else if (domain === 'servers') {
    url = `${base}/game/save-servers`;
    payload = { lastLoadTime: globalLastLoadTime, placedRacks: state.placedRacks };
    if (state.stock != null) (payload as Record<string, unknown>).stock = state.stock;
    if (state.storedBatteries != null) (payload as Record<string, unknown>).storedBatteries = state.storedBatteries;
  } else {
    payload = {
      changes: { ...state, lastLoadTime: globalLastLoadTime },
      adminOverride: options.adminOverride,
      targetEmail: email
    };
  }
  try {
    const body = JSON.stringify(payload);
    const useKeepalive = !!options.keepalive && body.length < SAVE_GAME_KEEPALIVE_MAX_BYTES;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const res = await apiFetch(url, {
      method: 'POST',
      headers,
      body,
      ...(useKeepalive ? { keepalive: true as const } : {})
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        return { ok: false, ...errBody };
      } catch {
        return { ok: false, error: `HTTP ${res.status}` };
      }
    }
    try {
      const data = await res.json();
      if (data && data.serverUpdatedAt) {
        globalLastLoadTime = data.serverUpdatedAt;
      }
      return data;
    } catch {
      // HTTP 200 mas corpo inválido: não fingir sucesso — senão `globalLastLoadTime` fica velho e todos os saves seguintes levam `forceReload`.
      console.warn('[saveGameState] Resposta não-JSON após HTTP OK; o cliente deve recarregar o estado.');
      return { ok: false, error: 'Resposta inválida ao guardar. Recarregue (F5).' };
    }
  } catch { return { ok: false, error: 'Network error' }; }
}

export type {
  SupportTicketAttachment,
  SupportTicketReplyRow,
  SupportTicketPlayerReplyRow,
  SupportTicketRow,
  MySupportTicketSummary,
  MySupportTicketDetail,
  SupportStatePayload,
  SupportStateTicketRow,
} from './supportTicketsApi';
export {
  postSupportMutate,
  submitSupportTicket,
  getAdminSupportTickets,
  postAdminSupportTicketReply,
  updateAdminSupportTicketStatus,
  getMySupportTickets,
  getMySupportTicketDetail,
  postPlayerSupportTicketReply,
  getSupportState,
  newSupportIdempotencyKey,
  archiveSupportTicket,
  reopenSupportTicket,
  getAdminSupportUserHistory,
  getAdminSupportTicketDetail,
} from './supportTicketsApi';
export type {
  SupportUserHistoryTicketSummary,
  SupportUserHistoryResponse,
  SupportUserHistoryResult,
} from './supportTicketsApi';

export async function getReferrals(email: string): Promise<string[]> {
  try {
    const res = await apiFetch(`${base}/referrals/${encodeURIComponent(email)}`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch { return []; }
}

export async function claimReferralCode(
  _email: string,
  code: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/referral/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) {
      return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getSeasonPasses(): Promise<SeasonPass[]> {
  try {
    const res = await apiFetch(`${base}/season-passes`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch { return []; }
}

export async function setSeasonPasses(passes: SeasonPass[]): Promise<void> {
  const res = await apiFetch(`${base}/season-passes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(passes) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Erro ao salvar passes de temporada: ${res.status}`);
  }
}

export async function getSeasonPurchases(email: string): Promise<SeasonPurchase[]> {
  try {
    const res = await apiFetch(`${base}/season-purchases/${encodeURIComponent(email)}`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch { return []; }
}

export async function purchaseSeasonPass(passId: string, _email: string): Promise<{ ok: boolean; newUsdc?: number; error?: string; missing?: number }> {
  try {
    const res = await apiFetch(`${base}/season-pass/purchase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passId }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Purchase failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true }; }
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function grantSeasonPass(email: string, passId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/season-pass/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Edit': '1' }, body: JSON.stringify({ email, passId }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Grant failed' }; }
    }
    try { return await res.json(); } catch { return { ok: true } };
  } catch { return { ok: false, error: 'Network error' } }
}

export async function getMonetizationSettings(): Promise<MonetizationSettings | null> {
  try {
    const res = await apiFetch(`${base}/monetization-settings`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Inclui applixirCallbackSecret — apenas para o painel admin autenticado. */
export async function getAdminMonetizationSettings(): Promise<MonetizationSettings | null> {
  try {
    const res = await apiFetch(`${base}/admin/monetization-settings?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function getSecurityStats(section?: string): Promise<SecurityStats | null> {
  try {
    const qs = new URLSearchParams();
    if (section && section.trim()) qs.set('section', section.trim());
    const res = await apiFetch(`${base}/admin/security/stats${qs.toString() ? `?${qs.toString()}` : ''}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export type AdminSecurityBulkToolsConfig = {
  ok: boolean;
  inactiveBlockDays: number;
  autoBlockEnabled: boolean;
  error?: string;
};

export async function getAdminSecurityBulkToolsConfig(): Promise<AdminSecurityBulkToolsConfig | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/bulk-tools/config`);
    if (!res.ok) return null;
    return (await res.json()) as AdminSecurityBulkToolsConfig;
  } catch {
    return null;
  }
}

export async function saveAdminSecurityBulkToolsConfig(input: {
  inactiveBlockDays: number;
  autoBlockEnabled: boolean;
}): Promise<AdminSecurityBulkToolsConfig | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/bulk-tools/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as AdminSecurityBulkToolsConfig;
  } catch {
    return null;
  }
}

export async function previewAdminInactiveBlock(days: number): Promise<{
  ok: boolean;
  days: number;
  inactiveCount: number;
  cutoffMs: number;
  error?: string;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/inactive-block/preview?days=${encodeURIComponent(String(days))}`);
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as { ok: boolean; days: number; inactiveCount: number; cutoffMs: number; error?: string };
  } catch {
    return null;
  }
}

export async function applyAdminInactiveBlock(days: number): Promise<{
  ok: boolean;
  blockedCount?: number;
  error?: string;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/inactive-block/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days })
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as { ok: boolean; blockedCount?: number; error?: string };
  } catch {
    return null;
  }
}

export async function previewAdminForcePasswordReset(): Promise<{
  ok: boolean;
  targetCount: number;
  error?: string;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/force-password-reset/preview`);
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as { ok: boolean; targetCount: number; error?: string };
  } catch {
    return null;
  }
}

export async function applyAdminForcePasswordReset(): Promise<{
  ok: boolean;
  resetCount?: number;
  message?: string;
  error?: string;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/security/force-password-reset/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'REDEFINIR' })
    });
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    return raw as { ok: boolean; resetCount?: number; message?: string; error?: string };
  } catch {
    return null;
  }
}

export async function getAdminDeviceFingerprints(opts?: {
  limit?: number;
  offset?: number;
  eventType?: 'login' | 'register' | '';
  userId?: number;
  q?: string;
}): Promise<{ rows: AdminDeviceFingerprintLog[]; total: number; limit: number; offset: number } | null> {
  try {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    if (opts?.offset != null) qs.set('offset', String(opts.offset));
    if (opts?.eventType) qs.set('eventType', opts.eventType);
    if (opts?.userId != null && Number.isFinite(opts.userId)) qs.set('userId', String(opts.userId));
    if (opts?.q && opts.q.trim()) qs.set('q', opts.q.trim());
    const res = await apiFetch(`${base}/admin/device-fingerprints?${qs.toString()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function addToBlacklist(ip: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/security/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, reason })
    });
    return await res.json();
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function removeFromBlacklist(ip: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/security/blacklist/${encodeURIComponent(ip)}`, {
      method: 'DELETE'
    });
    return await res.json();
  } catch { return { ok: false, error: 'Network error' }; }
}

export type AdminInventoryAuditRow = {
  id: string;
  createdAtMs: number;
  action: string;
  catalogItemId: string | null;
  itemName: string | null;
  instanceId: string | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  delta: number | null;
  source: string;
  summary: string;
};

export type AdminSessionSnapshotEntry = {
  id: string;
  action: string;
  createdAt: number;
  snapshot: Record<string, unknown>;
  display?: import('../types').ActivityEventDisplay;
};

export async function getAdminUserActivity(
  email: string,
  opts?: {
    userId?: number;
    limit?: number;
    beforeMs?: number;
    filterId?: string;
    search?: string;
    category?: string;
    severity?: string;
  }
): Promise<{
  logs: GameUserActivityEntry[];
  error?: string;
  activityLogNote?: string;
  accountCreatedAtMs?: number | null;
  hasMore?: boolean;
  nextCursor?: number | null;
}> {
  const q = new URLSearchParams();
  const uid = opts?.userId;
  if (uid != null && Number.isFinite(uid) && uid > 0) {
    q.set('userId', String(Math.floor(uid)));
  } else {
    const em = email.trim().toLowerCase();
    if (!em) return { logs: [], error: 'Indique o email ou username do jogador.' };
    q.set('email', em);
  }
  if (opts?.limit != null && opts.limit > 0) q.set('limit', String(Math.min(100, opts.limit)));
  if (opts?.beforeMs != null && opts.beforeMs > 0) q.set('beforeMs', String(Math.floor(opts.beforeMs)));
  if (opts?.filterId) q.set('filterId', opts.filterId);
  if (opts?.search) q.set('search', opts.search);
  if (opts?.category) q.set('category', opts.category);
  if (opts?.severity) q.set('severity', opts.severity);
  try {
    const res = await apiFetch(`${base}/admin/user-activity?${q.toString()}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch { /* ignore */ }
      return { logs: [], error: msg };
    }
    const data = (await res.json()) as {
      logs?: GameUserActivityEntry[];
      activityLogNote?: string;
      accountCreatedAtMs?: number | null;
      hasMore?: boolean;
      nextCursor?: number | null;
    };
    const note = typeof data.activityLogNote === 'string' ? data.activityLogNote : undefined;
    const rawMs = data.accountCreatedAtMs;
    const accountCreatedAtMs =
      typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0 ? Math.floor(rawMs) : null;
    return {
      logs: Array.isArray(data.logs) ? data.logs : [],
      hasMore: !!data.hasMore,
      nextCursor: data.nextCursor ?? null,
      ...(note ? { activityLogNote: note } : {}),
      accountCreatedAtMs
    };
  } catch {
    return { logs: [], error: 'Erro de rede.' };
  }
}

export async function getAdminUserInventoryAudit(
  userId: number,
  opts?: { page?: number; limit?: number; fromMs?: number; toMs?: number; lossesOnly?: boolean }
): Promise<{ total: number; page: number; limit: number; rows: AdminInventoryAuditRow[] } | null> {
  const q = new URLSearchParams();
  if (opts?.page) q.set('page', String(opts.page));
  if (opts?.limit) q.set('limit', String(opts.limit));
  if (opts?.fromMs) q.set('from', String(opts.fromMs));
  if (opts?.toMs) q.set('to', String(opts.toMs));
  if (opts?.lossesOnly) q.set('lossesOnly', 'true');
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/inventory-audit?${q}`);
    if (!res.ok) return null;
    return (await res.json()) as { total: number; page: number; limit: number; rows: AdminInventoryAuditRow[] };
  } catch {
    return null;
  }
}

export async function getAdminUserSessionSnapshots(
  userId: number,
  limit = 20
): Promise<{
  snapshots: AdminSessionSnapshotEntry[];
  diffs: Array<{
    snapshotId: string;
    createdAt: number;
    fingerprintChanged: boolean;
    inventoryDiff: Array<{ itemId: string; before: number; after: number; delta: number }>;
  }>;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/session-snapshots?limit=${limit}`);
    if (!res.ok) return null;
    return (await res.json()) as {
      snapshots: AdminSessionSnapshotEntry[];
      diffs: Array<{
        snapshotId: string;
        createdAt: number;
        fingerprintChanged: boolean;
        inventoryDiff: Array<{ itemId: string; before: number; after: number; delta: number }>;
      }>;
    };
  } catch {
    return null;
  }
}

export type AdminAccountTraceSummary = {
  userId: number;
  username: string;
  email: string;
  accountCreatedAtMs: number | null;
  lastSaveAtMs: number | null;
  usdc: number;
  blackMarketBalance: number;
  totalUsdcDeposited: number | null;
  totalCryptoWithdrawn: number | null;
  totalHash: number;
};

export type AdminAccountTraceItemDisposition = {
  itemId: string;
  itemName: string;
  acquired: number;
  inStock: number;
  onRigs: Array<{ rackId: string; slotIndex: number; roomId: string | null }>;
  listedP2p: number;
  soldP2p: number;
  unaccounted: number;
  hint: string;
};

export type AdminAccountTraceTimelineEvent = {
  id: string;
  atMs: number;
  source: string;
  kind: string;
  action: string;
  title: string;
  summary: string;
  lines?: string[];
  severity: string;
  category: string;
  meta?: Record<string, unknown>;
};

export type AdminAccountTraceResponse = {
  summary: AdminAccountTraceSummary;
  currentInventory: Array<{ itemId: string; itemName: string; qty: number }>;
  currentRigs: Array<{
    rackId: string;
    chassisId: string;
    chassisName: string;
    roomId: string | null;
    slotIndex: number | null;
    miners: Array<{ slotIndex: number; itemId: string; itemName: string }>;
  }>;
  currentMarket: Array<{
    listingId: string;
    itemId: string;
    itemName: string;
    qty: number;
    price: number;
    status: string;
    expiresAtMs: number | null;
    reservedBy: number | null;
  }>;
  p2p: {
    sold: Array<{
      id: string;
      atMs: number;
      role: string;
      itemId: string;
      itemName: string;
      qty: number;
      unitPrice: number;
      totalUsdc: number;
      counterpartyUserId: number;
    }>;
    bought: Array<{
      id: string;
      atMs: number;
      role: string;
      itemId: string;
      itemName: string;
      qty: number;
      unitPrice: number;
      totalUsdc: number;
      counterpartyUserId: number;
    }>;
    activeListings: AdminAccountTraceResponse['currentMarket'];
  };
  shopPurchases: Array<{
    atMs: number;
    totalCost: number;
    newUsdc: number;
    lines: Array<{ id: string; qty: number; name?: string }>;
  }>;
  boxOpenings: Array<{ id: string; atMs: number; boxId: string; rewards: unknown; gainedUsdc: number }>;
  itemDisposition: AdminAccountTraceItemDisposition[];
  timeline: AdminAccountTraceTimelineEvent[];
  timelineHasMore: boolean;
  timelineNextCursor: number | null;
};

export async function getAdminUserAccountTrace(
  userId: number,
  opts?: {
    fromMs?: number;
    toMs?: number;
    timelineLimit?: number;
    timelineBeforeMs?: number;
  }
): Promise<{ data: AdminAccountTraceResponse | null; error?: string }> {
  const q = new URLSearchParams();
  if (opts?.fromMs) q.set('fromMs', String(opts.fromMs));
  if (opts?.toMs) q.set('toMs', String(opts.toMs));
  if (opts?.timelineLimit) q.set('timelineLimit', String(opts.timelineLimit));
  if (opts?.timelineBeforeMs) q.set('timelineBeforeMs', String(opts.timelineBeforeMs));
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/account-trace?${q}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return { data: null, error: msg };
    }
    return { data: (await res.json()) as AdminAccountTraceResponse };
  } catch {
    return { data: null, error: 'Erro de rede.' };
  }
}

export type AdminDormantMiningRow = {
  id: number;
  username: string;
  email: string;
  polygonWallet: string | null;
  startTimeMs: string | null;
  lastActiveAt: string | null;
  rankingExcluded: boolean;
};

export type AdminDormantMiningReport = {
  daysMin: number;
  cutoffMs: string;
  limit: number;
  limitEach: number;
  noMiningPage: number;
  miningNoWalletPage: number;
  noMiningTotal: number;
  miningNoWalletTotal: number;
  note: string;
  noMining: AdminDormantMiningRow[];
  miningNoWallet: AdminDormantMiningRow[];
  error?: string;
};

/** GET /api/admin/accounts-dormant-mining — contas antigas sem mineração activa ou a minerar sem carteira. */
export async function getAdminDormantMiningAccounts(opts?: {
  daysMin?: number;
  limit?: number;
  noMiningPage?: number;
  miningNoWalletPage?: number;
}): Promise<AdminDormantMiningReport> {
  const empty: AdminDormantMiningReport = {
    daysMin: 30,
    cutoffMs: '',
    limit: 500,
    limitEach: 500,
    noMiningPage: 1,
    miningNoWalletPage: 1,
    noMiningTotal: 0,
    miningNoWalletTotal: 0,
    note: '',
    noMining: [],
    miningNoWallet: []
  };
  const q = new URLSearchParams();
  if (opts?.daysMin != null && opts.daysMin >= 30) q.set('daysMin', String(Math.min(365, Math.floor(opts.daysMin))));
  if (opts?.limit != null && opts.limit > 0) q.set('limit', String(Math.min(500, Math.max(50, Math.floor(opts.limit)))));
  if (opts?.noMiningPage != null && opts.noMiningPage >= 1) q.set('noMiningPage', String(Math.floor(opts.noMiningPage)));
  if (opts?.miningNoWalletPage != null && opts.miningNoWalletPage >= 1) {
    q.set('miningNoWalletPage', String(Math.floor(opts.miningNoWalletPage)));
  }
  const qs = q.toString();
  try {
    const res = await apiFetch(`${base}/admin/accounts-dormant-mining${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return { ...empty, error: msg };
    }
    const data = (await res.json()) as Partial<AdminDormantMiningReport>;
    const lim = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : data.limitEach ?? 500;
    const limN = Math.min(500, Math.max(50, typeof lim === 'number' ? lim : 500));
    return {
      daysMin: typeof data.daysMin === 'number' && Number.isFinite(data.daysMin) ? data.daysMin : 30,
      cutoffMs: typeof data.cutoffMs === 'string' ? data.cutoffMs : '',
      limit: limN,
      limitEach: typeof data.limitEach === 'number' && Number.isFinite(data.limitEach) ? data.limitEach : limN,
      noMiningPage: typeof data.noMiningPage === 'number' && Number.isFinite(data.noMiningPage) ? data.noMiningPage : 1,
      miningNoWalletPage:
        typeof data.miningNoWalletPage === 'number' && Number.isFinite(data.miningNoWalletPage) ? data.miningNoWalletPage : 1,
      noMiningTotal: typeof data.noMiningTotal === 'number' && Number.isFinite(data.noMiningTotal) ? data.noMiningTotal : 0,
      miningNoWalletTotal:
        typeof data.miningNoWalletTotal === 'number' && Number.isFinite(data.miningNoWalletTotal) ? data.miningNoWalletTotal : 0,
      note: typeof data.note === 'string' ? data.note : '',
      noMining: parseJsonArray<AdminDormantMiningRow>(data.noMining),
      miningNoWallet: parseJsonArray<AdminDormantMiningRow>(data.miningNoWallet)
    };
  } catch {
    return { ...empty, error: 'Erro de rede.' };
  }
}

export type AdminSuspiciousEmailReason = string;

export type AdminSuspiciousEmailReferrer = {
  id: number | null;
  username: string | null;
  email: string | null;
};

export type AdminSuspiciousEmailUserRow = {
  id: number;
  username: string;
  email: string;
  emailDomain: string | null;
  status: 'active' | 'blocked';
  accessLevel: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  walletAddress: string | null;
  emailVerified: boolean | null;
  totalHash: number;
  totalMinedUsd: number;
  totalDepositedUsdc: number;
  hasMinedFlag: boolean;
  referrer: AdminSuspiciousEmailReferrer | null;
  riskScore: number;
  riskLevel: 'minimal' | 'low' | 'medium' | 'high';
  reasons: AdminSuspiciousEmailReason[];
};

export type AdminSuspiciousEmailsReport = {
  ok: boolean;
  summary: {
    totalSuspicious: number;
    domainNotTrusted: number;
    invalidFormat: number;
    temporaryDomains: number;
    fakePatterns: number;
    duplicates: number;
    unverified: number;
    suspiciousDomain: number;
    deadAccounts: number;
    referralOnly: number;
    highRisk: number;
    totalActiveFiltered?: number;
  };
  trustedDomains?: string[];
  domainStats: Array<{ domain: string; count: number; reason: string }>;
  users: AdminSuspiciousEmailUserRow[];
  pagination: { page: number; limit: number; total: number };
  meta?: { note?: string; unverifiedEmailSupported?: boolean };
  error?: string;
};

/** GET /api/admin/users/suspicious-emails — leitura; requer permissão admin (aba users). */
export async function getAdminSuspiciousEmails(opts?: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  page?: number;
  limit?: number;
  sort?: string;
}): Promise<AdminSuspiciousEmailsReport> {
  const emptySummary = {
    totalSuspicious: 0,
    domainNotTrusted: 0,
    invalidFormat: 0,
    temporaryDomains: 0,
    fakePatterns: 0,
    duplicates: 0,
    unverified: 0,
    suspiciousDomain: 0,
    deadAccounts: 0,
    referralOnly: 0,
    highRisk: 0,
    totalActiveFiltered: 0,
  };
  const q = new URLSearchParams();
  if (opts?.q) q.set('q', opts.q.slice(0, 200));
  if (opts?.reason) q.set('reason', opts.reason);
  if (opts?.status) q.set('status', opts.status);
  if (opts?.domain) q.set('domain', opts.domain.slice(0, 200));
  if (opts?.activity) q.set('activity', opts.activity);
  if (opts?.page != null && opts.page >= 1) q.set('page', String(Math.floor(opts.page)));
  if (opts?.limit != null && opts.limit >= 1) q.set('limit', String(Math.min(100, Math.floor(opts.limit))));
  if (opts?.sort) q.set('sort', opts.sort);
  const qs = q.toString();
  try {
    const res = await apiFetch(`${base}/admin/users/suspicious-emails${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        summary: emptySummary,
        domainStats: [],
        users: [],
        pagination: { page: 1, limit: 50, total: 0 },
        error: msg,
      };
    }
    const data = (await res.json()) as Partial<AdminSuspiciousEmailsReport>;
    return {
      ok: data.ok !== false,
      summary: {
        totalSuspicious: data.summary?.totalSuspicious ?? 0,
        domainNotTrusted: data.summary?.domainNotTrusted ?? 0,
        invalidFormat: data.summary?.invalidFormat ?? 0,
        temporaryDomains: data.summary?.temporaryDomains ?? 0,
        fakePatterns: data.summary?.fakePatterns ?? 0,
        duplicates: data.summary?.duplicates ?? 0,
        unverified: data.summary?.unverified ?? 0,
        suspiciousDomain: data.summary?.suspiciousDomain ?? 0,
        deadAccounts: data.summary?.deadAccounts ?? 0,
        referralOnly: data.summary?.referralOnly ?? 0,
        highRisk: data.summary?.highRisk ?? 0,
      },
      trustedDomains: Array.isArray(data.trustedDomains) ? data.trustedDomains : undefined,
      domainStats: parseJsonArray(data.domainStats as unknown[]),
      users: parseJsonArray<AdminSuspiciousEmailUserRow>(data.users as unknown[]),
      pagination: {
        page: data.pagination?.page ?? 1,
        limit: data.pagination?.limit ?? 50,
        total: data.pagination?.total ?? 0,
      },
      meta: data.meta,
    };
  } catch {
    return {
      ok: false,
      summary: emptySummary,
      domainStats: [],
      users: [],
      pagination: { page: 1, limit: 50, total: 0 },
      error: 'Erro de rede.',
    };
  }
}

export function getAdminSuspiciousEmailsExportUrl(opts?: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  sort?: string;
}): string {
  const q = new URLSearchParams();
  if (opts?.q) q.set('q', opts.q.slice(0, 200));
  if (opts?.reason) q.set('reason', opts.reason);
  if (opts?.status) q.set('status', opts.status);
  if (opts?.domain) q.set('domain', opts.domain.slice(0, 200));
  if (opts?.activity) q.set('activity', opts.activity);
  if (opts?.sort) q.set('sort', opts.sort);
  const qs = q.toString();
  return `${base}/admin/users/suspicious-emails/export.csv${qs ? `?${qs}` : ''}`;
}

export async function postAdminDeactivateFilteredSuspiciousUsers(opts: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  expectedCount: number;
}): Promise<{
  ok: boolean;
  deactivated?: number;
  alreadyBlocked?: number;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`${base}/admin/users/suspicious-emails/deactivate-filtered`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: opts.q,
        reason: opts.reason,
        status: opts.status,
        domain: opts.domain,
        activity: opts.activity,
        expectedCount: Math.floor(Number(opts.expectedCount) || 0),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Erro ${res.status}`,
        code: typeof data.code === 'string' ? data.code : undefined,
      };
    }
    return {
      ok: true,
      deactivated: typeof data.deactivated === 'number' ? data.deactivated : undefined,
      alreadyBlocked: typeof data.alreadyBlocked === 'number' ? data.alreadyBlocked : undefined,
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function setMonetizationSettings(settings: MonetizationSettings): Promise<void> {
  const res = await apiFetch(`${base}/monetization-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Erro ao salvar monetização: ${res.status}`);
  }
}
export async function getServerTime(): Promise<{ serverTime: number }> {
  try {
    const res = await apiFetch(`${base}/system/time`);
    if (!res.ok) return { serverTime: Date.now() };
    return await res.json();
  } catch {
    return { serverTime: Date.now() };
  }
}

export async function getEconomySettings(): Promise<EconomySettings | null> {
  try {
    const res = await apiFetch(`${base}/economy-settings?t=${Date.now()}`);
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  } catch {
    return null;
  }
}

export async function setEconomySettings(settings: EconomySettings): Promise<void> {
  const res = await apiFetch(`${base}/economy-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Erro ao salvar economia: ${res.status}`);
  }
}

export async function getAdminMarketListings(): Promise<unknown[]> { // Using any for brevity, or define AdminListing interface
  try {
    const res = await apiFetch(`${base}/admin/market/listings`);
    if (!res.ok) return [];
    try { return await res.json(); } catch { return []; }
  } catch { return []; }
}

export async function impersonateUser(targetEmail: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/impersonate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetEmail }) });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Impersonation failed' }; }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function updateAdminPermissions(
  email: string,
  isAdmin: boolean,
  permissions: string[],
  isSuperAdmin?: boolean
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = { email, isAdmin, permissions };
    if (isSuperAdmin !== undefined) body.isSuperAdmin = !!isSuperAdmin;
    const res = await apiFetch(`${base}/admin/update-permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function stopImpersonate(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/stop-impersonate`, { method: 'POST' });
    if (!res.ok) {
      try { return await res.json(); } catch { return { ok: false, error: 'Stop impersonation failed' }; }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type MergeInventoryItem = {
  itemId: string;
  qty: number;
  name: string;
  type: 'machine' | 'multiplier' | 'infrastructure';
  rarity: string;
  resultRarity: string | null;
  baseCost: number;
  baseProduction: number;
  powerConsumption: number | null;
  multiplier: number | null;
  image: string | null;
  icon: string;
  feeUsdc: number;
  maxMerges?: number;
  canMerge: boolean;
  blockReason: string | null;
  preview: {
    resultRarity: string;
    name: string;
    baseCost: number;
    baseProduction: number;
    powerConsumption: number | null;
    multiplier: number | null;
    feeUsdc: number;
    costPct: number;
    gainPercent: number;
  } | null;
};

export type MergeAdminSettings = {
  enabled: boolean;
  enabledMachine: boolean;
  enabledMultiplier: boolean;
  enabledInfrastructure: boolean;
  gainPercent: number;
  costPctByRarity: {
    common: number;
    uncommon: number;
    rare: number;
    epic: number;
    legendary: number;
  };
  rackHsBonusPctByRarity: {
    common: number;
    uncommon: number;
    rare: number;
    epic: number;
    legendary: number;
    supreme: number;
  };
};

export type MergePublicConfig = {
  enabled: boolean;
  enabledByType: {
    machine: boolean;
    multiplier: boolean;
    infrastructure: boolean;
  };
  allowedTypes: Array<'machine' | 'multiplier' | 'infrastructure'>;
};

function parseMergeAdminSettings(
  data: Record<string, unknown>,
  fallback?: MergeAdminSettings
): MergeAdminSettings {
  return {
    enabled: data.enabled !== false,
    enabledMachine: data.enabledMachine !== false,
    enabledMultiplier: data.enabledMultiplier !== false,
    enabledInfrastructure: data.enabledInfrastructure !== false,
    gainPercent: Number(data.gainPercent) || fallback?.gainPercent || 5,
    costPctByRarity: (data.costPctByRarity as MergeAdminSettings['costPctByRarity']) ||
      fallback?.costPctByRarity || {
        common: 10,
        uncommon: 15,
        rare: 20,
        epic: 25,
        legendary: 30
      },
    rackHsBonusPctByRarity:
      (data.rackHsBonusPctByRarity as MergeAdminSettings['rackHsBonusPctByRarity']) ||
      fallback?.rackHsBonusPctByRarity || {
        common: 0,
        uncommon: 0,
        rare: 0,
        epic: 0,
        legendary: 0,
        supreme: 0
      }
  };
}

export async function getMergeConfig(): Promise<{ ok: boolean; config?: MergePublicConfig; error?: string }> {
  try {
    const res = await apiFetch(`${base}/merge/config`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    const rawByType = (data.enabledByType as Record<string, unknown> | undefined) || {};
    const allowedRaw = Array.isArray(data.allowedTypes) ? data.allowedTypes : [];
    const allowedTypes = allowedRaw.filter(
      (t): t is 'machine' | 'multiplier' | 'infrastructure' =>
        t === 'machine' || t === 'multiplier' || t === 'infrastructure'
    );
    return {
      ok: true,
      config: {
        enabled: data.enabled !== false,
        enabledByType: {
          machine: rawByType.machine !== false,
          multiplier: rawByType.multiplier !== false,
          infrastructure: rawByType.infrastructure !== false
        },
        allowedTypes
      }
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getMergeInventory(): Promise<{ ok: boolean; items?: MergeInventoryItem[]; error?: string }> {
  try {
    const res = await apiFetch(`${base}/merge/inventory`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      items?: MergeInventoryItem[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type MergeHistorySummaryRow = {
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  mergeCount: number;
  feeTotalUsdc: number;
  lastAt: number;
};

export type MergeHistoryEntry = {
  id: string;
  sourceItemId: string;
  sourceName: string;
  sourceRarity: string;
  resultItemId: string;
  resultName: string;
  resultRarity: string;
  type: string | null;
  icon: string;
  image: string | null;
  feeUsdc: number;
  createdAt: number;
};

export async function getMergeHistory(limit = 40): Promise<{
  ok: boolean;
  totalMerges?: number;
  feeTotalUsdc?: number;
  summary?: MergeHistorySummaryRow[];
  recent?: MergeHistoryEntry[];
  error?: string;
}> {
  try {
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
    const res = await apiFetch(`${base}/merge/history?limit=${n}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      };
    }
    return {
      ok: true,
      totalMerges: typeof data.totalMerges === 'number' ? data.totalMerges : 0,
      feeTotalUsdc: typeof data.feeTotalUsdc === 'number' ? data.feeTotalUsdc : 0,
      summary: Array.isArray(data.summary) ? (data.summary as MergeHistorySummaryRow[]) : [],
      recent: Array.isArray(data.recent) ? (data.recent as MergeHistoryEntry[]) : []
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function postMergeExecute(
  itemId: string,
  count: number = 1
): Promise<{
  ok: boolean;
  error?: string;
  feeUsdc?: number;
  feeUnitUsdc?: number;
  count?: number;
  newUsdc?: number;
  resultItemId?: string;
  result?: { id: string; name: string; resultRarity: string };
}> {
  try {
    const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
    const res = await apiFetch(`${base}/merge/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, count: n })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      };
    }
    return {
      ok: true,
      feeUsdc: typeof data.feeUsdc === 'number' ? data.feeUsdc : undefined,
      feeUnitUsdc: typeof data.feeUnitUsdc === 'number' ? data.feeUnitUsdc : undefined,
      count: typeof data.count === 'number' ? data.count : n,
      newUsdc: typeof data.newUsdc === 'number' ? data.newUsdc : undefined,
      resultItemId: typeof data.resultItemId === 'string' ? data.resultItemId : undefined,
      result: data.result as { id: string; name: string; resultRarity: string } | undefined
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getAdminMergeSettings(): Promise<{ ok: boolean; settings?: MergeAdminSettings; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/merge/settings`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    return {
      ok: true,
      settings: parseMergeAdminSettings(data)
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function putAdminMergeSettings(
  settings: MergeAdminSettings
): Promise<{ ok: boolean; error?: string; settings?: MergeAdminSettings }> {
  try {
    const res = await apiFetch(`${base}/admin/merge/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    return {
      ok: true,
      settings: parseMergeAdminSettings(data, settings)
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function openLootBox(email: string, boxId: string): Promise<{ ok: boolean; rewards?: unknown[]; error?: string }> {
  try {
    const res = await apiFetch(`${base}/loot-boxes/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxId, email })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; rewards?: unknown[]; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error || `Erro HTTP ${res.status}` };
    }
    return { ok: !!data.ok, rewards: data.rewards };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function buyLootBox(
  email: string,
  boxId: string
): Promise<{ ok: boolean; error?: string; newUsdc?: number; missing?: number }> {
  try {
    const res = await apiFetch(`${base}/loot-boxes/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxId, email })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      newUsdc?: number;
      missing?: number;
    };
    if (!res.ok) {
      const missing =
        typeof data.missing === 'number' && Number.isFinite(data.missing) && data.missing > 0
          ? data.missing
          : undefined;
      return { ok: false, error: data.error || `Erro HTTP ${res.status}`, missing };
    }
    return { ok: !!data.ok, newUsdc: data.newUsdc };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Descarta caixas não abertas (sem prémio). `qty` omitido = todas as unidades desse `boxId`. */
/** Estado consolidado Caixas da Sorte (`GET /api/lucky-boxes/state`). */
export type LuckyBoxRewardSlotPublic = {
  kind: string;
  label: string;
  rangeText: string;
  /** Chance de drop (0–100), ex.: `100%`. */
  chanceText?: string;
};
export type LuckyBoxShopEntryV1 = {
  id: string;
  name: string;
  description: string;
  icon: string;
  priceUsdc: number;
  currency: 'USDC';
  trigger: string;
  maxPerOrder: number;
  stockRemaining: number | null;
  rewardSummary: { slotCount: number; slots: LuckyBoxRewardSlotPublic[] };
};
export type LuckyBoxInventoryEntryV1 = {
  boxId: string;
  qty: number;
  name: string;
  description: string;
  icon: string;
  trigger: string;
  openableHere: boolean;
  rewardSummary: { slotCount: number; slots: LuckyBoxRewardSlotPublic[] };
};
export type LuckyBoxesStateV1 = {
  version: 1;
  usdc: number;
  banner: { text: string; variant: 'info' | 'warning' } | null;
  promoHelp: string;
  roulettePromoNote: string;
  shop: LuckyBoxShopEntryV1[];
  shopEmptyMessage: string;
  inventory: LuckyBoxInventoryEntryV1[];
  history: { items: unknown[]; limit: number; nextCursor: string | null };
};

export async function getLuckyBoxesState(): Promise<
  LuckyBoxesStateV1 | { ok: false; status: number; error?: string }
> {
  try {
    const res = await apiFetch(`${base}/lucky-boxes/state?t=${Date.now()}`);
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j?.error === 'string') error = j.error;
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    if (raw.version !== 1) return { ok: false, status: 502, error: 'Resposta inválida.' };
    return raw as unknown as LuckyBoxesStateV1;
  } catch {
    return { ok: false, status: 500, error: 'Erro de rede.' };
  }
}

export async function postLuckyBoxPurchase(body: {
  boxId: string;
  email?: string;
  quantity?: number;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; newUsdc?: number; qtyPurchased?: number; error?: string; missing?: number }> {
  try {
    const payload: Record<string, unknown> = { boxId: body.boxId };
    if (body.email) payload.email = body.email;
    if (body.quantity != null && Number.isFinite(body.quantity) && body.quantity >= 1) {
      payload.quantity = Math.floor(body.quantity);
    }
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      newUsdc?: number;
      qtyPurchased?: number;
      missing?: number;
    };
    if (!res.ok) {
      const missing =
        typeof data.missing === 'number' && Number.isFinite(data.missing) && data.missing > 0
          ? data.missing
          : undefined;
      return { ok: false, error: data.error || `Erro HTTP ${res.status}`, missing };
    }
    return { ok: !!data.ok, newUsdc: data.newUsdc, qtyPurchased: data.qtyPurchased };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Alinhar com nginx 300s em /api/lucky-boxes/ */
const LUCKY_BOX_OPEN_FETCH_MS = 300_000;

export async function postLuckyBoxOpen(body: {
  boxId: string;
  email?: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; rewards?: unknown[]; openingId?: string; error?: string }> {
  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), LUCKY_BOX_OPEN_FETCH_MS);
  try {
    const payload: Record<string, unknown> = { boxId: body.boxId };
    if (body.email) payload.email = body.email;
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      rewards?: unknown[];
      openingId?: string;
      error?: string;
    };
    if (!res.ok) {
      if (res.status === 524 || res.status === 504) {
        return {
          ok: false,
          error:
            'Timeout (Cloudflare ou servidor) ao abrir a caixa. Na Cloudflare aumenta o tempo da origem; no nginx mantém proxy_read_timeout alto em /api/lucky-boxes/. Recarrega e verifica o inventário antes de repetir.'
        };
      }
      return { ok: false, error: data.error || `Erro HTTP ${res.status}` };
    }
    return { ok: !!data.ok, rewards: data.rewards, openingId: data.openingId };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        error:
          'Sem resposta do servidor após vários minutos ao abrir a caixa. Recarrega e verifica o inventário — a abertura pode ter ficado registada (idempotência). Se repetir, verifica timeouts Cloudflare/nginx e a base de dados.'
      };
    }
    return { ok: false, error: 'Network error' };
  } finally {
    clearTimeout(kill);
  }
}

export async function redeemLuckyBoxPromoCode(body: {
  code: string;
  idempotencyKey?: string;
}): Promise<{
  ok: boolean;
  type?: 'roleta' | 'standard';
  code?: string;
  unopenedBoxes?: Record<string, number>;
  stock?: Record<string, number>;
  lootBoxId?: string | null;
  error?: string;
}> {
  try {
    const payload: Record<string, unknown> = { code: body.code.trim() };
    if (body.idempotencyKey?.trim()) payload.idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    const res = await apiFetch(`${base}/lucky-boxes/promocodes/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `Erro HTTP ${res.status}` };
    if (data.type === 'roleta') {
      return { ok: true, type: 'roleta', code: typeof data.code === 'string' ? data.code : undefined };
    }
    return {
      ok: true,
      type: 'standard',
      unopenedBoxes: data.unopenedBoxes as Record<string, number> | undefined,
      stock: data.stock as Record<string, number> | undefined,
      lootBoxId: (data.lootBoxId as string | null | undefined) ?? null
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function discardLootBox(
  email: string,
  boxId: string,
  qty?: number
): Promise<{ ok: boolean; error?: string; discardedQty?: number; remainingQty?: number }> {
  try {
    const body: Record<string, unknown> = { boxId, email };
    if (qty !== undefined && Number.isFinite(qty) && qty > 0) body.qty = qty;
    const res = await apiFetch(`${base}/loot-boxes/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      discardedQty?: number;
      remainingQty?: number;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || 'Erro ao descartar.' };
    }
    return {
      ok: !!data.ok,
      discardedQty: data.discardedQty,
      remainingQty: data.remainingQty,
      error: data.error
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function buyUpgrades(
  email: string,
  cart: Record<string, number>
): Promise<{ ok: boolean; newUsdc?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/upgrades/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; newUsdc?: number; error?: string };
    if (!res.ok) {
      return { ok: false, error: data.error || `Erro HTTP ${res.status}` };
    }
    return { ok: true, newUsdc: data.newUsdc };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
export async function getAdminDashboardStats(): Promise<unknown> {
  try {
    const res = await apiFetch(`${base}/admin/dashboard-stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function toggleRankingExclusion(email: string, excluded: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/ranking-exclusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, excluded })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getLeaderboard(): Promise<{ username: string; power: number }[]> {
  try {
    const res = await apiFetch(`${base}/leaderboard`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function recallScan(): Promise<{ ok: boolean, summary?: unknown[], totalUsersChecked?: number, error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/recall-scan`);
    if (!res.ok) {
      const err = await res.json();
      return { ok: false, error: err.error };
    }
    return await res.json();
  } catch (e: unknown) {
    return { ok: false, error: e.message };
  }
}

export async function recallAllPlayersItems(): Promise<{ ok: boolean, error?: string, report?: unknown }> {
  try {
    const res = await apiFetch(`${base}/admin/recall-all-players-items`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      return { ok: false, error: err.error };
    }
    return await res.json();
  } catch (e: unknown) {
    return { ok: false, error: e.message };
  }
}

export async function getWalletLabels(): Promise<{ address: string; label: string }[]> {
  try {
    const res = await apiFetch(`${base}/wallet-labels`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

export async function saveWalletLabel(address: string, label: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/wallet-labels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, label }) });
    if (!res.ok) return { ok: false, error: 'Failed' };
    return { ok: true };
  } catch { return { ok: false, error: 'Network error' }; }
}



// RECOVERY
export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, message: data.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Erro de rede' };
  }
}

export async function verifyRecoveryWallet(email: string, walletAddress: string): Promise<{ ok: boolean; resetToken?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/verify-recovery-wallet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, walletAddress }) });
    return await res.json();
  } catch { return { ok: false, error: 'Network Error' }; }
}

export async function resetPasswordSecure(resetToken: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/reset-password-secure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resetToken, newPassword }) });
    return await res.json();
  } catch { return { ok: false, error: 'Network Error' }; }
}


export async function getAdminRanking(): Promise<unknown> {
  try {
    const res = await apiFetch(`${base}/admin/ranking`);
    if (!res.ok) throw new Error('Failed to fetch');
    return await res.json();
  } catch {
    throw new Error('Network Error');
  }
}

export async function getPublicRanking(): Promise<unknown> {
  try {
    const res = await apiFetch(`${base}/ranking/public`);
    if (!res.ok) throw new Error('Failed to fetch');
    return await res.json();
  } catch {
    throw new Error('Network Error');
  }
}

/** Posição do jogador no ranking global (H/s). `fresh` força recalcular (ignora cache). */
export async function getMyGlobalRanking(opts?: { fresh?: boolean }): Promise<{
  ok: boolean;
  position: number | null;
  totalRanked: number;
  hash: number;
  error?: string;
}> {
  try {
    const q = opts?.fresh ? '?fresh=1' : '';
    const res = await apiFetch(`${base}/ranking/me${q}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        position: null,
        totalRanked: 0,
        hash: 0,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      };
    }
    const position =
      typeof data.position === 'number' && Number.isFinite(data.position) && data.position > 0
        ? Math.floor(data.position)
        : null;
    const totalRanked =
      typeof data.totalRanked === 'number' && Number.isFinite(data.totalRanked)
        ? Math.max(0, Math.floor(data.totalRanked))
        : 0;
    const hash = typeof data.hash === 'number' && Number.isFinite(data.hash) ? data.hash : 0;
    return { ok: true, position, totalRanked, hash };
  } catch {
    return { ok: false, position: null, totalRanked: 0, hash: 0, error: 'Network error' };
  }
}

/** Player dashboard — canonical: `./dashboard`. */
export { getDashboardState } from './dashboard';

/** Resposta de GET /api/checkin/status e campos comuns ao POST /api/checkin */
export type CheckinStatusPayload = {
  today: string;
  timezone: string;
  lastCheckinDay: string | null;
  lastCheckinAtMs: number | null;
  streak: number;
  todayCheckedIn: boolean;
  canEarlyCheckin: boolean;
  frozen: boolean;
  nextResetMs: number;
  nextCheckinAtMs: number | null;
  windowRemainingMs: number;
  windowDurationMs: number;
  rewardCycleProgress: number;
  rewardCycleSize: number;
  premiumWeeklyCheckin: boolean;
  premiumIntervalDays: number;
  premiumMinUsdc: number;
  nextCheckinAllowedMs: number | null;
  canCheckinNow: boolean;
  checkinBonusHps: number;
  rewardType: 'hashrate' | 'battery' | 'item';
  rewardUnit: string;
  dailyRewardAmount: number;
  weeklyRewardAmount: number;
  streakRewardEnabled: boolean;
  streakRewardItemId: string;
  streakRewardDurationAmount: number;
  streakRewardDurationUnit: string;
  streakRewardDurationLabel: string | null;
};

export type CheckinPremiumPolicyPayload = {
  enabled: boolean;
  minUsdc: number;
  intervalDays: number;
};

export type CheckinRewardPolicyPayload = {
  rewardType: 'hashrate' | 'battery' | 'item';
  dailyRewardAmount: number;
  weeklyRewardAmount: number;
  rewardItemId: string;
  streakRewardEnabled: boolean;
  streakRewardItemId: string;
  streakRewardDurationAmount: number;
  streakRewardDurationUnit: 'day' | 'week' | 'month' | 'year';
};

export type CheckinPerformPayload = CheckinStatusPayload & {
  performed: boolean;
  rewardGranted: number;
  rewardType: 'hashrate' | 'battery' | 'item';
  rewardUnit: string;
  checkinBonusHps: number;
  streakReset: boolean;
  streakRewardGranted: number;
  streakRewardGrantedItemId: string | null;
  streakRewardGrantedItemName: string | null;
  streakRewardGrantedExpiresAtMs: number | null;
  streakRewardGrantedDurationLabel: string | null;
};

function parseCheckinStatusPayload(raw: Record<string, unknown>): CheckinStatusPayload | null {
  if (raw.ok !== true) return null;
  const today = typeof raw.today === 'string' ? raw.today : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const streak = typeof raw.streak === 'number' && Number.isFinite(raw.streak) ? Math.max(0, Math.floor(raw.streak)) : 0;
  const nextResetMs =
    typeof raw.nextResetMs === 'number' && Number.isFinite(raw.nextResetMs) ? raw.nextResetMs : Date.now();
  const lastCheckinAtMs =
    typeof raw.lastCheckinAtMs === 'number' && Number.isFinite(raw.lastCheckinAtMs) && raw.lastCheckinAtMs > 0
      ? Math.floor(raw.lastCheckinAtMs)
      : null;
  const windowDurationMs =
    typeof raw.windowDurationMs === 'number' && Number.isFinite(raw.windowDurationMs) && raw.windowDurationMs > 0
      ? Math.floor(raw.windowDurationMs)
      : 24 * 60 * 60 * 1000;
  const windowRemainingMs =
    typeof raw.windowRemainingMs === 'number' && Number.isFinite(raw.windowRemainingMs) && raw.windowRemainingMs >= 0
      ? Math.floor(raw.windowRemainingMs)
      : Math.max(0, nextResetMs - Date.now());
  return {
    today,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : 'UTC',
    lastCheckinDay: (() => {
      const v = raw.lastCheckinDay;
      if (v == null || v === '') return null;
      const s = String(v).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    })(),
    lastCheckinAtMs,
    streak,
    todayCheckedIn: raw.todayCheckedIn === true,
    canEarlyCheckin: raw.canEarlyCheckin === true,
    frozen: raw.frozen === true,
    nextResetMs,
    nextCheckinAtMs:
      typeof raw.nextCheckinAtMs === 'number' && Number.isFinite(raw.nextCheckinAtMs)
        ? Math.floor(raw.nextCheckinAtMs)
        : null,
    windowRemainingMs,
    windowDurationMs,
    rewardCycleProgress:
      typeof raw.rewardCycleProgress === 'number' && Number.isFinite(raw.rewardCycleProgress)
        ? Math.max(0, Math.floor(raw.rewardCycleProgress))
        : 0,
    rewardCycleSize:
      typeof raw.rewardCycleSize === 'number' && Number.isFinite(raw.rewardCycleSize)
        ? Math.max(1, Math.floor(raw.rewardCycleSize))
        : 7,
    premiumWeeklyCheckin: raw.premiumWeeklyCheckin === true,
    premiumIntervalDays:
      typeof raw.premiumIntervalDays === 'number' && Number.isFinite(raw.premiumIntervalDays)
        ? Math.max(1, Math.floor(raw.premiumIntervalDays))
        : 7,
    premiumMinUsdc:
      typeof raw.premiumMinUsdc === 'number' && Number.isFinite(raw.premiumMinUsdc)
        ? raw.premiumMinUsdc
        : 195,
    nextCheckinAllowedMs:
      typeof raw.nextCheckinAllowedMs === 'number' && Number.isFinite(raw.nextCheckinAllowedMs)
        ? Math.floor(raw.nextCheckinAllowedMs)
        : null,
    canCheckinNow: raw.canCheckinNow !== false,
    checkinBonusHps:
      typeof raw.checkinBonusHps === 'number' && Number.isFinite(raw.checkinBonusHps)
        ? Math.max(0, raw.checkinBonusHps)
        : 0,
    rewardType:
      raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
        ? raw.rewardType
        : 'hashrate',
    rewardUnit: typeof raw.rewardUnit === 'string' && raw.rewardUnit.trim() ? raw.rewardUnit.trim() : 'H/s',
    dailyRewardAmount:
      typeof raw.dailyRewardAmount === 'number' && Number.isFinite(raw.dailyRewardAmount)
        ? Math.max(0, raw.dailyRewardAmount)
        : 1,
    weeklyRewardAmount:
      typeof raw.weeklyRewardAmount === 'number' && Number.isFinite(raw.weeklyRewardAmount)
        ? Math.max(0, raw.weeklyRewardAmount)
        : 7,
    streakRewardEnabled: raw.streakRewardEnabled === true,
    streakRewardItemId:
      typeof raw.streakRewardItemId === 'string' ? raw.streakRewardItemId.trim() : '',
    streakRewardDurationAmount:
      typeof raw.streakRewardDurationAmount === 'number' && Number.isFinite(raw.streakRewardDurationAmount)
        ? Math.max(1, Math.floor(raw.streakRewardDurationAmount))
        : 7,
    streakRewardDurationUnit:
      raw.streakRewardDurationUnit === 'week' ||
      raw.streakRewardDurationUnit === 'month' ||
      raw.streakRewardDurationUnit === 'year'
        ? raw.streakRewardDurationUnit
        : 'day',
    streakRewardDurationLabel:
      typeof raw.streakRewardDurationLabel === 'string' && raw.streakRewardDurationLabel.trim()
        ? raw.streakRewardDurationLabel.trim()
        : null
  };
}

export async function getAdminCheckinPremiumPolicy(): Promise<CheckinPremiumPolicyPayload | null> {
  try {
    const res = await apiFetch(`${base}/admin/checkin-premium-policy`);
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || raw.ok !== true) return null;
    return {
      enabled: raw.enabled !== false && raw.enabled !== 0,
      minUsdc:
        typeof raw.minUsdc === 'number'
          ? raw.minUsdc
          : typeof raw.min_usdc === 'number'
            ? raw.min_usdc
            : 195,
      intervalDays:
        typeof raw.intervalDays === 'number'
          ? Math.max(1, Math.floor(raw.intervalDays))
          : typeof raw.interval_days === 'number'
            ? Math.max(1, Math.floor(raw.interval_days))
            : 7
    };
  } catch {
    return null;
  }
}

export async function setAdminCheckinPremiumPolicy(
  policy: CheckinPremiumPolicyPayload
): Promise<CheckinPremiumPolicyPayload | null> {
  try {
    const res = await apiFetch(`${base}/admin/checkin-premium-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy)
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || raw.ok !== true) return null;
    return {
      enabled: raw.enabled !== false && raw.enabled !== 0,
      minUsdc: typeof raw.minUsdc === 'number' ? raw.minUsdc : policy.minUsdc,
      intervalDays:
        typeof raw.intervalDays === 'number' ? Math.max(1, Math.floor(raw.intervalDays)) : policy.intervalDays
    };
  } catch {
    return null;
  }
}

export async function getAdminCheckinRewardPolicy(): Promise<CheckinRewardPolicyPayload | null> {
  try {
    const res = await apiFetch(`${base}/admin/checkin-reward-policy`);
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || raw.ok !== true) return null;
    const rewardType =
      raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
        ? raw.rewardType
        : 'hashrate';
    return {
      rewardType,
      dailyRewardAmount:
        typeof raw.dailyRewardAmount === 'number' && Number.isFinite(raw.dailyRewardAmount)
          ? Math.max(0, raw.dailyRewardAmount)
          : 1,
      weeklyRewardAmount:
        typeof raw.weeklyRewardAmount === 'number' && Number.isFinite(raw.weeklyRewardAmount)
          ? Math.max(0, raw.weeklyRewardAmount)
          : 7,
      rewardItemId:
        typeof raw.rewardItemId === 'string' && raw.rewardItemId.trim()
          ? raw.rewardItemId.trim()
          : 'battery_estelar',
      streakRewardEnabled: raw.streakRewardEnabled === true || raw.streakRewardEnabled === 1 || raw.streakRewardEnabled === '1',
      streakRewardItemId:
        typeof raw.streakRewardItemId === 'string' ? raw.streakRewardItemId.trim() : '',
      streakRewardDurationAmount:
        typeof raw.streakRewardDurationAmount === 'number' && Number.isFinite(raw.streakRewardDurationAmount)
          ? Math.max(1, Math.floor(raw.streakRewardDurationAmount))
          : 7,
      streakRewardDurationUnit:
        raw.streakRewardDurationUnit === 'week' ||
        raw.streakRewardDurationUnit === 'month' ||
        raw.streakRewardDurationUnit === 'year'
          ? raw.streakRewardDurationUnit
          : 'day'
    };
  } catch {
    return null;
  }
}

export async function setAdminCheckinRewardPolicy(
  policy: CheckinRewardPolicyPayload
): Promise<CheckinRewardPolicyPayload | null> {
  try {
    const res = await apiFetch(`${base}/admin/checkin-reward-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy)
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || raw.ok !== true) return null;
    const rewardType =
      raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
        ? raw.rewardType
        : policy.rewardType;
    return {
      rewardType,
      dailyRewardAmount:
        typeof raw.dailyRewardAmount === 'number' ? Math.max(0, raw.dailyRewardAmount) : policy.dailyRewardAmount,
      weeklyRewardAmount:
        typeof raw.weeklyRewardAmount === 'number'
          ? Math.max(0, raw.weeklyRewardAmount)
          : policy.weeklyRewardAmount,
      rewardItemId:
        typeof raw.rewardItemId === 'string' && raw.rewardItemId.trim()
          ? raw.rewardItemId.trim()
          : policy.rewardItemId,
      streakRewardEnabled:
        raw.streakRewardEnabled === true ||
        raw.streakRewardEnabled === 1 ||
        raw.streakRewardEnabled === '1' ||
        (raw.streakRewardEnabled == null && policy.streakRewardEnabled),
      streakRewardItemId:
        typeof raw.streakRewardItemId === 'string'
          ? raw.streakRewardItemId.trim()
          : policy.streakRewardItemId,
      streakRewardDurationAmount:
        typeof raw.streakRewardDurationAmount === 'number' && Number.isFinite(raw.streakRewardDurationAmount)
          ? Math.max(1, Math.floor(raw.streakRewardDurationAmount))
          : policy.streakRewardDurationAmount,
      streakRewardDurationUnit:
        raw.streakRewardDurationUnit === 'week' ||
        raw.streakRewardDurationUnit === 'month' ||
        raw.streakRewardDurationUnit === 'year' ||
        raw.streakRewardDurationUnit === 'day'
          ? raw.streakRewardDurationUnit
          : policy.streakRewardDurationUnit
    };
  } catch {
    return null;
  }
}

/** GET /api/checkin/status */
export async function getCheckinStatus(): Promise<{ ok: true; data: CheckinStatusPayload } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(`${base}/checkin/status`);
    if (res.status === 401) return { ok: false, error: 'Sessão expirada.' };
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'Erro ao ler check-in.';
      return { ok: false, error: err };
    }
    const data = parseCheckinStatusPayload(raw);
    if (!data) return { ok: false, error: 'Resposta inválida do servidor.' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao servidor.' };
  }
}

/** POST /api/checkin — idempotente no mesmo dia UTC (00:00→00:00) */
export async function postCheckin(): Promise<
  { ok: true; data: CheckinPerformPayload } | { ok: false; error: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (res.status === 401) return { ok: false, error: 'Sessão expirada.' };
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const err = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'Erro ao registar check-in.';
      return { ok: false, error: err, code };
    }
    const baseFields = parseCheckinStatusPayload(raw);
    if (!baseFields) return { ok: false, error: 'Resposta inválida do servidor.' };
    const data: CheckinPerformPayload = {
      ...baseFields,
      performed: raw.performed === true,
      rewardGranted:
        typeof raw.rewardGranted === 'number' && Number.isFinite(raw.rewardGranted)
          ? Math.max(0, raw.rewardGranted)
          : 0,
      rewardType:
        raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
          ? raw.rewardType
          : baseFields.rewardType,
      rewardUnit:
        typeof raw.rewardUnit === 'string' && raw.rewardUnit.trim()
          ? raw.rewardUnit.trim()
          : baseFields.rewardUnit,
      checkinBonusHps:
        typeof raw.checkinBonusHps === 'number' && Number.isFinite(raw.checkinBonusHps)
          ? Math.max(0, raw.checkinBonusHps)
          : baseFields.checkinBonusHps,
      streakReset: raw.streakReset === true,
      streakRewardGranted:
        typeof raw.streakRewardGranted === 'number' && Number.isFinite(raw.streakRewardGranted)
          ? Math.max(0, Math.floor(raw.streakRewardGranted))
          : 0,
      streakRewardGrantedItemId:
        typeof raw.streakRewardGrantedItemId === 'string' && raw.streakRewardGrantedItemId.trim()
          ? raw.streakRewardGrantedItemId.trim()
          : null,
      streakRewardGrantedItemName:
        typeof raw.streakRewardGrantedItemName === 'string' && raw.streakRewardGrantedItemName.trim()
          ? raw.streakRewardGrantedItemName.trim()
          : null,
      streakRewardGrantedExpiresAtMs:
        typeof raw.streakRewardGrantedExpiresAtMs === 'number' &&
        Number.isFinite(raw.streakRewardGrantedExpiresAtMs)
          ? Math.floor(raw.streakRewardGrantedExpiresAtMs)
          : null,
      streakRewardGrantedDurationLabel:
        typeof raw.streakRewardGrantedDurationLabel === 'string' &&
        raw.streakRewardGrantedDurationLabel.trim()
          ? raw.streakRewardGrantedDurationLabel.trim()
          : null
    };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao servidor.' };
  }
}

/** Admin economy stats — canonical: `./admin-economy`. */
export { getEconomyStats } from './admin-economy';

/** --- Tarefas diárias / semanais (quests) --- */
export type QuestStateItem = {
  id: string;
  period: 'daily' | 'weekly';
  actionType: 'checkin' | 'merge' | 'offerwall' | string;
  title: string;
  description: string;
  targetCount: number;
  rewardUsdc: number;
  sortOrder: number;
  periodKey: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  canClaim: boolean;
};

export type QuestPeriodBounds = {
  key: string;
  startMs: number;
  endMs: number;
};

export type QuestsStatePayload = {
  daily: QuestStateItem[];
  weekly: QuestStateItem[];
  dailyPeriodKey: string;
  weeklyPeriodKey: string;
  dailyPeriod: QuestPeriodBounds | null;
  weeklyPeriod: QuestPeriodBounds | null;
};

function parseQuestStateItem(raw: unknown): QuestStateItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  return {
    id,
    period: raw.period === 'weekly' ? 'weekly' : 'daily',
    actionType: typeof raw.actionType === 'string' ? raw.actionType : String(raw.action_type || ''),
    title: typeof raw.title === 'string' ? raw.title : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    targetCount: Math.max(1, Math.floor(Number(raw.targetCount ?? raw.target_count) || 1)),
    rewardUsdc: Math.max(0, Number(raw.rewardUsdc ?? raw.reward_usdc) || 0),
    sortOrder: Math.floor(Number(raw.sortOrder ?? raw.sort_order) || 0),
    periodKey: typeof raw.periodKey === 'string' ? raw.periodKey : String(raw.period_key || ''),
    progress: Math.max(0, Math.floor(Number(raw.progress) || 0)),
    completed: raw.completed === true,
    claimed: raw.claimed === true,
    canClaim: raw.canClaim === true
  };
}

export async function getQuestsState(): Promise<{ data: QuestsStatePayload | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/quests/state`);
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { data: null, error: typeof raw?.error === 'string' ? raw.error : 'Falha ao carregar tarefas.' };
    }
    const daily = Array.isArray(raw.daily)
      ? raw.daily.map(parseQuestStateItem).filter((x: QuestStateItem | null): x is QuestStateItem => !!x)
      : [];
    const weekly = Array.isArray(raw.weekly)
      ? raw.weekly.map(parseQuestStateItem).filter((x: QuestStateItem | null): x is QuestStateItem => !!x)
      : [];
    const parseBounds = (rawB: unknown): QuestPeriodBounds | null => {
      if (!rawB || typeof rawB !== 'object') return null;
      const startMs = Math.floor(Number(rawB.startMs) || 0);
      const endMs = Math.floor(Number(rawB.endMs) || 0);
      if (startMs <= 0 || endMs <= startMs) return null;
      return {
        key: typeof rawB.key === 'string' ? rawB.key : '',
        startMs,
        endMs
      };
    };
    return {
      data: {
        daily,
        weekly,
        dailyPeriodKey: typeof raw.dailyPeriodKey === 'string' ? raw.dailyPeriodKey : '',
        weeklyPeriodKey: typeof raw.weeklyPeriodKey === 'string' ? raw.weeklyPeriodKey : '',
        dailyPeriod: parseBounds(raw.dailyPeriod),
        weeklyPeriod: parseBounds(raw.weeklyPeriod)
      },
      error: null
    };
  } catch {
    return { data: null, error: 'Não foi possível conectar ao servidor.' };
  }
}

export type ChatMessageDto = {
  id: string;
  userId: number;
  username: string;
  body: string;
  kind?: 'text' | 'audio';
  audioUrl?: string | null;
  durationMs?: number | null;
  createdAt: number;
  channel: string;
  editedAt?: number | null;
  deletedAt?: number | null;
  mentions?: ChatMentionDto[];
};

export type ChatMentionDto = {
  userId: number;
  username: string;
};

export type ChatAmPeerDto = {
  channel: string;
  ownerUserId: number;
  managerUserId: number;
  peerUserId: number;
  peerUsername: string;
  role: 'owner' | 'manager';
};

function normalizeChatMessageDto(m: Partial<ChatMessageDto> | null | undefined, fallbackChannel = 'global'): ChatMessageDto | null {
  if (!m) return null;
  const id = String(m.id ?? '');
  if (!id) return null;
  const kind = String(m.kind || '').toLowerCase() === 'audio' ? 'audio' : 'text';
  const audioUrl = kind === 'audio' && m.audioUrl ? String(m.audioUrl) : null;
  const durationMs =
    kind === 'audio' && m.durationMs != null && Number.isFinite(Number(m.durationMs))
      ? Math.max(0, Math.floor(Number(m.durationMs)))
      : null;
  const body = String(m.body || '');
  const deletedAt = m.deletedAt != null ? Number(m.deletedAt) || null : null;
  if (!body && !audioUrl && !deletedAt) return null;
  const mentions = Array.isArray(m.mentions)
    ? m.mentions
        .map((x) => ({
          userId: Number(x?.userId) || 0,
          username: String(x?.username || '').trim()
        }))
        .filter((x) => x.userId > 0 && x.username)
    : undefined;
  return {
    id,
    userId: Number(m.userId) || 0,
    username: String(m.username || 'Jogador'),
    body,
    kind,
    audioUrl,
    durationMs,
    createdAt: Number(m.createdAt) || 0,
    channel: String(m.channel || fallbackChannel || 'global'),
    editedAt: m.editedAt != null ? Number(m.editedAt) || null : null,
    deletedAt,
    mentions
  };
}

export async function getChatPeers(): Promise<{
  ok: boolean;
  peers?: ChatAmPeerDto[];
  realUserId?: number;
  error?: string;
}> {
  try {
    const res = await apiFetch(`${base}/chat/peers`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      peers?: ChatAmPeerDto[];
      realUserId?: number;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return {
      ok: true,
      peers: Array.isArray(data.peers) ? data.peers : [],
      realUserId: Number(data.realUserId) || undefined
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getChatHistory(
  limit = 60,
  channel = 'global'
): Promise<{
  ok: boolean;
  messages?: ChatMessageDto[];
  error?: string;
}> {
  try {
    const q = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
      channel: String(channel || 'global')
    });
    const res = await apiFetch(`${base}/chat/history?${q.toString()}`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      messages?: ChatMessageDto[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    const messages = Array.isArray(data.messages)
      ? data.messages
          .map((m) => normalizeChatMessageDto(m, channel))
          .filter((m): m is ChatMessageDto => !!m)
      : [];
    return { ok: true, messages };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function searchChatMentions(
  query: string
): Promise<{ ok: boolean; users?: ChatMentionDto[]; error?: string }> {
  try {
    const q = String(query || '').trim().replace(/^@+/, '').slice(0, 32);
    if (q.length < 1) return { ok: true, users: [] };
    const res = await apiFetch(`${base}/chat/mentions?${new URLSearchParams({ q }).toString()}`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      users?: ChatMentionDto[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    const users = Array.isArray(data.users)
      ? data.users
          .map((u) => ({
            userId: Number(u?.userId) || 0,
            username: String(u?.username || '').trim()
          }))
          .filter((u) => u.userId > 0 && u.username)
      : [];
    return { ok: true, users };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function uploadChatAudio(
  blob: Blob,
  opts: { channel: string; durationMs: number; filename?: string }
): Promise<{ ok: boolean; message?: ChatMessageDto; error?: string; code?: string }> {
  try {
    const fd = new FormData();
    const ext =
      blob.type.includes('ogg')
        ? 'ogg'
        : blob.type.includes('mp4') || blob.type.includes('m4a')
          ? 'm4a'
          : blob.type.includes('mpeg') || blob.type.includes('mp3')
            ? 'mp3'
            : 'webm';
    fd.append('audio', blob, opts.filename || `chat-audio.${ext}`);
    fd.append('channel', String(opts.channel || 'global'));
    fd.append('durationMs', String(Math.max(1, Math.floor(opts.durationMs || 0))));
    const res = await apiFetch(`${base}/chat/audio`, { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: ChatMessageDto;
      error?: string;
      code?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    const message = normalizeChatMessageDto(data.message, opts.channel) || undefined;
    return { ok: true, message };
  } catch {
    return { ok: false, error: 'Falha no upload do áudio.' };
  }
}

export async function sendChatMessage(
  body: string,
  channel: string
): Promise<{ ok: boolean; message?: ChatMessageDto; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/chat/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, channel })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: ChatMessageDto;
      error?: string;
      code?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    return {
      ok: true,
      message: normalizeChatMessageDto(data.message, channel) || undefined
    };
  } catch {
    return { ok: false, error: 'Falha ao enviar mensagem.' };
  }
}

export async function editChatMessage(
  id: number | string,
  body: string
): Promise<{ ok: boolean; message?: ChatMessageDto; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/chat/messages/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: ChatMessageDto;
      error?: string;
      code?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    return {
      ok: true,
      message: normalizeChatMessageDto(data.message) || undefined
    };
  } catch {
    return { ok: false, error: 'Falha ao editar mensagem.' };
  }
}

export async function deleteChatMessage(
  id: number | string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/chat/messages/${encodeURIComponent(String(id))}`, {
      method: 'DELETE'
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, code: data.code };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Falha ao apagar mensagem.' };
  }
}

export async function claimQuestReward(
  questId: string
): Promise<{ data: { rewardUsdc: number; newUsdc: number } | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/quests/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questId })
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { data: null, error: typeof raw?.error === 'string' ? raw.error : 'Falha ao resgatar.' };
    }
    return {
      data: {
        rewardUsdc: Math.max(0, Number(raw.rewardUsdc) || 0),
        newUsdc: Math.max(0, Number(raw.newUsdc) || 0)
      },
      error: null
    };
  } catch {
    return { data: null, error: 'Não foi possível conectar ao servidor.' };
  }
}

export type AdminQuestDefinition = {
  id: string;
  period: string;
  action_type: string;
  title: string;
  description: string;
  target_count: number;
  reward_usdc: number;
  sort_order: number;
  enabled: number;
  updated_at: number;
};

export async function getAdminQuests(): Promise<{ definitions: AdminQuestDefinition[]; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/admin/quests`);
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { definitions: [], error: typeof raw?.error === 'string' ? raw.error : 'Falha ao listar tarefas.' };
    }
    const list = Array.isArray(raw.definitions) ? raw.definitions : [];
    return {
      definitions: list.map((d: unknown) => ({
        id: String(d.id || ''),
        period: String(d.period || ''),
        action_type: String(d.action_type || d.actionType || ''),
        title: String(d.title || ''),
        description: String(d.description || ''),
        target_count: Math.max(1, Math.floor(Number(d.target_count ?? d.targetCount) || 1)),
        reward_usdc: Math.max(0, Number(d.reward_usdc ?? d.rewardUsdc) || 0),
        sort_order: Math.floor(Number(d.sort_order ?? d.sortOrder) || 0),
        enabled: Number(d.enabled) === 1 ? 1 : 0,
        updated_at: Math.floor(Number(d.updated_at ?? d.updatedAt) || 0)
      })),
      error: null
    };
  } catch {
    return { definitions: [], error: 'Não foi possível conectar ao servidor.' };
  }
}

export async function saveAdminQuest(input: {
  id: string;
  title?: string;
  description?: string;
  targetCount?: number;
  rewardUsdc?: number;
  sortOrder?: number;
  enabled?: boolean;
}): Promise<{ definition: AdminQuestDefinition | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/admin/quests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { definition: null, error: typeof raw?.error === 'string' ? raw.error : 'Falha ao guardar.' };
    }
    const d = raw.definition;
    if (!d) return { definition: null, error: 'Resposta inválida.' };
    return {
      definition: {
        id: String(d.id || ''),
        period: String(d.period || ''),
        action_type: String(d.action_type || d.actionType || ''),
        title: String(d.title || ''),
        description: String(d.description || ''),
        target_count: Math.max(1, Math.floor(Number(d.target_count ?? d.targetCount) || 1)),
        reward_usdc: Math.max(0, Number(d.reward_usdc ?? d.rewardUsdc) || 0),
        sort_order: Math.floor(Number(d.sort_order ?? d.sortOrder) || 0),
        enabled: Number(d.enabled) === 1 ? 1 : 0,
        updated_at: Math.floor(Number(d.updated_at ?? d.updatedAt) || 0)
      },
      error: null
    };
  } catch {
    return { definition: null, error: 'Não foi possível conectar ao servidor.' };
  }
}

/** GET /api/admin/mining-runtime-summary — hashrates / miners ao vivo (workers). */
/** Admin economy runtime/apply — canonical: `./admin-economy`. */
export type { MiningRuntimeSummary } from './admin-economy';
export {
  getMiningRuntimeSummary,
  updateEconomySettings,
  syncMiningCoinLivePricesNow
} from './admin-economy';

export async function getExchangeSettings(): Promise<{ minExchangeAmount: number; exchangeFeePercent: number }> {
  try {
    const res = await apiFetch(`${base}/exchange-settings?t=${Date.now()}`);
    if (!res.ok) return { minExchangeAmount: 0.1, exchangeFeePercent: 0 };
    return await res.json();
  } catch { return { minExchangeAmount: 0.1, exchangeFeePercent: 0 }; }
}

export async function setExchangeSettings(settings: { minExchangeAmount: number; exchangeFeePercent: number }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/exchange-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    return await res.json();
  } catch { return { ok: false, error: 'Network error' }; }
}

export async function sellCoin(coinId: string, percentage: number): Promise<{ ok: boolean; soldAmount?: number; netUsdc?: number; feeUsdc?: number; newUsdc?: number; newCoinBalance?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/exchange/sell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coinId, percentage }) });
    return await res.json();
  } catch { return { ok: false, error: 'Network error' }; }
}

/** Wallet player API — canonical: `./wallet`. */
export type {
  WalletMinedBalanceRow,
  WalletStatePayload,
  WalletExchangeLiquidateOk,
  WalletExchangeLiquidateErr,
  WalletExchangeLiquidateResult,
  WithdrawalHistoryEntry,
  DepositHistoryEntry,
  Web3WithdrawToken
} from './wallet';
export {
  getWalletState,
  postExchangeLiquidate as postWalletExchangeLiquidate,
  requestWithdrawal,
  getMyWithdrawalHistory,
  getMyDepositHistory
} from './wallet';

export async function getWithdrawalRequests(): Promise<WithdrawalHistoryEntry[]> {
  try {
    const res = await apiFetch(`${base}/admin/withdrawals`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function updateWithdrawalStatus(requestId: string, status: 'completed' | 'rejected', txHash?: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/withdrawals/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, status, txHash })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Erro de rede' };
  }
}

export async function getTransparency(): Promise<TransparencyEntry[]> {
  try {
    const res = await apiFetch(`${base}/transparency`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function adminCreateTransparencyEntry(payload: {
  category: TransparencyCategory;
  title: string;
  body?: string;
  amountUsdc?: number | null;
  linkUrl?: string;
  periodYm?: string | null;
  sortOrder?: number;
}): Promise<{ ok: true; entry: TransparencyEntry } | { ok: false; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/transparency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error || `HTTP ${res.status}` };
    return { ok: true, entry: data as TransparencyEntry };
  } catch (e: unknown) {
    return { ok: false, error: e?.message || 'Erro de rede' };
  }
}

export async function adminUpdateTransparencyEntry(
  id: number,
  payload: Partial<{
    category: TransparencyCategory;
    title: string;
    body: string | null;
    amountUsdc: number | null;
    linkUrl: string | null;
    periodYm: string | null;
    sortOrder: number;
  }>
): Promise<{ ok: true; entry: TransparencyEntry } | { ok: false; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/transparency/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error || `HTTP ${res.status}` };
    return { ok: true, entry: data as TransparencyEntry };
  } catch (e: unknown) {
    return { ok: false, error: e?.message || 'Erro de rede' };
  }
}

export async function adminDeleteTransparencyEntry(id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/transparency/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e?.message || 'Erro de rede' };
  }
}


/** Announcements — canonical: `./announcements`. */
export type {
  InAppAnnouncementPayload,
  InAppAnnouncementAdminPayload
} from './announcements';
export {
  parseInAppAnnouncement,
  getPendingInAppAnnouncements,
  dismissInAppAnnouncement,
  getAdminInAppAnnouncements,
  createAdminInAppAnnouncement,
  updateAdminInAppAnnouncement,
  deleteAdminInAppAnnouncement
} from './announcements';

// --- Mini Blog ---

export type MiniBlogEntryPayload = InAppAnnouncementPayload;

export async function getMiniBlogEntries(): Promise<{ entries: MiniBlogEntryPayload[]; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/mini-blog`);
    if (!res.ok) {
      if (res.status === 401) return { entries: [], error: null };
      return { entries: [], error: 'Não foi possível carregar o Mini Blog.' };
    }
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    return {
      entries: list.map(parseInAppAnnouncement).filter((x): x is MiniBlogEntryPayload => x != null),
      error: null
    };
  } catch {
    return { entries: [], error: 'Falha de rede.' };
  }
}

/** Guide CMS — canonical: `./guide`. */
export type { GuidePagePayload, GuideCategoryPayload } from './guide';
export {
  getGuideContent,
  getAdminGuideContent,
  adminCreateGuideCategory,
  adminUpdateGuideCategory,
  adminDeleteGuideCategory,
  adminReorderGuideCategories,
  adminCreateGuidePage,
  adminUpdateGuidePage,
  adminDeleteGuidePage,
  adminReorderGuidePages
} from './guide';

/** Roadmap — canonical: `./roadmap`. */
export type { RoadmapStepPayload } from './roadmap';
export {
  getRoadmapSteps,
  getAdminRoadmapSteps,
  adminCreateRoadmapStep,
  adminUpdateRoadmapStep,
  adminDeleteRoadmapStep,
  adminReorderRoadmapSteps
} from './roadmap';

