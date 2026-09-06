/**
 * Composition root do Express: middlewares globais (CORS, body limits, resolução de
 * sessão, guard de modo gerência) + todas as rotas migradas.
 *
 * Migrado de legacy/backend/server.ts (ordem de `app.use` preservada) — a diferença é
 * que aqui cada peça já vinha de um módulo próprio (`core/http/cors.ts`,
 * `modules/auth/services/http-auth.ts`, `modules/gerente/services/guard.ts`); isto só
 * as liga na ordem certa. Os estáticos de `/img` são servidos por genesis-api
 * (`rust/genesis-api/src/img.rs`), que nunca faz proxy desse prefixo para o Express.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import pool from '../core/database/pool.js';
import { buildApiRateLimitMiddleware, buildCorsMiddleware, buildIpRateLimiter, parseCookies, parseRateLimit } from '../core/http/index.js';
import { MS_PER_HOUR } from '../shared/utils/time.js';
import { createResolveAuthMiddleware } from '../modules/auth/index.js';
import { createManagerModeGuard } from '../modules/gerente/index.js';
import { buildAppDeps, type AppDeps } from './deps.js';
import { registerAllRoutes } from './routes.js';
import { buildStampedSpaIndex } from './spa-build-stamp.js';
import { createRequestIdMiddleware, createSlowRequestLogger, registerHealthRoutes } from '../core/ops/index.js';

const AUTH_BODY_LIMIT = '2kb';
const DEFAULT_BODY_LIMIT = '5mb';
const AUTH_RATE_LIMIT_DEFAULT = 15;
const AUTH_RATE_LIMIT_MIN = 5;
const AUTH_RATE_LIMIT_MAX = 1000;

/** Rotas de autenticação levam um corpo minúsculo (previne abuso de memória/ReDoS). */
const AUTH_BODY_LIMIT_PATHS = ['/api/login', '/api/user', '/api/request-password-reset', '/api/reset-password-secure', '/api/verify-recovery-wallet', '/api/request-email-verification', '/api/verify-email'];

/**
 * Monta o `Express` completo (middlewares globais + todas as rotas) e o
 * devolve junto com `deps` (útil pra quem sobe o server em `server.ts`, que
 * precisa de `deps.uploadsDir` pro cron de TTL de chat). Não chama
 * `app.listen(...)` — isso é responsabilidade de `startServer` em `./server.ts`,
 * pra este arquivo poder ser testado sem abrir porta de rede.
 */
export function buildApp(): { app: Express; deps: AppDeps } {
  const app = express();
  const deps = buildAppDeps();

  // Health antes do gate de shutdown / tracking HTTP (liveness durante drain).
  registerHealthRoutes(app);
  app.use(createRequestIdMiddleware());
  app.use(createSlowRequestLogger());

  app.use(buildCorsMiddleware());
  app.use('/api/', buildApiRateLimitMiddleware());
  app.use(
    '/api/login',
    buildIpRateLimiter({
      windowMs: MS_PER_HOUR,
      max: parseRateLimit(process.env.AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_DEFAULT, AUTH_RATE_LIMIT_MIN, AUTH_RATE_LIMIT_MAX),
      normalizeIpKey: true,
      message: 'Too many login attempts. Please try again later.'
    })
  );

  const authBodyLimit = express.json({ limit: AUTH_BODY_LIMIT });
  for (const p of AUTH_BODY_LIMIT_PATHS) app.use(p, authBodyLimit);

  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: DEFAULT_BODY_LIMIT, extended: true }));

  const jwtAllowLegacySession = process.env.JWT_ALLOW_LEGACY_SESSION === '1' && process.env.JWT_ALLOW_LEGACY_SID === '1';
  app.use(createResolveAuthMiddleware({ parseCookies, allowLegacySession: jwtAllowLegacySession }));
  app.use(createManagerModeGuard({ pool, parseCookies }));

  const CGI_BIN_RE = /\/cgi-bin\b/i;
  const HTTP_NOT_FOUND = 404;
  app.use((req, res, next) => {
    if (CGI_BIN_RE.test(req.url || '')) {
      res.status(HTTP_NOT_FOUND).end();
      return;
    }
    next();
  });

  registerAllRoutes(app, deps);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const clientDist = path.join(repoRoot, 'client', 'dist');
  const spaIndex = path.join(clientDist, 'index.html');
  if (fs.existsSync(spaIndex)) {
    // Selo lido uma vez: o bundle é imutável durante a vida do contentor.
    const { html: stampedIndexHtml } = buildStampedSpaIndex(fs.readFileSync(spaIndex, 'utf8'));
    const sendSpaIndex = (res: express.Response): void => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, no-transform');
      res.type('html').send(stampedIndexHtml);
    };

    app.get(['/', '/index.html'], (_req, res) => sendSpaIndex(res));
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, absPath) {
          if (absPath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        }
      })
    );
    app.get('*', (req, res, next) => {
      const p = req.path || '';
      if (p.startsWith('/api') || p.startsWith('/img') || p.startsWith('/socket.io')) {
        next();
        return;
      }
      // Asset hashed em /assets/*: nunca devolver index.html (senão CDN cacheia HTML como CSS/JS).
      if (p.startsWith('/assets/')) {
        res.status(HTTP_NOT_FOUND).type('text/plain').send('Not found');
        return;
      }
      sendSpaIndex(res);
    });
  }

  app.use((_req, res) => {
    res.status(HTTP_NOT_FOUND).json({ error: 'Route not found.' });
  });

  return { app, deps };
}
