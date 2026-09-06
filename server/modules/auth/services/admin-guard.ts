/**
 * Middleware `isAdmin` real — até aqui todo módulo só recebia `isAdmin: RequestHandler`
 * como dependência injetada, sem implementação (ver docs/architecture/DECISIONS.md, item
 * pendente `utils/adminRouteAuth.ts`). Resolve utilizador (JWT/sessão legacy, reaproveitando
 * `createResolveAuthMiddleware`), verifica `is_admin`, e aplica o mapeamento de permissões
 * por aba (`shared/security/admin-route-auth.ts`).
 *
 * Migrado de legacy/backend/server.ts (`isAdmin`, `loadAdminGateContext`, `isIpFromUser`).
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../../core/database/prisma.js';
import { getClientIpFromRequest } from '../../../core/http/client-ip.js';
import { allowsAdminRouteAccess, permissionTabSetFromDbJson, resolveAdminRouteRequirement } from '../../../shared/security/admin-route-auth.js';
import { createResolveAuthMiddleware, type ParseCookiesFn } from './http-auth.js';
import { resolveIsSuperAdminFromUserRow } from './super-admin.js';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

export type AdminGateContext = { isSuperAdmin: boolean; tabSet: Set<string>; rawAdminPermissions: unknown };

export async function loadAdminGateContext(userId: number): Promise<AdminGateContext | null> {
  try {
    const row = await prisma.users.findUnique({
      where: { id: userId },
      select: { is_admin: true, is_super_admin: true, admin_permissions: true }
    });
    if (!row || !row.is_admin) return null;
    let parsedPm: unknown = null;
    try {
      parsedPm = row.admin_permissions ? JSON.parse(row.admin_permissions) : null;
    } catch {
      parsedPm = null;
    }
    return {
      isSuperAdmin: resolveIsSuperAdminFromUserRow(row),
      tabSet: permissionTabSetFromDbJson(parsedPm),
      rawAdminPermissions: parsedPm
    };
  } catch (e) {
    console.error('[loadAdminGateContext]', e);
    return null;
  }
}

export async function isIpFromUser(ip: string): Promise<boolean> {
  try {
    const hit = await prisma.user_history_ips.findFirst({ where: { ip }, select: { user_id: true } });
    return hit != null;
  } catch {
    return false;
  }
}

async function logAdminAccessAttempt(req: Request, ip: string, details: string): Promise<void> {
  if (req.url.includes('/api/admin/dashboard-stats') || req.url.includes('/api/system/time')) return;
  try {
    await prisma.admin_access_logs.create({
      data: {
        ip,
        attempted_url: req.originalUrl || req.url,
        user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        details,
        created_at: BigInt(Date.now())
      }
    });
  } catch (e) {
    console.error('[AdminAudit] Failed to log:', e instanceof Error ? e.message : String(e));
  }
}

export type IsAdminMiddlewareDeps = { parseCookies: ParseCookiesFn };

/**
 * Auto-suficiente: resolve `req.userId` mesmo se nenhum middleware de auth correu antes
 * (mesmo comportamento do legado — `isAdmin` nunca dependia de `authenticateToken` já ter
 * corrido, várias rotas montavam só `isAdmin` diretamente).
 */
export function createIsAdminMiddleware({ parseCookies }: IsAdminMiddlewareDeps) {
  const resolveAuth = createResolveAuthMiddleware({ parseCookies });

  return async function isAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ip = getClientIpFromRequest(req);

    try {
      if (req.userId == null) {
        await new Promise<void>((resolve) => {
          void resolveAuth(req, res, () => resolve());
        });
      }

      if (req.userId == null) {
        const fromUser = await isIpFromUser(ip);
        await logAdminAccessAttempt(req, ip, `No session cookie provided. IsKnownUser: ${fromUser}`);
        res.status(HTTP_UNAUTHORIZED).json({ error: 'Not authenticated' });
        return;
      }

      const ctx = await loadAdminGateContext(req.userId);
      if (!ctx) {
        await logAdminAccessAttempt(req, ip, `User ID ${req.userId} attempted admin access without admin flag`);
        res.status(HTTP_FORBIDDEN).json({ error: 'Access denied' });
        return;
      }

      req.isSuperAdmin = ctx.isSuperAdmin;
      req.adminPermissions = ctx.rawAdminPermissions;

      const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
      const rule = resolveAdminRouteRequirement(req.method || 'GET', pathOnly);
      if (!allowsAdminRouteAccess(ctx.isSuperAdmin, ctx.tabSet, rule)) {
        await logAdminAccessAttempt(req, ip, `Permissão admin negada: user=${req.userId} path=${pathOnly}`);
        res.status(HTTP_FORBIDDEN).json({ error: 'Permissão insuficiente para esta operação.' });
        return;
      }

      next();
    } catch (e) {
      console.error('[isAdmin] Internal Error:', e);
      res.status(HTTP_INTERNAL_SERVER_ERROR).json({ error: 'Erro interno' });
    }
  };
}
