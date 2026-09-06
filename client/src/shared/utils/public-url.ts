const IMG_SUBFOLDER =
  /^(miner|rack|fan|chip|battery|charger|coin|support|partner|favicon|landing|uploads|baterias|carregadores|moedas|parceiros)\//i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|ico|svg)(\?.*)?$/i;

/**
 * Garante URL utilizável no browser (CSS url() / <img src>).
 * Caminhos sem barra inicial resolvem contra o path atual e quebram em rotas SPA (ex.: /servers).
 * Valores da BD tipo `miner/foo.png` ou `/miner/foo.png` devem ir para `/img/miner/foo.png`.
 */
export function normalizePublicAssetUrl(src: string | null | undefined): string | undefined {
  if (src == null) return undefined;
  let s = String(src).trim();
  if (!s) return undefined;
  s = s.replace(/^\.\/+/, '');
  if (/^backend\//i.test(s)) {
    s = s.replace(/^backend\//i, '').replace(/^\.\/+/, '');
  }
  if (/^data:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return s;
  if (s.toLowerCase().startsWith('/img/')) return s;

  const underImg = (rel: string) => `/img/${rel.replace(/^\/+/, '')}`;

  if (s.startsWith('/')) {
    const rest = s.replace(/^\/+/, '');
    if (IMG_SUBFOLDER.test(rest) && IMG_EXT.test(rest)) return underImg(rest);
    if (!rest.includes('/') && IMG_EXT.test(rest)) return underImg(rest);
    return s;
  }

  if (/^img\//i.test(s)) return `/${s.replace(/^\/+/, '')}`;

  if (IMG_SUBFOLDER.test(s) && IMG_EXT.test(s)) return underImg(s);
  if (!s.includes('/') && IMG_EXT.test(s)) return underImg(s);
  return s;
}
