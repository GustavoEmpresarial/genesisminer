/**
 * Configuração central JWT (variáveis de ambiente). Em produção exige `JWT_SECRET`
 * com entropia mínima — nunca cai num fallback fraco silencioso fora de dev.
 *
 * Migrado de legacy/backend/src/auth/config.ts (sem mudança de comportamento).
 */
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR;

const JWT_ACCESS_TTL_DEFAULT_MINUTES = 15;
const JWT_ACCESS_TTL_DEFAULT_SEC = JWT_ACCESS_TTL_DEFAULT_MINUTES * SECONDS_PER_MINUTE;
const JWT_ACCESS_TTL_FLOOR_SEC = SECONDS_PER_MINUTE;
const JWT_ACCESS_TTL_CEILING_SEC = SECONDS_PER_HOUR;

const JWT_REFRESH_TTL_DEFAULT_DAYS = 14;
const JWT_REFRESH_TTL_DEFAULT_SEC = JWT_REFRESH_TTL_DEFAULT_DAYS * SECONDS_PER_DAY;
const JWT_REFRESH_TTL_FLOOR_SEC = SECONDS_PER_HOUR;
const JWT_REFRESH_TTL_CEILING_DAYS = 60;
const JWT_REFRESH_TTL_CEILING_SEC = JWT_REFRESH_TTL_CEILING_DAYS * SECONDS_PER_DAY;

const PROD_JWT_SECRET_MIN_LENGTH = 32;
const DEV_FALLBACK_JWT_SECRET = 'dev-only-jwt-secret-do-not-use-in-production-min-32-chars!';

export type JwtAuthConfig = {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSec: number;
  refreshTtlSec: number;
};

export function getJwtAuthConfig(): JwtAuthConfig {
  const secret = String(process.env.JWT_SECRET || '').trim();
  const issuer = String(process.env.JWT_ISSUER || 'genesis-miner').trim();
  const audience = String(process.env.JWT_AUDIENCE || 'genesis-miner-api').trim();
  const accessTtl = Math.min(
    Math.max(
      parseInt(String(process.env.JWT_ACCESS_TTL_SEC || String(JWT_ACCESS_TTL_DEFAULT_SEC)), 10) ||
        JWT_ACCESS_TTL_DEFAULT_SEC,
      JWT_ACCESS_TTL_FLOOR_SEC
    ),
    JWT_ACCESS_TTL_CEILING_SEC
  );
  const refreshTtl = Math.min(
    Math.max(
      parseInt(String(process.env.JWT_REFRESH_TTL_SEC || String(JWT_REFRESH_TTL_DEFAULT_SEC)), 10) ||
        JWT_REFRESH_TTL_DEFAULT_SEC,
      JWT_REFRESH_TTL_FLOOR_SEC
    ),
    JWT_REFRESH_TTL_CEILING_SEC
  );
  const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (prod && secret.length < PROD_JWT_SECRET_MIN_LENGTH) {
    throw new Error(`[JWT] Em produção defina JWT_SECRET com pelo menos ${PROD_JWT_SECRET_MIN_LENGTH} characters.`);
  }
  const effectiveSecret = secret || (prod ? '' : DEV_FALLBACK_JWT_SECRET);
  if (!effectiveSecret) {
    throw new Error('[JWT] JWT_SECRET em falta.');
  }
  if (!prod && !secret) {
    console.warn('[JWT] JWT_SECRET não definido — a usar segredo de desenvolvimento (não usar em produção).');
  }
  return {
    secret: effectiveSecret,
    issuer,
    audience,
    accessTtlSec: accessTtl,
    refreshTtlSec: refreshTtl
  };
}

export const COOKIE_ACCESS = 'gm_access';
export const COOKIE_REFRESH = 'gm_refresh';
