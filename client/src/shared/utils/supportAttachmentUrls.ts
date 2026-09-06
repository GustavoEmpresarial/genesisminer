const SUPPORT_DL_FILE_RE = /^support(-reply)?-\d+-\d+-[\w.-]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only same-origin `/img/…` or authenticated `/api/support/attachments/download`. */
export function safeSupportAttachmentHref(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || /\s|[\r\n]/.test(s)) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return undefined;
  }
  if (s.startsWith('/img/') && !s.startsWith('//') && !s.includes('://')) return s;
  if (s.startsWith('/api/support/attachments/download?') && !s.startsWith('//') && !s.includes('://')) {
    try {
      const u = new URL(s, 'http://localhost');
      if (u.pathname !== '/api/support/attachments/download') return undefined;
      const file = u.searchParams.get('file');
      if (!file || !SUPPORT_DL_FILE_RE.test(file)) return undefined;
      const ticket = u.searchParams.get('ticket');
      if (ticket != null && ticket !== '' && !UUID_RE.test(ticket)) return undefined;
      return s.split('#')[0];
    } catch {
      return undefined;
    }
  }
  return undefined;
}
