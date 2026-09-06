/**
 * Helpers puros de caminho pra fallback de `.webp` — migrados de
 * legacy/backend/lib/convertImageToWebp.ts (só a parte sem `sharp`;
 * `convertRasterFileToWebp`, que converte de facto, fica de fora — ver
 * corte de escopo em `../controllers/image-asset.controller.ts`).
 */
import path from 'node:path';

const CONVERTIBLE = new Set(['.png', '.jpg', '.jpeg', '.gif']);

export function isConvertibleRasterExt(ext: string): boolean {
  return CONVERTIBLE.has(String(ext || '').toLowerCase());
}

export function webpSiblingPath(absPath: string): string {
  const ext = path.extname(absPath);
  return absPath.slice(0, -ext.length) + '.webp';
}

const WEBP_PUBLIC_PATH_RE = /\.(png|jpe?g|gif)(\?.*)?$/i;

/** Troca a extensão pública `/img/.../x.png` → `/img/.../x.webp`. */
export function publicPathToWebp(publicPath: string): string {
  return String(publicPath || '').replace(WEBP_PUBLIC_PATH_RE, '.webp$2');
}
