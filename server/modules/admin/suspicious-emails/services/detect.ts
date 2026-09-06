/**
 * Heurísticas de email suspeito (formato, domínio, padrões conhecidos de email fake).
 * Migrado de legacy/backend/modules/admin/suspiciousEmails/suspiciousEmailDetect.ts (verbatim).
 */
import { DISPOSABLE_EMAIL_DOMAINS, TRUSTED_EMAIL_DOMAINS } from './domains.js';

export const SUSPICIOUS_EMAIL_REASON_CODES = [
  'invalid_format',
  'temporary_domain',
  'fake_pattern',
  'duplicate_email',
  'unverified_email',
  'suspicious_domain',
  'domain_not_trusted',
  'never_mined',
  'zero_hash',
  'no_wallet',
  'no_deposit',
  'referral_only',
  'inactive_account',
  'no_game_progress',
  'dead_account'
] as const;

export type SuspiciousEmailReasonCode = (typeof SUSPICIOUS_EMAIL_REASON_CODES)[number];

const DISPOSABLE_SET = new Set(DISPOSABLE_EMAIL_DOMAINS.map((d) => d.toLowerCase()));
const TRUSTED_SET = new Set(TRUSTED_EMAIL_DOMAINS.map((d) => d.toLowerCase()));

/** Domínios que imitam provedores conhecidos (typos) — motivo `fake_pattern`. */
const PROVIDER_TYPO_DOMAINS = new Set(
  ['gmai.com', 'gmial.com', 'gmal.com', 'gmail.con', 'gmaill.com', 'hotmial.com', 'outlok.com', 'outlookk.com', 'yahooo.com', 'protonmai.com', 'protonmaill.com', 'iclod.com', 'icloud.co'].map((d) =>
    d.toLowerCase()
  )
);

/** Emails exactos (lower) — reutilizado na pré-selecção SQL. */
export const FAKE_EXACT_EMAILS_LIST: readonly string[] = [
  'test@test.com',
  'fake@fake.com',
  'a@a.com',
  '123@123.com',
  'email@email.com',
  'user@example.com',
  'admin@admin.com',
  'xxx@xxx.com',
  'test@example.com',
  'user@test.com',
  'sample@sample.com',
  'demo@demo.com',
  'foo@foo.com',
  'bar@bar.com'
];

const FAKE_EXACT_EMAILS = new Set(FAKE_EXACT_EMAILS_LIST);

const EXAMPLE_DOMAIN_SUFFIXES = ['@example.com', '@example.org', '@example.net', '@test.com', '@localhost'];

const SUSPICIOUS_LOCAL_PREFIXES = ['no-reply', 'noreply', 'mailer-daemon', 'postmaster', 'donotreply', 'do-not-reply'];

const RARE_TLDS = new Set(['tk', 'ml', 'ga', 'cf', 'gq', 'xyz', 'top', 'work', 'click', 'link', 'zip', 'mov']);

const HIGH_DOMAIN_DIGIT_RATIO = 0.55;
const MIN_DOMAIN_LEN_FOR_DIGIT_HEURISTIC = 6;
const MAX_DOMAIN_LEN_FOR_DIGIT_HEURISTIC = 22;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MIN_TLD_LENGTH = 2;
const MAX_TLD_LENGTH = 24;
const SUSPICIOUS_DOMAIN_LENGTH_THRESHOLD = 40;
const RARE_TLD_MAX_LENGTH = 3;
const ASCII_SPACE = 32;
const ASCII_TAB = 9;
const ASCII_LF = 10;
const ASCII_CR = 13;
const ASCII_AT = 64;
const ASCII_LOWER_A = 97;
const ASCII_LOWER_Z = 122;
const ASCII_UPPER_A = 65;
const ASCII_UPPER_Z = 90;
const ASCII_DIGIT_0 = 48;
const ASCII_DIGIT_9 = 57;

/** Normaliza email para comparação: `trim` + `toLowerCase`. `null`/`undefined` → `''`. */
export function normalizeEmail(email: string | null | undefined): string {
  if (email == null) return '';
  return String(email).trim().toLowerCase();
}

/** Extrai o domínio (parte após `@`, minúsculo) de um email; `null` se não houver `@` válido ou domínio vazio. */
export function getEmailDomain(email: string | null | undefined): string | null {
  if (email == null) return null;
  const t = normalizeEmail(email);
  const at = t.indexOf('@');
  if (at < 0 || at === t.length - 1) return null;
  const dom = t.slice(at + 1).trim();
  return dom.length > 0 ? dom : null;
}

/** `true` se o domínio (case-insensitive) está em `TRUSTED_EMAIL_DOMAINS`. */
export function isTrustedEmailDomain(domainLower: string | null | undefined): boolean {
  if (!domainLower) return false;
  return TRUSTED_SET.has(domainLower.trim().toLowerCase());
}

/** `true` se o domínio (case-insensitive) está em `DISPOSABLE_EMAIL_DOMAINS` (provedores de email descartável). */
export function isTemporaryEmailDomain(domainLower: string): boolean {
  if (!domainLower) return false;
  return DISPOSABLE_SET.has(domainLower.trim().toLowerCase());
}

/**
 * Validação de formato de email própria (sem regex de RFC5322 completa) — checa:
 * comprimento máximo, ausência de whitespace, exactamente um `@`, local/domínio
 * não vazios, local até `MAX_LOCAL_PART_LENGTH`, domínio com `.`, TLD alfanumérico
 * de `MIN_TLD_LENGTH..MAX_TLD_LENGTH` chars. Não valida existência do domínio (DNS).
 */
export function isInvalidEmailFormat(email: string | null | undefined): boolean {
  if (email == null) return true;
  const raw = String(email);
  if (raw.length > MAX_EMAIL_LENGTH) return true;
  const t = raw.trim();
  if (t.length === 0) return true;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === ASCII_SPACE || c === ASCII_TAB || c === ASCII_LF || c === ASCII_CR) return true;
  }
  let atCount = 0;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) === ASCII_AT) atCount++;
  }
  if (atCount !== 1) return true;
  const at = t.indexOf('@');
  const local = t.slice(0, at);
  const domain = t.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return true;
  if (local.length > MAX_LOCAL_PART_LENGTH) return true;
  if (domain.indexOf('.') < 0) return true;
  const lastDot = domain.lastIndexOf('.');
  if (lastDot < 0 || lastDot >= domain.length - 1) return true;
  const tld = domain.slice(lastDot + 1).toLowerCase();
  if (tld.length < MIN_TLD_LENGTH || tld.length > MAX_TLD_LENGTH) return true;
  for (let i = 0; i < tld.length; i++) {
    const c = tld.charCodeAt(i);
    const ok = (c >= ASCII_LOWER_A && c <= ASCII_LOWER_Z) || (c >= ASCII_UPPER_A && c <= ASCII_UPPER_Z) || (c >= ASCII_DIGIT_0 && c <= ASCII_DIGIT_9);
    if (!ok) return true;
  }
  return false;
}

/** Inverso de `isInvalidEmailFormat` — açúcar sintático para consumidores fora deste módulo. */
export function isValidEmailFormat(email: string | null | undefined): boolean {
  return !isInvalidEmailFormat(email);
}

/** `true` se o domínio é um typo conhecido de um provedor confiável (ex. `gmial.com`). */
export function isProviderTypoDomain(domainLower: string | null | undefined): boolean {
  if (!domainLower) return false;
  return PROVIDER_TYPO_DOMAINS.has(domainLower.trim().toLowerCase());
}

/**
 * Heurística combinada de "email claramente fake": domínio typo de provedor,
 * email exacto em `FAKE_EXACT_EMAILS_LIST`, domínio `example.*`/`test.com`/
 * `localhost`, prefixo local de sistema (`no-reply`, `postmaster`, ...), ou
 * combinações óbvias (`admin@admin.com`, `test@test.com`, `user@user.com`).
 */
export function isFakeEmailPattern(email: string | null | undefined): boolean {
  if (email == null) return false;
  const t = normalizeEmail(email);
  if (!t) return false;
  const dom = getEmailDomain(email);
  if (dom && isProviderTypoDomain(dom)) return true;
  if (FAKE_EXACT_EMAILS.has(t)) return true;
  for (const suf of EXAMPLE_DOMAIN_SUFFIXES) {
    if (t.endsWith(suf)) return true;
  }
  const at = t.indexOf('@');
  if (at <= 0) return false;
  const local = t.slice(0, at);
  const domain = t.slice(at + 1);
  for (const p of SUSPICIOUS_LOCAL_PREFIXES) {
    if (local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}+`)) return true;
  }
  if (local === 'admin' && domain === 'admin.com') return true;
  if (local === 'test' && domain === 'test.com') return true;
  if (local === 'user' && domain === 'user.com') return true;
  return false;
}

function countDigits(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= ASCII_DIGIT_0 && c <= ASCII_DIGIT_9) n++;
  }
  return n;
}

/**
 * Heurística de "domínio com cara de spam" sem lista fixa: domínio muito longo
 * (`>= SUSPICIOUS_DOMAIN_LENGTH_THRESHOLD`), TLD raro/curto conhecido por spam
 * (`RARE_TLDS`), ou proporção alta de dígitos no nome do domínio (indício de
 * domínio gerado automaticamente).
 */
export function isSuspiciousDomainHeuristic(domainLower: string): boolean {
  if (!domainLower) return false;
  const d = domainLower.trim().toLowerCase();
  if (d.length >= SUSPICIOUS_DOMAIN_LENGTH_THRESHOLD) return true;
  const lastDot = d.lastIndexOf('.');
  if (lastDot > 0 && lastDot < d.length - 1) {
    const tld = d.slice(lastDot + 1);
    if (tld.length <= RARE_TLD_MAX_LENGTH && RARE_TLDS.has(tld)) return true;
  }
  if (d.length >= MIN_DOMAIN_LEN_FOR_DIGIT_HEURISTIC && d.length <= MAX_DOMAIN_LEN_FOR_DIGIT_HEURISTIC) {
    const digits = countDigits(d);
    if (digits > 0 && digits / d.length >= HIGH_DOMAIN_DIGIT_RATIO) return true;
  }
  return false;
}

export type DetectSuspiciousEmailContext = {
  duplicateNormalizedEmails?: ReadonlySet<string>;
  domainTotalCounts?: ReadonlyMap<string, number>;
  highVolumeDomainThreshold?: number;
  emailVerified?: boolean | null;
  /** Se omitido, usa `TRUSTED_EMAIL_DOMAINS`. */
  trustedDomains?: ReadonlySet<string>;
};

const DEFAULT_HIGH_VOLUME = 8;

function trustedSet(ctx: DetectSuspiciousEmailContext): ReadonlySet<string> {
  return ctx.trustedDomains ?? TRUSTED_SET;
}

/** Motivos ligados ao endereço de email (formato, domínio, duplicados). */
export function detectSuspiciousEmail(email: string | null | undefined, ctx: DetectSuspiciousEmailContext = {}): SuspiciousEmailReasonCode[] {
  const reasons: SuspiciousEmailReasonCode[] = [];
  const push = (r: SuspiciousEmailReasonCode) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  if (isInvalidEmailFormat(email)) {
    push('invalid_format');
    return reasons;
  }

  const dom = getEmailDomain(email);
  if (!dom) {
    push('invalid_format');
    return reasons;
  }

  const dLower = dom.toLowerCase();

  if (isProviderTypoDomain(dLower)) {
    push('fake_pattern');
  }

  if (isTemporaryEmailDomain(dLower)) {
    push('temporary_domain');
  }

  if (isFakeEmailPattern(email)) {
    push('fake_pattern');
  }

  const norm = normalizeEmail(email);
  if (norm && ctx.duplicateNormalizedEmails?.has(norm)) {
    push('duplicate_email');
  }

  if (ctx.emailVerified === false) {
    push('unverified_email');
  }

  if (isSuspiciousDomainHeuristic(dLower)) {
    push('suspicious_domain');
  }

  const thr = ctx.highVolumeDomainThreshold ?? DEFAULT_HIGH_VOLUME;
  if (ctx.domainTotalCounts) {
    const c = ctx.domainTotalCounts.get(dLower) ?? 0;
    if (c >= thr && (isTemporaryEmailDomain(dLower) || isSuspiciousDomainHeuristic(dLower) || isFakeEmailPattern(email))) {
      push('suspicious_domain');
    }
  }

  const tset = trustedSet(ctx);
  if (!isTemporaryEmailDomain(dLower) && !isProviderTypoDomain(dLower) && !tset.has(dLower)) {
    push('domain_not_trusted');
  }

  return reasons;
}

export { TRUSTED_EMAIL_DOMAINS } from './domains.js';
