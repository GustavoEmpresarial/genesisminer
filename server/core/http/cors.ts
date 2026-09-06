/**
 * Origens CORS permitidas + middleware `cors()` configurado.
 *
 * Migrado de legacy/backend/server.ts (lógica estava inline no bootstrap, ~60 linhas
 * no meio do arquivo de 10k+ linhas). Extraído aqui como peça isolada e testável.
 */
import cors from 'cors';
import type { CorsOptions } from 'cors';

/** Normaliza origem para bater com o header `Origin` do browser (sem barra final). */
function normalizeCorsOrigin(raw: string | null | undefined): string {
  if (raw == null) return '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Origens: FRONTEND_URL/PUBLIC_URL/SITE_URL/VITE_APP_URL (aliases comuns pro mesmo valor),
 * + CORS_ALLOWED_ORIGINS/CORS_EXTRA_ORIGINS (listas separadas por vírgula).
 * Sem lista fixa de domínio hardcoded no código — isso é config de ambiente, não constante.
 */
export function buildCorsOriginSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const set = new Set<string>();
  const add = (o: string | undefined) => {
    const t = normalizeCorsOrigin(o);
    if (t) set.add(t);
  };
  add(env.FRONTEND_URL || env.PUBLIC_URL || env.SITE_URL || env.VITE_APP_URL);
  for (const part of String(env.CORS_ALLOWED_ORIGINS || '').split(',')) add(part);
  for (const part of String(env.CORS_EXTRA_ORIGINS || '').split(',')) add(part);
  return set;
}

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Decide se uma origem é permitida — extraído do `origin` callback do `cors()` pra ser
 * testável sem precisar simular um request HTTP completo.
 */
export function isOriginAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  return allowedOrigins.has(origin);
}

export function buildCorsMiddleware(env: NodeJS.ProcessEnv = process.env) {
  const allowedOrigins = buildCorsOriginSet(env);

  const primary = normalizeCorsOrigin(env.FRONTEND_URL || env.PUBLIC_URL || env.SITE_URL || env.VITE_APP_URL) || '(nenhuma)';
  console.log(
    `[CORS] URL pública: ${primary} | origens permitidas: ${allowedOrigins.size} (FRONTEND_URL, PUBLIC_URL, SITE_URL, VITE_APP_URL, CORS_ALLOWED_ORIGINS, CORS_EXTRA_ORIGINS)`
  );

  const options: CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true);
      console.error('[CORS] origem bloqueada:', origin);
      // `callback(null, [])` = origem negada com resposta preflight válida
      // (evita `callback(Error)` → `next(err)` sem cabeçalhos CORS no erro).
      return callback(null, []);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Edit', 'X-Game-Save-Domain']
  };

  return cors(options);
}
