/**
 * Validação server-side de avisos no jogo (popup) — fonte de verdade, nunca
 * confiar no frontend nem no body cru.
 *
 * Migrado de legacy/backend/validation/inAppAnnouncementValidation.ts — só
 * `assertImageFileMagicBytes` não migrou (upload em disco fora deste módulo).
 * Renomeado com o módulo em DECISIONS.md #59.
 */
import { MS_PER_DAY } from '../../../shared/utils/time.js';

// eslint-disable-next-line no-control-regex -- uso deliberado: sanitização de texto precisa justamente destes caracteres de controle, não é regex acidental.
const CTRL_AND_C1 = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

const ZERO_WIDTH_SPACE_START = 0x200b;
const ZERO_WIDTH_SPACE_END = 0x200d;
const ZERO_WIDTH_NO_BREAK_SPACE = 0xfeff;
const BIDI_MARK_START = 0x202a;
const BIDI_MARK_END = 0x202e;
// Zero-width (U+200B–U+200D, U+FEFF) + marcas bidi (U+202A–U+202E), via fromCharCode
// pra evitar corrupção de escape \uXXXX em regex literal (mesmo achado de safe-text.ts).
const ZW_AND_BIDI = new RegExp(
  `[${String.fromCharCode(ZERO_WIDTH_SPACE_START)}-${String.fromCharCode(ZERO_WIDTH_SPACE_END)}${String.fromCharCode(ZERO_WIDTH_NO_BREAK_SPACE)}${String.fromCharCode(BIDI_MARK_START)}-${String.fromCharCode(BIDI_MARK_END)}]`,
  'g'
);
const DANGEROUS_SCHEME = /^(javascript|data|vbscript)\s*:/i;
const DANGEROUS_TAG = /<script/i;

export const TITLE_MAX = 120;
export const MESSAGE_MAX = 4000;
export const LINK_MAX = 2048;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 1000;
export const PENDING_MAX = 20;
const YEARS_FOR_SCHEDULE_WINDOW = 2;
const DAYS_PER_YEAR = 365;
const SCHEDULE_MAX_DAYS = YEARS_FOR_SCHEDULE_WINDOW * DAYS_PER_YEAR;
export const SCHEDULE_MAX_MS = SCHEDULE_MAX_DAYS * MS_PER_DAY;
const SCHEDULE_MS_UPPER_BOUND = 9_000_000_000_000;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Paths relativos seguros para imagens de avisos (só upload interno em /img/uploads/ ou /img/ad-*). */
export const SAFE_ANNOUNCEMENT_IMAGE_PATH_RE = /^\/img\/(?:uploads\/[a-zA-Z0-9._-]+|ad-[0-9]+-[0-9a-zA-Z]+)\.(png|jpe?g|gif|webp)$/i;

export class AnnouncementValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION'
  ) {
    super(message);
    this.name = 'AnnouncementValidationError';
  }
}

function stripPlainText(raw: unknown, maxLen: number): string {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw new AnnouncementValidationError('Campo de texto inválido.');
  let s = raw.replace(ZW_AND_BIDI, '').replace(CTRL_AND_C1, ' ').trim();
  if (DANGEROUS_SCHEME.test(s) || DANGEROUS_TAG.test(s)) {
    throw new AnnouncementValidationError('Conteúdo de texto não permitido.');
  }
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

export function parsePlainTitle(raw: unknown): string {
  const s = stripPlainText(raw, TITLE_MAX);
  if (!s) throw new AnnouncementValidationError('Título é obrigatório.');
  return s;
}

export function parsePlainMessage(raw: unknown): string {
  const s = stripPlainText(raw, MESSAGE_MAX);
  if (!s) throw new AnnouncementValidationError('Mensagem é obrigatória.');
  return s;
}

export function parseOptionalHttpsLink(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new AnnouncementValidationError('Link inválido.');
  const t = raw.trim();
  if (!t) return null;
  if (t.length > LINK_MAX) throw new AnnouncementValidationError('Link demasiado longo.');
  if (DANGEROUS_SCHEME.test(t)) throw new AnnouncementValidationError('Link não permitido.');
  let u: URL;
  try {
    const withProto = /^https:\/\//i.test(t) ? t : null;
    if (!withProto) throw new AnnouncementValidationError('Link deve usar HTTPS.');
    u = new URL(withProto);
  } catch (e) {
    if (e instanceof AnnouncementValidationError) throw e;
    throw new AnnouncementValidationError('Link inválido.');
  }
  if (u.protocol !== 'https:') throw new AnnouncementValidationError('Link deve usar HTTPS.');
  if (u.username || u.password) throw new AnnouncementValidationError('Link não permitido.');
  if (!u.hostname) throw new AnnouncementValidationError('Link inválido.');
  return u.href.slice(0, LINK_MAX);
}

export function parseOptionalSelfImagePath(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new AnnouncementValidationError('Imagem inválida.');
  const t = raw.trim();
  if (!t) return null;
  if (t.includes('..') || t.includes('//') || /^https?:/i.test(t) || /^data:/i.test(t) || /^\/\//.test(t)) {
    throw new AnnouncementValidationError('URL de imagem não permitida.', 'INVALID_IMAGE_URL');
  }
  const normalized = t.startsWith('/img/') ? t : t.startsWith('img/') ? `/${t}` : null;
  if (!normalized || !SAFE_ANNOUNCEMENT_IMAGE_PATH_RE.test(normalized)) {
    throw new AnnouncementValidationError('Imagem deve ser um ficheiro em /img/ (upload interno).', 'INVALID_IMAGE_URL');
  }
  return normalized;
}

export function parsePriority(raw: unknown): number {
  const DEFAULT_PRIORITY = 0;
  if (raw == null || raw === '') return DEFAULT_PRIORITY;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_PRIORITY;
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.trunc(n)));
}

export function parseOptionalScheduleMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > SCHEDULE_MS_UPPER_BOUND) {
    throw new AnnouncementValidationError('Data de agendamento inválida.');
  }
  return Math.trunc(n);
}

export function parseIsActive(raw: unknown, defaultActive = true): boolean {
  if (raw === undefined || raw === null) return defaultActive;
  if (typeof raw === 'boolean') return raw;
  if (raw === 0 || raw === '0' || raw === false) return false;
  if (raw === 1 || raw === '1' || raw === true) return true;
  return defaultActive;
}

export function validateScheduleRange(startsAt: number | null, endsAt: number | null): void {
  if (startsAt != null && endsAt != null && endsAt < startsAt) {
    throw new AnnouncementValidationError('Data de fim deve ser posterior ao início.');
  }
  const now = Date.now();
  if (startsAt != null && endsAt != null && endsAt - startsAt > SCHEDULE_MAX_MS) {
    throw new AnnouncementValidationError('Intervalo de agendamento demasiado longo.');
  }
  if (endsAt != null && endsAt < now - SCHEDULE_MAX_MS) {
    throw new AnnouncementValidationError('Data de fim inválida.');
  }
}

export function parseAnnouncementId(raw: unknown): string {
  const id = String(raw || '').trim();
  if (!id || !UUID_V4_RE.test(id)) {
    throw new AnnouncementValidationError('Invalid announcement identifier.');
  }
  return id.toLowerCase();
}

export type ValidatedCreateAnnouncement = {
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
  priority: number;
  isActive: boolean;
  startsAt: number | null;
  endsAt: number | null;
};

export type ValidatedUpdateAnnouncement = Partial<ValidatedCreateAnnouncement>;

export function parseCreateInput(body: Record<string, unknown>): ValidatedCreateAnnouncement {
  const title = parsePlainTitle(body.title);
  const message = parsePlainMessage(body.message);
  const link = parseOptionalHttpsLink(body.link);
  const imageUrl = parseOptionalSelfImagePath(body.imageUrl ?? body.image_url);
  const priority = parsePriority(body.priority);
  const isActive = parseIsActive(body.isActive ?? body.is_active, true);
  const startsAt = parseOptionalScheduleMs(body.startsAt ?? body.starts_at);
  const endsAt = parseOptionalScheduleMs(body.endsAt ?? body.ends_at);
  validateScheduleRange(startsAt, endsAt);
  return { title, message, link, imageUrl, priority, isActive, startsAt, endsAt };
}

export function parseUpdateInput(body: Record<string, unknown>): ValidatedUpdateAnnouncement {
  const out: ValidatedUpdateAnnouncement = {};
  if (body.title !== undefined) out.title = parsePlainTitle(body.title);
  if (body.message !== undefined) out.message = parsePlainMessage(body.message);
  if (body.link !== undefined) out.link = parseOptionalHttpsLink(body.link);
  if (body.imageUrl !== undefined || body.image_url !== undefined) {
    out.imageUrl = parseOptionalSelfImagePath(body.imageUrl ?? body.image_url);
  }
  if (body.priority !== undefined) out.priority = parsePriority(body.priority);
  if (body.isActive !== undefined || body.is_active !== undefined) {
    out.isActive = parseIsActive(body.isActive ?? body.is_active, true);
  }
  let startsAt: number | null | undefined;
  let endsAt: number | null | undefined;
  if (body.startsAt !== undefined || body.starts_at !== undefined) {
    startsAt = parseOptionalScheduleMs(body.startsAt ?? body.starts_at);
    out.startsAt = startsAt;
  }
  if (body.endsAt !== undefined || body.ends_at !== undefined) {
    endsAt = parseOptionalScheduleMs(body.endsAt ?? body.ends_at);
    out.endsAt = endsAt;
  }
  if (startsAt !== undefined || endsAt !== undefined) {
    validateScheduleRange(startsAt ?? null, endsAt ?? null);
  }
  return out;
}
