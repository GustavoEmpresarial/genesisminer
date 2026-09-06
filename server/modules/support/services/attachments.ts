/**
 * Constrói anexos a partir dos ficheiros do multer e mapeia erros de upload
 * pra resposta HTTP.
 *
 * Migrado de legacy/backend/lib/supportTicketAttachments.ts.
 */
import path from 'node:path';
import type { Response } from 'express';
import type { Express } from 'express';
import { callMiningWorkerUploadSupportAttachment } from '../../mining-engine/services/mining-worker-client.js';
import { SUPPORT_ALLOWED_EXT } from './limits.js';
import type { SupportAttachmentItem } from './mutation.js';

const ORIGINAL_NAME_MAX_LEN = 200;
const MIME_MAX_LEN = 120;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;

export function buildAttachmentsFromFiles(files: Express.Multer.File[] | undefined): { list: SupportAttachmentItem[] } {
  const list: SupportAttachmentItem[] = [];
  const arr = Array.isArray(files) ? files : [];
  for (const f of arr) {
    if (!f?.filename) continue;
    const ext = path.extname(f.filename).toLowerCase();
    if (!SUPPORT_ALLOWED_EXT.has(ext)) continue;
    list.push({
      url: `/img/${f.filename}`,
      originalName: String(f.originalname || f.filename).slice(0, ORIGINAL_NAME_MAX_LEN),
      mime: String(f.mimetype || '').slice(0, MIME_MAX_LEN)
    });
  }
  return { list };
}

export async function pipeSupportFilesToWorker(args: {
  files: Express.Multer.File[] | undefined;
  userId: number;
  namePrefix: 'support' | 'support-reply';
}): Promise<{ list: SupportAttachmentItem[] } | { error: string; code: string; status: number }> {
  const list: SupportAttachmentItem[] = [];
  const arr = Array.isArray(args.files) ? args.files : [];
  for (const f of arr) {
    if (!f?.buffer?.length) continue;
    const ext = path.extname(f.originalname || f.filename || '').toLowerCase();
    if (!SUPPORT_ALLOWED_EXT.has(ext)) continue;
    const out = await callMiningWorkerUploadSupportAttachment({
      buffer: f.buffer,
      originalName: String(f.originalname || f.filename || 'file.bin').slice(0, ORIGINAL_NAME_MAX_LEN),
      mime: String(f.mimetype || '').slice(0, MIME_MAX_LEN),
      userId: args.userId,
      namePrefix: args.namePrefix
    });
    if (!out.ok) {
      return { error: out.error, code: out.code ?? 'UPLOAD', status: out.status };
    }
    list.push({
      url: out.publicUrl,
      originalName: String(f.originalname || out.storedName).slice(0, ORIGINAL_NAME_MAX_LEN),
      mime: String(f.mimetype || '').slice(0, MIME_MAX_LEN)
    });
  }
  return { list };
}

export function sendSupportMulterError(res: Response, err: unknown): void {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FIELD_VALUE' || code === 'LIMIT_PART_COUNT') {
    res.status(HTTP_PAYLOAD_TOO_LARGE).json({
      error: 'One or more files exceed the size limit. Reduce size or send fewer attachments.',
      code: 'PAYLOAD_TOO_LARGE'
    });
    return;
  }
  const msg = err instanceof Error ? err.message : 'Upload error';
  res.status(HTTP_BAD_REQUEST).json({ error: msg || 'Upload error', code: 'UPLOAD' });
}
