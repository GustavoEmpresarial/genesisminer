/**
 * Resolve a extensão de um upload de áudio a partir do mimetype/nome, e
 * valida a assinatura de ficheiro (magic bytes) — independente da extensão
 * declarada, igual em espírito a `modules/admin/image-asset/services/magic-bytes.ts`
 * mas pra formatos de áudio (WebM/OGG/MP3/MP4-M4A/WAV).
 *
 * Migrado de legacy/backend/modules/chat/chat.controller.ts
 * (`resolveAudioExt`/`looksLikeAudioMagic`).
 */
import path from 'node:path';

const AUDIO_EXT_BY_MIME: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/webm': '.webm'
};

const ALLOWED_AUDIO_EXT = new Set(['.webm', '.ogg', '.mp3', '.m4a', '.mp4', '.aac', '.wav']);

export function resolveAudioExt(originalName: string, mimetype: string): string | null {
  const mime = String(mimetype || '').toLowerCase().split(';')[0]!.trim();
  if (AUDIO_EXT_BY_MIME[mime]) return AUDIO_EXT_BY_MIME[mime];
  const ext = path.extname(originalName || '').toLowerCase();
  if (ALLOWED_AUDIO_EXT.has(ext)) return ext === '.mp4' ? '.m4a' : ext;
  return null;
}

const MAGIC_BYTES_HEAD_LEN = 32;
const MAGIC_BYTES_MIN_LEN = 12;

/* eslint-disable no-magic-numbers -- offsets/bytes de assinatura de formato (RIFF/ID3/MPEG/OggS/ftyp/EBML),
   já nomeados pela função que os agrupa; não há "constante mais nomeada" possível. */
export function looksLikeAudioMagic(buf: Buffer): boolean {
  if (buf.length < MAGIC_BYTES_MIN_LEN) return false;
  // RIFF....WAVE
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // ID3 / MPEG frame sync
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return true;
  // OggS
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // ftyp (mp4/m4a)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  // EBML (webm/mkv)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}
/* eslint-enable no-magic-numbers */

export const AUDIO_MAGIC_BYTES_HEAD_LEN = MAGIC_BYTES_HEAD_LEN;
