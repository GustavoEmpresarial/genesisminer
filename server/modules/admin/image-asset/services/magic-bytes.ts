/**
 * Valida magic bytes de ficheiro no disco (PNG/JPEG/GIF), independente da extensão
 * declarada — usado após upload multipart para não confiar só no nome do ficheiro.
 *
 * Migrado de legacy/backend/validation/inAppAnnouncementValidation.ts
 * (`assertImageFileMagicBytes`) — só esta função, o resto do ficheiro original
 * pertence a `modules/announcements/services/validation.ts`.
 */
import fs from 'node:fs';

const MAGIC_BYTES_HEAD_LEN = 12;
/* eslint-disable no-magic-numbers -- os próprios bytes de assinatura de formato (PNG/JPEG),
   já nomeados pelas constantes que os contêm; não há "constante mais nomeada" possível. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/* eslint-enable no-magic-numbers */
const GIF_SIGNATURES = new Set(['GIF87a', 'GIF89a']);
const GIF_SIGNATURE_LEN = 6;

/** Magic bytes para PNG / JPEG / GIF após upload em disco. */
export function assertImageFileMagicBytes(filePath: string, ext: string): boolean {
  let head: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(MAGIC_BYTES_HEAD_LEN);
      fs.readSync(fd, head, 0, MAGIC_BYTES_HEAD_LEN, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const e = ext.toLowerCase();
  if (e === '.png') {
    return PNG_MAGIC.every((byte, i) => head[i] === byte);
  }
  if (e === '.jpg' || e === '.jpeg') {
    return JPEG_MAGIC.every((byte, i) => head[i] === byte);
  }
  if (e === '.gif') {
    const sig = head.subarray(0, GIF_SIGNATURE_LEN).toString('ascii');
    return GIF_SIGNATURES.has(sig);
  }
  return false;
}
