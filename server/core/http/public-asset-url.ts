/**
 * Migrado de legacy/backend/lib/publicAssetUrl.ts (verbatim).
 * Alinhado com `frontend/utils/publicUrl.ts`: garante URLs de imagem servidas em
 * `/img/...` (evita `/miner/...` que o SPA não serve e cai em HTML).
 */
const IMG_SUBFOLDER_RE =
  /^(miner|rack|fan|chip|battery|charger|coin|support|partner|favicon|landing|uploads|baterias|carregadores|moedas|parceiros)\//i;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|ico|svg)(\?.*)?$/i;
const LEADING_DOT_SLASH_RE = /^\.\/+/;
const LEADING_BACKEND_RE = /^backend\//i;
const DATA_URI_RE = /^data:/i;
const ABSOLUTE_URL_RE = /^https?:\/\//i;
const LEADING_SLASHES_RE = /^\/+/;
const IMG_PREFIX_RE = /^img\//i;

/**
 * Reescreve `src` para o caminho público correto de asset de imagem (sob
 * `/img/...`), quando reconhecível. URLs absolutas, data URI, `//host/...`,
 * ou já sob `/img/` passam intactas. `undefined` se `src` for nulo/vazio.
 */
export function normalizePublicAssetUrl(src: string | null | undefined): string | undefined {
  if (src == null) return undefined;
  let s = String(src).trim();
  if (!s) return undefined;
  s = s.replace(LEADING_DOT_SLASH_RE, '');
  if (LEADING_BACKEND_RE.test(s)) {
    s = s.replace(LEADING_BACKEND_RE, '').replace(LEADING_DOT_SLASH_RE, '');
  }
  if (DATA_URI_RE.test(s)) return s;
  if (ABSOLUTE_URL_RE.test(s)) return s;
  if (s.startsWith('//')) return s;
  if (s.toLowerCase().startsWith('/img/')) return s;

  const underImg = (rel: string) => `/img/${rel.replace(LEADING_SLASHES_RE, '')}`;

  if (s.startsWith('/')) {
    const rest = s.replace(LEADING_SLASHES_RE, '');
    if (IMG_SUBFOLDER_RE.test(rest) && IMG_EXT_RE.test(rest)) return underImg(rest);
    if (!rest.includes('/') && IMG_EXT_RE.test(rest)) return underImg(rest);
    return s;
  }

  if (IMG_PREFIX_RE.test(s)) return `/${s.replace(LEADING_SLASHES_RE, '')}`;

  if (IMG_SUBFOLDER_RE.test(s) && IMG_EXT_RE.test(s)) return underImg(s);
  if (!s.includes('/') && IMG_EXT_RE.test(s)) return underImg(s);
  return s;
}
