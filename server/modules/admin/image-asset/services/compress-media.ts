/**
 * Recompressão best-effort de imagens após upload (fidelidade visual alta,
 * só substitui se ficar menor). Migrado de legacy/backend/lib/compressMediaAsset.ts.
 *
 * ⚠️ Corte de escopo: o legado também recomprime vídeo (`.mp4`, via `ffmpeg`
 * H.264), mas nenhuma rota de upload portada (`/api/admin/upload-image`,
 * `/api/admin/upload-ad`) aceita vídeo — só imagem (png/jpg/webp/gif). Esse
 * branch ficaria morto (nunca chamado); omitido. GIF continua a usar `ffmpeg`
 * (preserva animação, sharp sozinho não faz isto bem) — se o binário não
 * estiver no PATH, falha e mantém o ficheiro original (best-effort).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PNG_COMPRESSION_LEVEL = 9;
const PNG_EFFORT = 10;
const JPEG_QUALITY = 94;
const WEBP_LOSSLESS_EFFORT = 6;
const GIF_FPS = 12;
const GIF_BAYER_SCALE = 3;
const FFMPEG_TIMEOUT_MS = 300_000;
/** Só substitui se o resultado recomprimido ficar pelo menos 2% menor. */
const MIN_SIZE_REDUCTION_RATIO = 0.98;

/**
 * Otimização com fidelidade visual alta:
 * - PNG/WebP: recompressão sem perda de pixels (nível PNG alto; WebP lossless).
 * - JPEG: mozjpeg q=94 só substitui se o ficheiro ficar menor (evita piorar uploads já otimizados).
 * - GIF: tenta recompressão com ffmpeg + palette (preserva animação); só substitui se menor.
 */
export async function compressMediaFileInPlace(absPath: string): Promise<void> {
  try {
    if (!fs.existsSync(absPath)) return;
    const ext = path.extname(absPath).toLowerCase();
    if (RASTER.has(ext)) {
      await compressRaster(absPath, ext);
      return;
    }
    if (ext === '.gif') {
      await compressGifPreserveAnimation(absPath);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[compressMedia] skip', absPath, msg);
  }
}

async function compressRaster(absPath: string, ext: string): Promise<void> {
  const input = fs.readFileSync(absPath);
  const meta = await sharp(input, { failOn: 'none' }).metadata();
  if (meta.format === 'png') {
    const out = await sharp(input, { failOn: 'none' }).png({ compressionLevel: PNG_COMPRESSION_LEVEL, adaptiveFiltering: true, effort: PNG_EFFORT }).toBuffer();
    if (out.length <= input.length) fs.writeFileSync(absPath, out);
    return;
  }
  if (meta.format === 'jpeg' || ext === '.jpg' || ext === '.jpeg') {
    const out = await sharp(input, { failOn: 'none' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
    if (out.length < input.length) fs.writeFileSync(absPath, out);
    return;
  }
  if (meta.format === 'webp' || ext === '.webp') {
    const out = await sharp(input, { failOn: 'none' }).webp({ lossless: true, effort: WEBP_LOSSLESS_EFFORT }).toBuffer();
    if (out.length <= input.length) fs.writeFileSync(absPath, out);
  }
}

async function compressGifPreserveAnimation(absPath: string): Promise<void> {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath, '.gif');
  const palette = path.join(dir, `${base}.ms-palette.png`);
  const tmp = path.join(dir, `${base}.ms-opt.gif`);
  try {
    await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', absPath, '-vf', `fps=${GIF_FPS},scale=iw:-1:flags=lanczos,palettegen`, palette],
      { timeout: FFMPEG_TIMEOUT_MS }
    );
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        absPath,
        '-i',
        palette,
        '-lavfi',
        `fps=${GIF_FPS},scale=iw:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=${GIF_BAYER_SCALE}`,
        tmp
      ],
      { timeout: FFMPEG_TIMEOUT_MS }
    );
    const before = fs.statSync(absPath).size;
    const after = fs.statSync(tmp).size;
    if (after > 0 && after < before * MIN_SIZE_REDUCTION_RATIO) {
      fs.renameSync(tmp, absPath);
    } else {
      fs.unlinkSync(tmp);
    }
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  } finally {
    try {
      if (fs.existsSync(palette)) fs.unlinkSync(palette);
    } catch {
      /* ignore */
    }
  }
}
