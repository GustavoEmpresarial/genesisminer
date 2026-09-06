/**
 * Cookies HttpOnly + SameSite=Strict (mitigação a XSS e CSRF entre sites).
 *
 * Migrado de legacy/backend/src/auth/cookies.ts (sem mudança de comportamento).
 */
import type { Response } from 'express';
import { COOKIE_ACCESS, COOKIE_REFRESH } from './config.js';

function isSecureEnv(): boolean {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/** `www.genesisdao.tech` → `genesisdao.tech` (label + TLD). */
const REGISTRABLE_DOMAIN_LABELS = 2;

/** Partilha sessão entre apex e www (ex. `Domain=.genesisdao.tech`). Vazio = host-only. */
export function resolveCookieDomainAttribute(): string {
  const explicit = String(process.env.COOKIE_DOMAIN || '').trim();
  if (explicit) {
    return `Domain=${explicit.startsWith('.') ? explicit : `.${explicit}`}`;
  }
  const base = String(
    process.env.FRONTEND_URL || process.env.PUBLIC_URL || process.env.SITE_URL || ''
  ).trim();
  if (!base) return '';
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return '';
    const labels = host.split('.').filter(Boolean);
    if (labels.length >= REGISTRABLE_DOMAIN_LABELS) {
      return `Domain=.${labels.slice(-REGISTRABLE_DOMAIN_LABELS).join('.')}`;
    }
  } catch {
    /* ignore */
  }
  return '';
}

export function buildSetCookieHeader(
  name: string,
  value: string,
  { maxAgeSec, path = '/' }: { maxAgeSec?: number; path?: string }
): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${path}`,
    resolveCookieDomainAttribute()
  ].filter(Boolean);
  if (isSecureEnv()) parts.push('Secure');
  if (maxAgeSec != null && Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
  return parts.join('; ');
}

const CLEAR_COOKIE_MAX_AGE = 0;

export function buildClearCookieHeader(name: string, path = '/'): string {
  const parts = [
    `${name}=`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${path}`,
    `Max-Age=${CLEAR_COOKIE_MAX_AGE}`,
    resolveCookieDomainAttribute()
  ].filter(Boolean);
  if (isSecureEnv()) parts.push('Secure');
  return parts.join('; ');
}

/** Cookie `sid` legado (SameSite=Lax) — emitido no login e limpo no logout. */
export function buildLegacySessionCookieHeader(sid: string, maxAgeSec: number): string {
  const parts = [
    `sid=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    resolveCookieDomainAttribute()
  ].filter(Boolean);
  if (isSecureEnv()) parts.push('Secure');
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
  return parts.join('; ');
}

export function buildClearLegacySessionCookieHeader(): string {
  return buildLegacySessionCookieHeader('', CLEAR_COOKIE_MAX_AGE);
}

export function appendAccessCookie(res: Response, accessToken: string, maxAgeSec: number): void {
  res.append('Set-Cookie', buildSetCookieHeader(COOKIE_ACCESS, accessToken, { maxAgeSec, path: '/' }));
}

export function appendRefreshCookie(res: Response, refreshToken: string, maxAgeSec: number): void {
  res.append('Set-Cookie', buildSetCookieHeader(COOKIE_REFRESH, refreshToken, { maxAgeSec, path: '/' }));
}

export function clearAuthCookies(res: Response): void {
  res.append('Set-Cookie', buildClearCookieHeader(COOKIE_ACCESS, '/'));
  res.append('Set-Cookie', buildClearCookieHeader(COOKIE_REFRESH, '/'));
}
