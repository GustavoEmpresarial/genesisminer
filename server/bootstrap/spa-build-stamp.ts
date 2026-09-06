/**
 * Selo de build do SPA injetado no `index.html` (`<meta name="genesis-build">`).
 *
 * O client compara o selo com o que tem em `localStorage` e, quando muda, limpa
 * estado volátil (ex. hint de sessão) antes de renderizar — evita que um browser
 * com estado de uma build antiga fique a bater em APIs autenticadas com 401.
 *
 * O selo deriva do conteúdo do `index.html`, que já embute os hashes dos assets:
 * build igual ⇒ selo igual (restart do contentor não limpa nada); build nova com
 * bundle diferente ⇒ selo novo.
 */
import crypto from 'node:crypto';

export const SPA_BUILD_META_NAME = 'genesis-build';

/** Prefixo do sha256 em hex — colisão irrelevante para invalidação de cache local. */
const BUILD_ID_LENGTH = 16;

export function computeSpaBuildId(indexHtml: string): string {
  return crypto.createHash('sha256').update(indexHtml).digest('hex').slice(0, BUILD_ID_LENGTH);
}

/**
 * Injeta (ou substitui) a meta tag do selo. Sem `<head>` reconhecível, devolve o
 * HTML intacto — servir a app é mais importante que o selo.
 */
export function injectSpaBuildMeta(indexHtml: string, buildId: string): string {
  const meta = `<meta name="${SPA_BUILD_META_NAME}" content="${buildId}" />`;
  const existing = new RegExp(`<meta\\s+name="${SPA_BUILD_META_NAME}"[^>]*>`, 'i');
  if (existing.test(indexHtml)) return indexHtml.replace(existing, meta);
  const headOpen = /<head(\s[^>]*)?>/i;
  if (!headOpen.test(indexHtml)) return indexHtml;
  return indexHtml.replace(headOpen, (match) => `${match}\n    ${meta}`);
}

export function buildStampedSpaIndex(indexHtml: string): { html: string; buildId: string } {
  const buildId = computeSpaBuildId(indexHtml);
  return { html: injectSpaBuildMeta(indexHtml, buildId), buildId };
}
