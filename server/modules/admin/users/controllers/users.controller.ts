/**
 * Rotas da aba Usuários sob `/api/admin` — **todas** portadas para genesis-api
 * (`admin_users` + mining-worker). Este controlador já não regista HTTP;
 * mantém só o rate-limit helper (usado por testes / ops) e a documentação do
 * contrato.
 *
 * Portados:
 * - `GET /api/admin/users/:userId/wallet-history`
 * - `PUT /api/admin/users/:userId/rooms`
 * - `POST /api/admin/impersonate` / `POST /api/admin/stop-impersonate`
 * - `POST /api/admin/users/:userId/save-game-override` (já antes)
 * - `GET/POST /api/admin/referral-models` + `DELETE /api/admin/referral-models/:id`
 * - `GET/POST /api/admin/access-level-referral-assignments`
 * - `GET /api/admin/accounts-dormant-mining`
 *
 * Leftovers fora do prefixo `/api/admin` também no genesis-api:
 * `GET /api/users`, `PUT /api/users/block`, `PUT /api/user`, `DELETE /api/user/:email`,
 * `GET /api/game-state/:email`.
 *
 * Serviços (`wallet-history`, `impersonate`, `owned-rooms`, `admin-game-state`)
 * ficam como referência de contrato / testes unitários.
 */
import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { parseRateLimit } from '../../../../core/http/rate-limit.js';

export type AdminUsersModuleDeps = {
  isAdmin: RequestHandler;
  authenticateToken: RequestHandler;
  pool: Pool;
  parseCookies: (req: import('express').Request) => Record<string, string>;
  issueJwtAuthCookies: (
    res: import('express').Response,
    userId: number,
    req: import('express').Request
  ) => Promise<void>;
};

/**
 * SPA admin dispara várias rotas sob o mesmo `usersLimiter` por perfil
 * (lista, game-state, wallet-history, etc.). Default 120/min esgotava ao abrir
 * tickets em sequência. Ajustável via `ADMIN_USERS_RATE_LIMIT_MAX`.
 */
export const ADMIN_USERS_RATE_LIMIT_DEFAULT = 600;
export const ADMIN_USERS_RATE_LIMIT_FLOOR = 120;
export const ADMIN_USERS_RATE_LIMIT_CEILING = 5000;

export function resolveAdminUsersRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  return parseRateLimit(
    env.ADMIN_USERS_RATE_LIMIT_MAX,
    ADMIN_USERS_RATE_LIMIT_DEFAULT,
    ADMIN_USERS_RATE_LIMIT_FLOOR,
    ADMIN_USERS_RATE_LIMIT_CEILING
  );
}

/** No-op: rotas admin users sob `/api/admin` vivem no genesis-api. */
export function registerAdminUsersModuleRoutes(_app: Express, _deps: AdminUsersModuleDeps): void {
  /* routes owned by genesis-api `admin_users` */
}
