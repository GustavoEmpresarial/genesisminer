/**
 * Middlewares/handlers HTTP de autenticação: resolução de sessão (JWT + legado `sid`),
 * emissão/renovação de cookies JWT, exigência de access token válido.
 *
 * Migrado de legacy/backend/src/auth/httpAuth.ts. Ajustes de import apenas:
 * `prisma` vem de `core/database/prisma.ts`, `sendIfPrismaHttpError` de
 * `shared/errors/prisma-errors.ts` (ver docs/architecture/DECISIONS.md #1 — nunca `dist/`).
 */
import type { NextFunction, Request, Response } from 'express';
import { sendIfPrismaHttpError } from '../../../shared/errors/prisma-errors.js';
import { COOKIE_ACCESS, COOKIE_REFRESH } from './config.js';
import { signAccessToken, verifyAccessToken } from './jwt-service.js';
import { issueRefreshToken, revokeAllRefreshForUser, rotateRefreshToken } from './refresh-token-store.js';
import { appendAccessCookie, appendRefreshCookie, clearAuthCookies } from './cookies.js';
import { writeJwtRefreshSnapshot } from './storage-mirror.js';
import { findActiveSessionUserId } from '../models/repository.js';
import {
  AUTH_WORKER_UNAVAILABLE_BODY,
  authWorkerInfraHttpStatus,
  classifyAuthWorkerError
} from './auth-worker-client.js';

export type ParseCookiesFn = (req: Request) => Record<string, string>;

/** Lê um cookie nomeado a partir do parser injetado (evita depender de `cookie-parser` global). */
export function readCookie(parseCookies: ParseCookiesFn, req: Request, name: string): string | null {
  const c = parseCookies(req);
  return c[name] || null;
}

export type ResolveAuthDeps = {
  parseCookies: ParseCookiesFn;
  allowLegacySession?: boolean;
};

const JWT_IGNORED_ERROR_NAMES = ['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'];

/**
 * Resolve utilizador: 1) access JWT válido 2) opcionalmente sessão legacy `sid`.
 * Ordem permite access curto + refresh; impersonação via sid remove cookies JWT no servidor.
 */
export function createResolveAuthMiddleware({ parseCookies, allowLegacySession = true }: ResolveAuthDeps) {
  return async function resolveAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    req.userId = undefined;
    req.auth = undefined;

    const accessRaw = readCookie(parseCookies, req, COOKIE_ACCESS);
    if (accessRaw) {
      try {
        const v = await verifyAccessToken(accessRaw);
        req.userId = v.userId;
        req.auth = { kind: 'jwt', jti: v.jti, exp: v.exp };
        return next();
      } catch (e: unknown) {
        const name = e instanceof Error ? e.name : '';
        if (!JWT_IGNORED_ERROR_NAMES.includes(name)) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn('[JWT] Validação access:', name, msg);
        }
      }
    }

    if (!allowLegacySession) {
      next();
      return;
    }

    const sid = parseCookies(req).sid;
    if (sid) {
      try {
        const sidUserId = await findActiveSessionUserId(sid);
        if (sidUserId) {
          req.userId = sidUserId;
          req.auth = { kind: 'session' };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const kind = classifyAuthWorkerError(msg);
        if (kind) {
          res.status(authWorkerInfraHttpStatus(kind)).json(AUTH_WORKER_UNAVAILABLE_BODY);
          return;
        }
        console.warn('[JWT] Sessão legacy:', msg);
      }
    }
    next();
  };
}

/**
 * Emite o par de cookies JWT (access + refresh) para `userId` após login bem-sucedido.
 * Revoga TODOS os refresh tokens anteriores do utilizador antes de emitir o novo par
 * (uma única sessão de refresh "família" ativa por vez — login novo invalida sessões
 * JWT antigas, mesmo em outros dispositivos). Express aplica Set-Cookie; o worker
 * gera o refresh raw + TTL. Não lança se a escrita do espelho em disco falhar
 * (`writeJwtRefreshSnapshot` é best-effort).
 */
export async function issueJwtAuthCookies(res: Response, userId: number, req: Request): Promise<void> {
  await revokeAllRefreshForUser(userId);
  const issued = await issueRefreshToken({
    userId,
    userAgent: (req.headers['user-agent'] as string | undefined) || null,
    ip: req.ip || req.socket?.remoteAddress || null
  });
  const signed = await signAccessToken(userId);
  appendAccessCookie(res, signed.token, signed.expiresInSec);
  appendRefreshCookie(res, issued.refreshToken, issued.expiresInSec);
  await writeJwtRefreshSnapshot();
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/**
 * `POST /api/auth/refresh`: troca o refresh token (cookie `gm_refresh`) por um novo
 * par access+refresh, rotacionando o token em `refresh-token-store.ts`. Em qualquer
 * falha (token em falta, inválido, revogado ou expirado) limpa os cookies de auth —
 * força o cliente a autenticar de novo em vez de ficar com cookies obsoletos.
 */
export async function handleJwtRefresh(
  req: Request,
  res: Response,
  parseCookies: ParseCookiesFn
): Promise<Response | void> {
  const raw = readCookie(parseCookies, req, COOKIE_REFRESH);
  if (!raw) {
    clearAuthCookies(res);
    return res.status(HTTP_UNAUTHORIZED).json({ error: 'Refresh token missing.', code: 'AUTH_REFRESH_MISSING' });
  }
  try {
    const rotated = await rotateRefreshToken(raw, {
      userAgent: (req.headers['user-agent'] as string | undefined) || null,
      ip: req.ip || req.socket?.remoteAddress || null
    });
    if (!rotated.ok) {
      clearAuthCookies(res);
      return res.status(HTTP_UNAUTHORIZED).json({
        error:
          rotated.code === 'expired' ? 'Session expired. Please sign in again.' : 'Invalid or revoked refresh token.',
        code: 'AUTH_REFRESH_INVALID'
      });
    }
    const signed = await signAccessToken(rotated.userId);
    appendAccessCookie(res, signed.token, signed.expiresInSec);
    appendRefreshCookie(res, rotated.newRefreshRaw, rotated.expiresInSec);
    await writeJwtRefreshSnapshot();
    return res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = classifyAuthWorkerError(msg);
    if (kind) {
      clearAuthCookies(res);
      return res.status(authWorkerInfraHttpStatus(kind)).json(AUTH_WORKER_UNAVAILABLE_BODY);
    }
    console.error('[JWT] /auth/refresh:', e);
    if (sendIfPrismaHttpError(res, e, 'POST /api/auth/refresh')) return;
    clearAuthCookies(res);
    return res.status(HTTP_INTERNAL_SERVER_ERROR).json({ error: 'Could not renew session.', code: 'AUTH_REFRESH_ERROR' });
  }
}

/** Revoga todos os refresh tokens do utilizador (logout, troca de senha, etc.) e atualiza o espelho em disco. */
export async function revokeJwtRefreshForUser(userId: number): Promise<void> {
  await revokeAllRefreshForUser(userId);
  await writeJwtRefreshSnapshot();
}

/** Resposta 401 padronizada para rotas que exigem autenticação. */
export function sendAuthUnauthorized(res: Response, message = 'Not authenticated.', code = 'AUTH_REQUIRED'): void {
  res.status(HTTP_UNAUTHORIZED).json({ error: message, code });
}

/**
 * Guarda simples: exige que `req.userId` já esteja resolvido (por `createResolveAuthMiddleware`
 * montado globalmente antes das rotas — mesmo desenho do legado, `server.ts`). Não resolve
 * cookies sozinho; é só o "se não tem sessão, 401" que cada rota autenticada usa.
 */
export function createAuthenticateTokenMiddleware() {
  return function authenticateToken(req: Request, res: Response, next: NextFunction): void {
    if (req.userId != null) {
      next();
      return;
    }
    res.status(HTTP_UNAUTHORIZED).json({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
  };
}

export type RequireJwtAccessDeps = { parseCookies: ParseCookiesFn };

/**
 * Exige JWT de acesso válido (rejeita apenas sessão sid) — usar em rotas de máxima exigência.
 */
export function createRequireJwtAccessMiddleware({ parseCookies }: RequireJwtAccessDeps) {
  return async function requireJwtAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    const raw = readCookie(parseCookies, req, COOKIE_ACCESS);
    if (!raw) {
      sendAuthUnauthorized(res, 'Token de acesso em falta.', 'AUTH_ACCESS_MISSING');
      return;
    }
    try {
      const v = await verifyAccessToken(raw);
      req.userId = v.userId;
      req.auth = { kind: 'jwt', jti: v.jti, exp: v.exp };
      next();
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TokenExpiredError') {
        sendAuthUnauthorized(res, 'Access token expirado. Utilize POST /api/auth/refresh.', 'AUTH_ACCESS_EXPIRED');
        return;
      }
      sendAuthUnauthorized(res, 'Access token inválido.', 'AUTH_ACCESS_INVALID');
    }
  };
}
