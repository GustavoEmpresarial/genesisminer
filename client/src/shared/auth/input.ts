/** Sanitização de inputs de auth (anti XSS / controlo). */
export function sanitizeAuthTextInput(value: string): string {
  let v = value;
  try {
    v = decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    /* manter original se inválido */
  }
  v = v.replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF\u2060]/g, '');
  v = v.replace(/[<>'"`\\;{}()[\]]/g, '');
  return v;
}

export function passwordFieldBorder(hasValue: boolean, matches: boolean | null): string {
  if (!hasValue) {
    return 'border-slate-200 dark:border-slate-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500';
  }
  if (matches === null) {
    return 'border-slate-200 dark:border-slate-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500';
  }
  return matches
    ? 'border-emerald-500/70 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500'
    : 'border-red-500/70 focus:border-red-500 focus:ring-1 focus:ring-red-500';
}

/** Remove chars perigosos/espaços e normaliza para minúsculas (paridade com o backend). */
export function sanitizeEmailInput(value: string): string {
  return value.replace(/[<>'"`\\\s]/g, '').toLowerCase();
}
