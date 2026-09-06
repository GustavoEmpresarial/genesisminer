/**
 * Migrado de legacy/backend/modules/account-manager/accountManager.allowlist.ts (verbatim).
 */
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { isAccountManagerEnabled } from './feature.js';
import { loadSessionManagerFlags } from './manager.js';

export type ParseCookiesFn = (req: Request) => Record<string, string>;

const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_FORBIDDEN = 403;

/**
 * Rotas permitidas quando `sessions.manager_mode = 1`.
 * Método + path (Express `req.path` sem query; pode vir com ou sem prefixo /api).
 */
const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/session\/?$/ },
  { method: 'POST', pattern: /^\/api\/logout\/?$/ },
  { method: 'POST', pattern: /^\/api\/auth\/refresh\/?$/ },
  { method: 'GET', pattern: /^\/api\/bootstrap\/?$/ },
  { method: 'GET', pattern: /^\/api\/checkin(\/status)?\/?$/ },
  { method: 'POST', pattern: /^\/api\/checkin\/?$/ },
  // Tarefas diárias/semanais (claim recompensa USDC na conta gerida)
  { method: 'POST', pattern: /^\/api\/quests\/claim\/?$/ },
  // Merge Station
  { method: 'POST', pattern: /^\/api\/merge\/execute\/?$/ },
  { method: 'POST', pattern: /^\/api\/server-room\/room-coins\/?$/ },
  // Estrutura: montar / desmontar rigs
  { method: 'POST', pattern: /^\/api\/servers\/racks\/place\/?$/ },
  { method: 'POST', pattern: /^\/api\/servers\/racks\/[^/]+\/remove\/?$/ },
  // Máquinas: montar / desmontar miners (GPUs/ASICs)
  { method: 'POST', pattern: /^\/api\/servers\/racks\/[^/]+\/miners\/(equip|unequip)\/?$/ },
  // Auxiliares da rig (bateria / fiação / multiplicador) — necessários ao montar operação
  { method: 'POST', pattern: /^\/api\/servers\/racks\/[^/]+\/aux\/(equip|unequip)\/?$/ },
  { method: 'GET', pattern: /^\/api\/servers(\/state|\/snapshot)?\/?$/ },
  { method: 'GET', pattern: /^\/api\/my-rig-rooms(\/[^/]+)?\/?$/ },
  { method: 'GET', pattern: /^\/api\/inventory(\/(state|me|snapshot))?\/?$/ },
  { method: 'GET', pattern: /^\/api\/mining(-coins|\/coins)\/?$/ },
  { method: 'GET', pattern: /^\/api\/me\/(upgrade-shop-bundle|profile-bundle)\/?$/ },
  { method: 'GET', pattern: /^\/api\/game\/(state|load|header)\/?$/ },
  { method: 'POST', pattern: /^\/api\/game\/(load|sync)\/?$/ },
  { method: 'GET', pattern: /^\/api\/game-state(\/[^/]+)?\/?$/ },
  { method: 'GET', pattern: /^\/api\/player\/(calculator|game-header)\/?$/ },
  { method: 'GET', pattern: /^\/api\/calculator\/me\/?$/ },
  { method: 'GET', pattern: /^\/api\/account-manager\/me\/?$/ },
  { method: 'POST', pattern: /^\/api\/account-manager\/leave\/?$/ },
  { method: 'POST', pattern: /^\/api\/account-manager\/enter\/?$/ },
  { method: 'POST', pattern: /^\/api\/account-manager\/resign\/?$/ },
  // Fechar aviso (botão "Li") — senão o modal fica preso em modo gerência
  { method: 'POST', pattern: /^\/api\/announcements\/[^/]+\/dismiss\/?$/ },
  { method: 'POST', pattern: /^\/api\/in-app-announcements\/[^/]+\/dismiss\/?$/ }, // alias legado
  { method: 'GET', pattern: /^\/api\/news\/?$/ },
  { method: 'GET', pattern: /^\/api\/dashboard(\/.*)?$/ },
  { method: 'GET', pattern: /^\/api\/access-levels\/?$/ },
  { method: 'GET', pattern: /^\/api\/economy(\/settings)?\/?$/ },
  { method: 'GET', pattern: /^\/api\/announcements(\/.*)?$/ },
  { method: 'GET', pattern: /^\/api\/in-app-announcements(\/.*)?$/ }, // alias legado
  // Settings / catálogos usados pela UI de /servers (evita 403 em modo gerência)
  { method: 'GET', pattern: /^\/api\/system\/time\/?$/ },
  { method: 'GET', pattern: /^\/api\/web3-settings\/?$/ },
  { method: 'GET', pattern: /^\/api\/monetization-settings\/?$/ },
  { method: 'GET', pattern: /^\/api\/upgrades(\/.*)?$/ },
  { method: 'GET', pattern: /^\/api\/mini-blog(\/.*)?$/ },
  { method: 'GET', pattern: /^\/api\/lucky-boxes(\/.*)?$/ },
  // Lootbox (compra / abrir / descartar / promocode) — permitido em modo gerência
  { method: 'POST', pattern: /^\/api\/lucky-boxes\/purchase\/?$/ },
  { method: 'POST', pattern: /^\/api\/lucky-boxes\/open\/?$/ },
  { method: 'POST', pattern: /^\/api\/lucky-boxes\/discard\/?$/ },
  { method: 'POST', pattern: /^\/api\/lucky-boxes\/promocodes\/redeem\/?$/ }
];

function requestPath(req: Request): string {
  return String(req.originalUrl || req.url || req.path || '').split('?')[0] || '/';
}

/** Só restringe `/api/*`. SPA, assets e páginas (ex.: `/management`) passam sempre. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function normalizeApiPath(path: string): string {
  return path.startsWith('/api/') || path === '/api' ? path : path.startsWith('/') ? `/api${path}` : `/api/${path}`;
}

/**
 * Em modo gerência:
 * - GET: permite leituras da UI (catálogos, settings, estado), bloqueia `/api/admin/*`
 * - mutações: só a allowlist explícita (check-in, quests claim, merge, moeda de farm, equip/unequip, leave…)
 */
export function isManagerAllowedRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = normalizeApiPath(path);
  if (m === 'GET') {
    if (/^\/api\/admin(\/|$)/.test(p)) return false;
    return true;
  }
  return ALLOWED.some((a) => a.method === m && a.pattern.test(p));
}

/**
 * Depois de `resolveAuth`: se a sessão está em manager_mode, bloqueia rotas `/api/*` fora da allowlist.
 * Pedidos fora de `/api` (SPA / static) não são bloqueados — senão `/management` virava JSON 403.
 * Popula `req.managerMode`, `req.managerUserId`, `req.actingAsOwnerId`.
 */
export function createManagerModeGuard(deps: { pool: Pool; parseCookies: ParseCookiesFn }) {
  const { pool, parseCookies } = deps;
  return async function managerModeGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    req.managerMode = false;
    req.managerUserId = undefined;
    req.actingAsOwnerId = undefined;

    try {
      const sid = parseCookies(req).sid || null;
      const flags = await loadSessionManagerFlags(pool, sid);
      if (!flags.managerMode) {
        next();
        return;
      }

      req.managerMode = true;
      req.managerUserId = flags.managerUserId ?? undefined;
      req.actingAsOwnerId = flags.actingAsOwnerId ?? undefined;

      const path = requestPath(req);
      if (!isApiPath(path)) {
        next();
        return;
      }

      // Feature off: só auth + leave (evita ficar preso em manager_mode na PROD desligada).
      if (!isAccountManagerEnabled()) {
        const escapeOk = [/^\/api\/account-manager\/leave\/?$/, /^\/api\/logout\/?$/, /^\/api\/auth\/refresh\/?$/, /^\/api\/session\/?$/, /^\/api\/bootstrap\/?$/].some((re) => re.test(path));
        if (escapeOk) {
          next();
          return;
        }
        res.status(HTTP_SERVICE_UNAVAILABLE).json({ error: 'Account management is disabled in this environment.', code: 'ACCOUNT_MANAGER_DISABLED' });
        return;
      }

      if (isManagerAllowedRoute(req.method, path)) {
        next();
        return;
      }

      res.status(HTTP_FORBIDDEN).json({
        error: 'In manager mode you can only check in, do quests, merge, offerwall, change farm coin, and mount/unmount rigs and machines.',
        code: 'MANAGER_FORBIDDEN'
      });
    } catch (e) {
      console.error('[gerente] guard', e);
      next();
    }
  };
}
