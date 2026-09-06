/**
 * Merge newly picked support attachment files with size / count guards.
 */
export function mergeSupportPicks(
  prev: File[],
  incoming: FileList | null,
  maxCount: number,
  maxBytes: number,
  tooLargeTpl: (name: string, mb: number) => string,
  tooManyTpl?: (max: number) => string
): { next: File[]; rejectReason: string | null } {
  const next = [...prev];
  let rejectReason: string | null = null;
  if (!incoming?.length) return { next, rejectReason };
  let truncatedByCount = false;
  for (let i = 0; i < incoming.length; i++) {
    if (next.length >= maxCount) {
      truncatedByCount = true;
      break;
    }
    const f = incoming.item(i);
    if (!f || f.size <= 0) continue;
    if (f.size > maxBytes) {
      rejectReason = tooLargeTpl(f.name, Math.floor(maxBytes / (1024 * 1024)));
      continue;
    }
    next.push(f);
  }
  if (truncatedByCount && !rejectReason && tooManyTpl) {
    rejectReason = tooManyTpl(maxCount);
  }
  return { next, rejectReason };
}
