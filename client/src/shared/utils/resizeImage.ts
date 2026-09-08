/**
 * Downscale/re-encode an image File in the browser so avatar uploads stay well
 * under the proxy's body limit (nginx default 1 MB on the partner avatar route).
 * A raw phone photo is 2–5 MB → 413 before it reaches the app; after this it is
 * a ~1024px JPEG in the low hundreds of KB.
 *
 * Non-images and anything that fails to decode are returned unchanged.
 */
export type ResizeOptions = {
  maxDimension?: number;
  quality?: number;
  /** Skip resizing if the file is already at or below this size. */
  passthroughBytes?: number;
};

const DEFAULTS: Required<ResizeOptions> = {
  maxDimension: 1024,
  quality: 0.82,
  passthroughBytes: 400 * 1024
};

export async function resizeImageFile(file: File, opts: ResizeOptions = {}): Promise<File> {
  const { maxDimension, quality, passthroughBytes } = { ...DEFAULTS, ...opts };

  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size <= passthroughBytes) return file;
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

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
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
