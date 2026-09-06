/**
 * Época de nomes dos assets buildados (`/assets/index-<hash>.<época>.css`).
 *
 * Assets vão para o browser e para a Cloudflare com `immutable` de 1 ano, logo
 * uma resposta errada gravada nesse URL não é revalidada — nem com deploy novo,
 * nem com purga do CDN (o browser nunca pergunta). A única forma de abandonar
 * uma entrada envenenada é mudar o nome do ficheiro.
 *
 * Bumpar só nesse caso: renomear invalida o cache de todos os utilizadores.
 *
 * Histórico:
 * - `e1`: HTML servido em `/assets/*.css` durante deploy quebrado ficou cacheado
 *   como CSS (páginas sem estilo). Origem corrigida com 404 em `/assets/*`
 *   inexistente; este bump abandona os URLs já envenenados.
 */
export const ASSET_EPOCH = 'e3';

/** Padrões de saída do Rollup — extensão fica no fim para o content-type ser correto. */
export function buildAssetFileNames(epoch: string = ASSET_EPOCH): {
  entryFileNames: string;
  chunkFileNames: string;
  assetFileNames: string;
} {
  return {
    entryFileNames: `assets/[name]-[hash].${epoch}.js`,
    chunkFileNames: `assets/[name]-[hash].${epoch}.js`,
    assetFileNames: `assets/[name]-[hash].${epoch}[extname]`
  };
}
