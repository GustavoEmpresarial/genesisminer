/** Client-side HTTPS / self-hosted image guards (mirrors server announcement validation). */

export const SAFE_IN_APP_IMAGE_PATH_RE =
  /^\/img\/(?:uploads\/[a-zA-Z0-9._-]+|ad-[0-9]+-[0-9a-zA-Z]+)\.(png|jpe?g|gif|webp)$/i;

const DANGEROUS_SCHEME = /^(javascript|data|vbscript)\s*:/i;

export function isSafeInAppImagePath(src: string | null | undefined): boolean {
  if (!src) return false;
  const t = String(src).trim();
  if (!t || t.includes('..') || /^https?:/i.test(t) || /^data:/i.test(t) || /^\/\//.test(t)) {
    return false;
  }
  const normalized = t.startsWith('/img/') ? t : t.startsWith('img/') ? `/${t}` : null;
  return normalized != null && SAFE_IN_APP_IMAGE_PATH_RE.test(normalized);
}

export function normalizeSafeInAppImagePath(src: string | null | undefined): string | null {
  if (!isSafeInAppImagePath(src)) return null;
  const t = String(src).trim();
  return t.startsWith('/img/') ? t : `/${t.replace(/^\/+/, '')}`;
}

export function isSafeHttpsLink(link: string | null | undefined): boolean {
  if (!link) return false;
  const t = String(link).trim();
  if (!t || t.length > 2048 || DANGEROUS_SCHEME.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}
