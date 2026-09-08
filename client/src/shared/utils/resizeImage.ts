/**
 * Re-encode an image File to WebP in the browser before upload (and downscale
 * very large dimensions so transfer stays fast). The server also finalizes
 * avatars to WebP, but doing it here keeps a 15 MB phone photo from crawling
 * over a slow link and gives instant feedback.
 *
 * Non-images, GIFs, tiny WebPs, and anything that fails to decode are returned
 * unchanged.
 */
export type ResizeOptions = {
  maxDimension?: number;
  quality?: number;
  mimeType?: 'image/webp' | 'image/jpeg';
  /** Skip work if already this small AND already the target type. */
  passthroughBytes?: number;
};

const DEFAULTS: Required<ResizeOptions> = {
  maxDimension: 1600,
  quality: 0.85,
  mimeType: 'image/webp',
  passthroughBytes: 200 * 1024
};

export async function resizeImageFile(file: File, opts: ResizeOptions = {}): Promise<File> {
  const { maxDimension, quality, mimeType, passthroughBytes } = { ...DEFAULTS, ...opts };

  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.type === mimeType && file.size <= passthroughBytes) return file;
  if (typeof document === 'undefined') return file;

  try {
    const bitmap = await loadBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

    let blob = await encode(canvas, mimeType, quality);
    // Some browsers silently fall back to PNG for toBlob('image/webp').
    if (!blob || (mimeType === 'image/webp' && blob.type !== 'image/webp')) {
      blob = await encode(canvas, 'image/jpeg', quality);
    }
    if (!blob) return file;

    const ext = blob.type === 'image/webp' ? '.webp' : '.jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + ext;
    return new File([blob], name, { type: blob.type, lastModified: Date.now() });
  } catch {
    return file;
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
