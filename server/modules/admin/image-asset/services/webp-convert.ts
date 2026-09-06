/**
 * Converte raster (png/jpg/jpeg/gif) para `.webp` no mesmo diretório, usando `sharp`.
 *
 * Migrado de legacy/backend/lib/convertImageToWebp.ts (só a parte que depende de
 * `sharp` — os helpers puros de caminho já viviam em `./webp-paths.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isConvertibleRasterExt, webpSiblingPath } from './webp-paths.js';

const WEBP_QUALITY_FLOOR = 50;
const WEBP_QUALITY_CEILING = 95;
const WEBP_QUALITY_DEFAULT = 85;
const WEBP_EFFORT = 4;

export type ConvertRasterFileToWebpResult = { ok: boolean; absPath: string; converted: boolean; error?: string };

/**
 * Converte ficheiro no disco para WebP.
 * - PNG/JPEG: webp quality 85 (bom equilíbrio)
 * - GIF animado: tenta animated webp; se falhar, mantém gif
 * - Já webp: no-op
 */
export async function convertRasterFileToWebp(
  absPath: string,
  opts?: { quality?: number; removeOriginal?: boolean }
): Promise<ConvertRasterFileToWebpResult> {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { ok: false, absPath, converted: false, error: 'missing' };
    }
    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.webp') return { ok: true, absPath, converted: false };
    if (!isConvertibleRasterExt(ext)) {
      return { ok: false, absPath, converted: false, error: `skip_ext:${ext}` };
    }

    const outAbs = webpSiblingPath(absPath);
    const quality = Math.max(WEBP_QUALITY_FLOOR, Math.min(WEBP_QUALITY_CEILING, opts?.quality ?? WEBP_QUALITY_DEFAULT));
    const input = fs.readFileSync(absPath);
    const animated = ext === '.gif';
    const pipeline = sharp(input, { failOn: 'none', animated });
    const out = await pipeline.webp({ quality, effort: WEBP_EFFORT }).toBuffer();
    if (!out.length) return { ok: false, absPath, converted: false, error: 'empty_out' };
    fs.writeFileSync(outAbs, out);

    if (opts?.removeOriginal !== false && outAbs !== absPath) {
      try {
        fs.unlinkSync(absPath);
      } catch {
        /* keep original if unlink fails */
      }
    }
    return { ok: true, absPath: outAbs, converted: true };
  } catch (e) {
    return { ok: false, absPath, converted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
