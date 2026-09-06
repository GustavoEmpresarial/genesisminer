/**
 * Valida nomes de ficheiro guardados por multer e reescreve URLs de anexo
 * para download autenticado (`GET /api/support/attachments/download`).
 *
 * Migrado de legacy/backend/modules/support/supportAttachmentsProxy.ts.
 */
import type { SupportAttachmentItem } from './mutation.js';

/** Nome guardado por multer: `support-{uid}-…` ou `support-reply-{uid}-…`. */
const SUPPORT_STORED_RE = /^(support|support-reply)-\d+-\d+-[\w.-]+$/i;

export function isSafeSupportStoredFilename(name: string): boolean {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('..') || n.includes('\0')) return false;
  return SUPPORT_STORED_RE.test(n);
}

/** Extrai o nome do ficheiro guardado a partir de `/img/…`. */
export function storedNameFromImgUrl(url: string): string | null {
  const s = String(url || '').trim();
  if (!s.startsWith('/img/')) return null;
  const name = s.slice('/img/'.length).split('?')[0].split('/').filter(Boolean).pop();
  if (!name || !SUPPORT_STORED_RE.test(name)) return null;
  return name;
}

/** `support-{userId}-…` enviado pelo jogador pertence ao utilizador. */
export function supportStoredFileOwnedByUser(storedName: string, userId: number): boolean {
  const m = String(storedName).match(/^support-(\d+)-/i);
  if (!m) return false;
  return Number(m[1]) === Number(userId);
}

export function isSupportReplyStoredName(storedName: string): boolean {
  return /^support-reply-\d+-/i.test(String(storedName));
}

/**
 * Liga anexos a download autenticado. Para `support-reply-*` (equipa) é obrigatório `ticketPublicId`.
 */
export function rewriteSupportAttachmentsForPlayerDownload(
  userId: number,
  ticketPublicId: string | null,
  list: SupportAttachmentItem[]
): SupportAttachmentItem[] {
  return list.map((a) => {
    const sn = storedNameFromImgUrl(a.url);
    if (!sn) return a;
    const owned = supportStoredFileOwnedByUser(sn, userId);
    const staffReply = isSupportReplyStoredName(sn);
    if (!owned && !staffReply) return a;
    if (staffReply && !ticketPublicId) return a;
    const parts = [`file=${encodeURIComponent(sn)}`];
    if (ticketPublicId) parts.push(`ticket=${encodeURIComponent(ticketPublicId)}`);
    return { ...a, url: `/api/support/attachments/download?${parts.join('&')}` };
  });
}
