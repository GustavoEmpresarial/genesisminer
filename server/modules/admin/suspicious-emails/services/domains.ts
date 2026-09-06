/**
 * Listas de domínios de email pra heurística admin (confiáveis / descartáveis).
 * Migrado de legacy/backend/modules/admin/suspiciousEmails/{trustedEmailDomains,disposableEmailDomains}.ts (verbatim).
 */
export const TRUSTED_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me'
] as const;

export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  'mailinator.com',
  'tempmail.com',
  '10minutemail.com',
  'guerrillamail.com',
  'yopmail.com',
  'throwawaymail.com',
  'getnada.com',
  'sharklasers.com',
  'trashmail.com',
  'fakemail.net',
  'maildrop.cc',
  'temp-mail.org',
  'dispostable.com',
  'mailnesia.com',
  'mintemail.com',
  'spam4.me',
  'mailcatch.com',
  'emailondeck.com',
  'moakt.com',
  'tmpmail.net',
  'tempail.com'
] as const;
