import {
  isAllowedSupportAttachmentExt,
  supportAttachmentExt
} from './supportAccept';

/**
 * Merge newly picked support attachment files with size / count / type guards.
 */
function filesFromIncoming(incoming: FileList | readonly File[] | null): File[] {
  if (!incoming) return [];
  if ('item' in incoming) {
    const out: File[] = [];
    for (let i = 0; i < incoming.length; i++) {
      const f = incoming.item(i);
      if (f) out.push(f);
    }
    return out;
  }
  return incoming.slice();
}

export function mergeSupportPicks(
  prev: File[],
  incoming: FileList | readonly File[] | null,
  maxCount: number,
  maxBytes: number,
  minBytes: number,
  tooLargeTpl: (name: string, mb: number) => string,
  tooManyTpl?: (max: number) => string,
  typeNotAllowedTpl?: (name: string) => string,
  tooSmallTpl?: (name: string) => string
): { next: File[]; rejectReason: string | null } {
  const next = [...prev];
  let rejectReason: string | null = null;
  const picked = filesFromIncoming(incoming);
  if (picked.length === 0) return { next, rejectReason };
  let truncatedByCount = false;
  for (let i = 0; i < picked.length; i++) {
    if (next.length >= maxCount) {
      truncatedByCount = true;
      break;
    }
    const f = picked[i];
    if (!f) continue;
    if (f.size > maxBytes) {
      rejectReason = tooLargeTpl(f.name, Math.floor(maxBytes / (1024 * 1024)));
      continue;
    }
    if (f.size < minBytes) {
      rejectReason = tooSmallTpl
        ? tooSmallTpl(f.name)
        : `«${f.name}» ficheiro inválido ou vazio.`;
      continue;
    }
    const ext = supportAttachmentExt(f.name);
    if (!isAllowedSupportAttachmentExt(ext)) {
      rejectReason = typeNotAllowedTpl
        ? typeNotAllowedTpl(f.name)
        : `«${f.name}» tipo não permitido.`;
      continue;
    }
    next.push(f);
  }
  if (truncatedByCount && !rejectReason && tooManyTpl) {
    rejectReason = tooManyTpl(maxCount);
  }
  return { next, rejectReason };
}
