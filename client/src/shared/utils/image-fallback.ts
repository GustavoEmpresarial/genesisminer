/**
 * Fallback consistente para imagens em falta no jogo (ícones de upgrades, caixas,
 * baterias, GPUs, etc.). Aplicar a `<img onError={handleImageError}>`:
 *
 *   <img src={url} onError={handleImageError(emoji)} alt="..." />
 *
 * Comportamento:
 *  - Garante que `onError` só executa uma vez por elemento (anti-loop quando o
 *    placeholder também devolver 404).
 *  - Tenta primeiro um placeholder SVG inline data-URL com o emoji indicado.
 *  - Se o emoji renderizar mal (raro), o utilizador vê apenas um cartão neutro
 *    em vez de um ícone partido — sem alt-text feio e sem rebentar layout.
 *
 * Razão: a pasta `backend/img/` pode estar incompleta numa instalação fresca; a
 * ausência de uma imagem nunca pode quebrar a lógica do jogo (abrir caixa,
 * comprar no P2P, mostrar prémio da roleta, etc.).
 */

const FALLBACK_FLAG = 'data-fallback-applied';

function svgFallbackDataUrl(emoji: string): string {
  const safe = emoji.replace(/</g, '').replace(/>/g, '').slice(0, 2) || '🎁';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="imagem em falta">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="url(#bg)" stroke="#fb923c" stroke-opacity="0.35" stroke-width="2"/>
  <text x="32" y="44" text-anchor="middle" font-size="34" font-family="system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif">${safe}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Aplica fallback SVG inline numa `<img>` quebrada.
 *
 * Pode ser usado de duas formas (compat com chamadas existentes):
 *
 *   // 1) Curry com emoji custom:
 *   <img onError={handleImageError('🎁')} />
 *
 *   // 2) Direto como handler (default emoji 📦):
 *   <img onError={handleImageError} />
 *   <img onError={(e) => handleImageError(e)} />
 */
function applyFallback(img: HTMLImageElement | null | undefined, emoji: string) {
  if (!img || img.getAttribute(FALLBACK_FLAG) === '1') return;
  img.setAttribute(FALLBACK_FLAG, '1');
  img.src = svgFallbackDataUrl(emoji);
}

export function handleImageError(
  emoji?: string
): (event: React.SyntheticEvent<HTMLImageElement>) => void;
export function handleImageError(event: React.SyntheticEvent<HTMLImageElement>): void;
export function handleImageError(
  arg?: string | React.SyntheticEvent<HTMLImageElement>
): ((event: React.SyntheticEvent<HTMLImageElement>) => void) | void {
  if (arg && typeof arg !== 'string' && 'currentTarget' in arg) {
    applyFallback(arg.currentTarget, '📦');
    return;
  }
  const emoji = typeof arg === 'string' ? arg : '📦';
  return (event: React.SyntheticEvent<HTMLImageElement>) => {
    applyFallback(event.currentTarget, emoji);
  };
}

/** Inline data-URL pronta a usar como `src` (sem dependência de rede). */
export function placeholderImageDataUrl(emoji: string = '📦'): string {
  return svgFallbackDataUrl(emoji);
}
