/** Migrado de legacy/backend/modules/partners/partners.youtubeUrl.ts (verbatim). */
import { extractYoutubeVideoId, YOUTUBE_VIDEO_ID_RE } from './helpers.js';

const YOUTUBE_URL_MAX_LENGTH = 500;
// eslint-disable-next-line no-control-regex -- uso deliberado: rejeita bytes de controlo e < > na URL.
const CONTROL_OR_ANGLE_BRACKET_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f<>]/;

/** Domínios permitidos para envio (sem encurtadores nem terceiros). */
function isAllowedYoutubeSubmitHost(hostname: string): boolean {
  const h = String(hostname || '').replace(/^www\./i, '').toLowerCase();
  return h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be';
}

/** Valida URL (apenas YouTube), extrai ID no servidor e devolve URL canónica `watch?v=`. */
export function validateAndCanonicalYoutubeUrl(raw: string): { videoId: string; canonicalUrl: string } | null {
  const t = String(raw || '').trim();
  if (!t || t.length > YOUTUBE_URL_MAX_LENGTH) return null;
  if (CONTROL_OR_ANGLE_BRACKET_RE.test(t)) return null;
  const lower = t.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:') || lower.includes('vbscript:')) return null;
  try {
    const withProto = /^https:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    if (u.protocol !== 'https:') return null;
    if (!isAllowedYoutubeSubmitHost(u.hostname)) return null;
  } catch {
    return null;
  }
  const videoId = extractYoutubeVideoId(t);
  if (!videoId) return null;
  return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

export function youtubeThumbnailUrl(videoId: string): string {
  const v = String(videoId || '').trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(v)) return '';
  return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
}

export function youtubeEmbedUrl(videoId: string): string {
  const v = String(videoId || '').trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(v)) return '';
  return `https://www.youtube.com/embed/${v}`;
}
