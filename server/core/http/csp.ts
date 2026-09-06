/**
 * Content Security Policy + headers de segurança (via `helmet`).
 *
 * Migrado de legacy/backend/server.ts (inline no bootstrap). Correção feita aqui
 * (ver docs/architecture/DECISIONS.md): o `frame-src` do legado liberava
 * `https://blockminer.space` e `https://*.blockminer.space` — domínio de outro
 * projeto, colado por engano (copy-paste). Removido; nenhum iframe deste produto
 * usa esse domínio.
 */
import helmet from 'helmet';

/**
 * Extraído da montagem do `helmet()` para ser testável sem precisar invocar o
 * middleware real (ver `./csp.test.ts` — guarda de regressão do bug do `frame-src`).
 */
export function buildCspDirectives(env: NodeJS.ProcessEnv = process.env): Record<string, string[]> {
  const cspAllowUnsafeEval = env.CSP_ALLOW_UNSAFE_EVAL === '1';
  const cspAllowUnsafeInlineStyles = env.CSP_ALLOW_UNSAFE_INLINE_STYLES !== '0';
  const cspUpgradeInsecure = env.NODE_ENV === 'production';

  return {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      'https://cdn.applixir.com',
      'https://static.cloudflareinsights.com',
      'https://ajax.cloudflare.com',
      'https://challenges.cloudflare.com',
      'https://www.googletagmanager.com',
      'https://www.google-analytics.com',
      'https://*.googletagmanager.com'
    ].concat(cspAllowUnsafeEval ? ["'unsafe-eval'"] : []),
    'connect-src': [
      "'self'",
      'https://cdn.applixir.com',
      'https://*.googleapis.com',
      'https://api.etherscan.io',
      'https://www.google-analytics.com',
      'https://www.googletagmanager.com',
      'https://analytics.google.com',
      'https://region1.google-analytics.com',
      'https://stats.g.doubleclick.net',
      'https://cloudflareinsights.com'
    ],
    'img-src': ["'self'", 'data:', 'https:', 'http:'],
    'style-src': ["'self'", 'https://fonts.googleapis.com'].concat(
      cspAllowUnsafeInlineStyles ? ["'unsafe-inline'"] : []
    ),
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'frame-src': ["'self'", 'https://cdn.applixir.com', 'https://challenges.cloudflare.com', 'https://zerads.com'],
    'object-src': ["'none'"],
    ...(cspUpgradeInsecure ? { 'upgrade-insecure-requests': [] } : {})
  };
}

export function buildSecurityHeadersMiddleware(env: NodeJS.ProcessEnv = process.env) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: buildCspDirectives(env)
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
  });
}
