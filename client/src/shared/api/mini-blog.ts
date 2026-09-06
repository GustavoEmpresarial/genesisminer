import { isSafeHttpsLink, normalizeSafeInAppImagePath } from '../utils/safe-https-link';
import { apiFetch } from './http';

const base = '/api';

const ANNOUNCEMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MiniBlogEntry = {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
};

function parseEntry(raw: unknown): MiniBlogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const message = typeof o.message === 'string' ? o.message : '';
  if (!id || !title || !message) return null;
  if (!ANNOUNCEMENT_ID_RE.test(id)) return null;
  const rawLink = typeof o.link === 'string' && o.link.trim() ? o.link.trim() : null;
  const link = rawLink && isSafeHttpsLink(rawLink) ? rawLink : null;
  const imageUrlRaw = o.imageUrl ?? o.image_url;
  const imageUrl =
    typeof imageUrlRaw === 'string' ? normalizeSafeInAppImagePath(imageUrlRaw) : null;
  return { id, title, message, link, imageUrl };
}

export async function getMiniBlogEntries(): Promise<{ entries: MiniBlogEntry[]; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/mini-blog`);
    if (!res.ok) {
      if (res.status === 401) return { entries: [], error: 'SESSION' };
      return { entries: [], error: 'LOAD_FAILED' };
    }
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    return {
      entries: list.map(parseEntry).filter((x): x is MiniBlogEntry => x != null),
      error: null
    };
  } catch {
    return { entries: [], error: 'NETWORK' };
  }
}
