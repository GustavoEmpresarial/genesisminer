import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIN_BYTES
} from '../../../shared/constants/formLimits';
import {
  isAllowedSupportAttachmentExt,
  supportAttachmentExt
} from './supportAccept';

const HEIC_EXTENSIONS = ['.heic', '.heif'] as const;
const HEIC_MIMES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'] as const;

/** MIME → stored extension. Same table as worker `resolve_support_ext`. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
};

const FALLBACK_STEM = 'anexo';

export type SupportAttachmentDecision =
  | { kind: 'keep' }
  | { kind: 'rename'; ext: string }
  | { kind: 'transcode' }
  | { kind: 'reject' };

export type PreparedSupportAttachment =
  | { file: File }
  | { error: 'type' | 'unreadable' | 'too-large'; name: string };

function mimeBase(mime: string): string {
  return mime.toLowerCase().split(';')[0]?.trim() ?? '';
}

function isHeicExt(ext: string): boolean {
  return (HEIC_EXTENSIONS as readonly string[]).includes(ext);
}

function isHeicMime(mime: string): boolean {
  return (HEIC_MIMES as readonly string[]).includes(mime);
}

/** Filename stem with directory separators removed. */
export function supportAttachmentStem(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[\\/]/g, '');
  return stem || FALLBACK_STEM;
}

export function decideSupportAttachment(name: string, mime: string): SupportAttachmentDecision {
  const ext = supportAttachmentExt(name);
  const normalized = mimeBase(mime);
  if (isHeicExt(ext) || isHeicMime(normalized)) return { kind: 'transcode' };
  if (isAllowedSupportAttachmentExt(ext)) return { kind: 'keep' };
  const mapped = MIME_TO_EXT[normalized];
  if (mapped) return { kind: 'rename', ext: mapped };
  if (normalized.startsWith('image/')) return { kind: 'transcode' };
  return { kind: 'reject' };
}

function renamedFile(file: File, ext: string): File {
  const type = file.type.trim() || MIME_BY_EXT[ext] || '';
  return new File([file], `${supportAttachmentStem(file.name)}${ext}`, { type });
}

function transcodeImageToJpeg(file: File): Promise<File | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = (out: File | null) => {
      URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (width <= 0 || height <= 0) {
        finish(null);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        finish(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          finish(null);
          return;
        }
        finish(new File([blob], `${supportAttachmentStem(file.name)}.jpg`, { type: 'image/jpeg' }));
      }, 'image/jpeg');
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

export async function prepareSupportAttachment(
  file: File,
  transcode: (file: File) => Promise<File | null> = transcodeImageToJpeg
): Promise<PreparedSupportAttachment> {
  const decision = decideSupportAttachment(file.name, file.type);
  if (decision.kind === 'reject') return { error: 'type', name: file.name };
  if (decision.kind === 'keep') return { file };
  if (decision.kind === 'rename') return { file: renamedFile(file, decision.ext) };

  const converted = await transcode(file);
  if (!converted || converted.size < SUPPORT_ATTACHMENT_MIN_BYTES) {
    return { error: 'unreadable', name: file.name };
  }
  if (converted.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
    return { error: 'too-large', name: file.name };
  }
  if (supportAttachmentExt(converted.name) === '.jpg') return { file: converted };
  return {
    file: new File([converted], `${supportAttachmentStem(file.name)}.jpg`, { type: 'image/jpeg' })
  };
}
