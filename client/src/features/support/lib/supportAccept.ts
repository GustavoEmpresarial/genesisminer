/**
 * `accept` for support attachment inputs.
 * `image/*` plus HEIC so the phone camera roll is visible. The client
 * normalizes to `SUPPORT_ALLOWED_EXTENSIONS` before upload; the worker
 * stores only those extensions.
 */
export const SUPPORT_FILE_ACCEPT =
  'image/*,image/heic,image/heif,.heic,.heif,video/mp4,video/webm,video/quicktime,.mov';

/** Matches worker `SUPPORT_ALLOWED_EXT` in `uploads.rs`. */
export const SUPPORT_ALLOWED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
  '.mov'
] as const;

/** Lowercased extension including the leading dot, or `''` if none. */
export function supportAttachmentExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i).toLowerCase();
}

export function isAllowedSupportAttachmentExt(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return (SUPPORT_ALLOWED_EXTENSIONS as readonly string[]).includes(normalized);
}
