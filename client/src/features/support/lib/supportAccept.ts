/** `accept` attribute for player support attachment inputs. */
export const SUPPORT_FILE_ACCEPT =
  'image/png,image/jpeg,image/jpg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.mov';

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
