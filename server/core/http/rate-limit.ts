/**
 * Rate limit global de `/api` por IP.
 *
 * Migrado de legacy/backend/server.ts (inline no bootstrap). Rate limit específico
 * por rota (ex.: auth) fica no módulo dono da rota, não aqui — este é só o limite
 * de piso global.
 */
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';
import { getClientIpFromRequest } from './client-ip.js';
import { MS_PER_MINUTE } from '../../shared/utils/time.js';

/** Clamp com fallback — extraído para ser testável isoladamente. */
export function parseRateLimit(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Loopback nunca conta no limite (chamadas internas, healthcheck, etc.). */
export function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
}

const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE;
const API_RATE_LIMIT_DEFAULT = 20_000;
const API_RATE_LIMIT_FLOOR = 5_000;
const API_RATE_LIMIT_CEILING = 250_000;

/**
 * O SPA faz várias chamadas em paralelo a cada 10–15s; IPs partilhados (CGNAT, café,
 * escritório) somam no mesmo bucket — piso baixo bloqueava utilizadores legítimos.
 * Ajustável via `API_RATE_LIMIT_MAX`.
 */
export function buildApiRateLimitMiddleware(env: NodeJS.ProcessEnv = process.env) {
  const apiRateLimitMax = parseRateLimit(
    env.API_RATE_LIMIT_MAX,
    API_RATE_LIMIT_DEFAULT,
    API_RATE_LIMIT_FLOOR,
    API_RATE_LIMIT_CEILING
  );

  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: apiRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIpFromRequest(req),
    skip: (req) => isLoopbackIp(getClientIpFromRequest(req)),
    message: { error: 'Too many requests from this IP. Please try again later.' },
    validate: { trustProxy: true }
  });
}

/**
 * Fábrica de rate limiter por IP para limites específicos por rota — todo limiter do
 * legado (`server.ts`) repetia o mesmo boilerplate (`standardHeaders`/`legacyHeaders`/
 * `skip` localhost/`validate.trustProxy`) copiado 10x com só janela/máximo/mensagem
 * mudando. `bootstrap/rate-limiters.ts` só declara os parâmetros que variam.
 */
export type IpRateLimiterOptions = {
  windowMs: number;
  max: number;
  message: string;
  /** Chave por IP "cru" (default) ou normalizada via `ipKeyGenerator` (recomendado para janelas longas/auth). */
  normalizeIpKey?: boolean;
  /** Sufixo extra na chave (ex.: `userId` para limites por IP+utilizador). */
  extraKeySuffix?: (req: Request) => string;
};

export function buildIpRateLimiter(opts: IpRateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ip = opts.normalizeIpKey ? ipKeyGenerator(getClientIpFromRequest(req)) : getClientIpFromRequest(req);
      return opts.extraKeySuffix ? `${ip}:${opts.extraKeySuffix(req)}` : ip;
    },
    skip: (req) => isLoopbackIp(getClientIpFromRequest(req)),
    message: { error: opts.message },
    validate: { trustProxy: true }
  });
}
