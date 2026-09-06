/** Migrado de legacy/backend/utils/partnerYoutubeHelpers.ts (verbatim). */
/** Compartilhada com `youtube-url.ts` (thumbnail/embed) — evita duas cópias do mesmo padrão. */
export const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const MONTH_INDEX_OFFSET = 1;
const YEAR_MULTIPLIER = 10000;
const MONTH_MULTIPLIER = 100;
const CHANNEL_URL_MAX_LENGTH = 500;
const CHANNEL_NAME_MAX_LENGTH = 120;
const CHANNEL_DESCRIPTION_MAX_LENGTH = 800;
const AVATAR_URL_MAX_LENGTH = 800;
const CURSOR_ID_MAX_LENGTH = 120;
const CURSOR_ID_MIN_LENGTH = 8;

/** Início do dia civil UTC em milissegundos (para limite 1 envio/dia). */
export function partnerYoutubeUtcDayStartMs(ts: number): number {
  const d = new Date(Number(ts) || Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Chave YYYYMMDD em UTC (inteiro) — alinhada à coluna `submit_utc_day`. */
export function partnerYoutubeUtcDayKeyYYYYMMDD(ts: number): number {
  const d = new Date(Number(ts) || Date.now());
  return d.getUTCFullYear() * YEAR_MULTIPLIER + (d.getUTCMonth() + MONTH_INDEX_OFFSET) * MONTH_MULTIPLIER + d.getUTCDate();
}

/** Extrai o ID de 11 caracteres de URLs watch / youtu.be / shorts / embed. */
export function extractYoutubeVideoId(rawUrl: string): string {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  try {
    const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    const url = new URL(withProto);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = (url.pathname || '').replace(/^\//, '').split('/')[0] || '';
      return YOUTUBE_VIDEO_ID_RE.test(id) ? id : '';
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const p = (url.pathname || '').toLowerCase();
      if (p.startsWith('/watch')) {
        const v = url.searchParams.get('v') || '';
        return YOUTUBE_VIDEO_ID_RE.test(v) ? v : '';
      }
      if (p.startsWith('/embed/')) {
        const id = (p.split('/')[2] || '').trim();
        return YOUTUBE_VIDEO_ID_RE.test(id) ? id : '';
      }
      if (p.startsWith('/shorts/')) {
        const id = ((p.split('/')[2] || '').split('?')[0] || '').trim();
        return YOUTUBE_VIDEO_ID_RE.test(id) ? id : '';
      }
    }
  } catch {
    return '';
  }
  return '';
}

/** Ids de nível de acesso que podem enviar vídeos (valores reais em users / user_access_levels). */
const PARTNER_LEVEL_IDS = new Set(['partners', 'parceiros', 'partner', 'parceiro']);

export function userAccessSetHasPartnerLevel(idSet: Set<string>): boolean {
  for (const x of idSet) {
    if (PARTNER_LEVEL_IDS.has(String(x || '').toLowerCase().trim())) return true;
  }
  return false;
}

export type PartnerYoutubeVideoCursor = { sortTs: bigint; id: string };

export function encodePartnerYoutubeVideoCursor(sortTs: number, id: string): string {
  return `${sortTs}_${id}`;
}

export function parsePartnerYoutubeVideoCursor(raw: unknown): PartnerYoutubeVideoCursor | null {
  const s = raw != null ? String(raw).trim() : '';
  const i = s.indexOf('_');
  if (i <= 0) return null;
  const tsPart = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!/^\d+$/.test(tsPart) || !id || id.length > CURSOR_ID_MAX_LENGTH || id.length < CURSOR_ID_MIN_LENGTH) return null;
  try {
    return { sortTs: BigInt(tsPart), id };
  } catch {
    return null;
  }
}

/** URL do canal YouTube (https, domínio YouTube). Vazio = limpar / não definido. */
export function sanitizePartnerCreatorChannelUrl(raw: string): string {
  const t = String(raw || '').trim().slice(0, CHANNEL_URL_MAX_LENGTH);
  if (!t) return '';
  try {
    const withProto = /^https:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    if (u.protocol !== 'https:') return '';
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const p = (u.pathname || '').toLowerCase();
      if (p.startsWith('/watch') || p.startsWith('/shorts/') || p.startsWith('/embed/')) return '';
      if (p === '/' || p === '') return '';
      return u.toString();
    }
    if (host === 'youtu.be') return '';
    return '';
  } catch {
    return '';
  }
}

export function sanitizePartnerChannelName(raw: string): string {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, CHANNEL_NAME_MAX_LENGTH);
}

export function sanitizePartnerChannelDescription(raw: string): string {
  return String(raw || '').trim().slice(0, CHANNEL_DESCRIPTION_MAX_LENGTH);
}

/** Imagem vitrine: https absoluto ou caminho relativo do site (ex. /brain/...). */
export function sanitizePartnerCreatorAvatarUrl(raw: string): string {
  const t = String(raw || '').trim().slice(0, AVATAR_URL_MAX_LENGTH);
  if (!t) return '';
  if (/^https:\/\//i.test(t)) {
    try {
      void new URL(t);
      return t;
    } catch {
      return '';
    }
  }
  // Sem `..` — evita path relativo a escapar do site (ex. /img/../../...).
  if (t.includes('..')) return '';
  if (t.startsWith('/') && /^\/[\w\-./?#+%]{1,700}$/i.test(t)) return t;
  return '';
}
