/**
 * Pool `pg` cru — usado onde as rotas ainda não migraram para Prisma (`./prisma.ts`).
 * Mesma config de ligação usada pelos scripts de CLI (`pg_dump`/`pg_restore`/`psql`,
 * hoje em `legacy/backend/config/pgDump.ts`/`pgRestore.ts`/`psql.ts`/`postgresCliPaths.ts`
 * — a migrar para `server/modules/admin/backup/` quando esse módulo for a vez) —
 * fonte única em `buildPoolConfig`.
 *
 * Migrado de legacy/backend/config/db.ts + config/database.ts (fundidos, mesmo comportamento).
 */
import pkg from 'pg';
import type { PoolConfig } from 'pg';

const { Pool } = pkg;

/** Teto/piso de conexões do pool — ajustável via `PG_POOL_MAX`, nunca menor que o mínimo viável nem maior que o razoável pra um Postgres pequeno/médio. */
const POOL_MAX_DEFAULT = 20;
const POOL_MAX_FLOOR = 5;
const POOL_MAX_CEILING = 50;
const POOL_IDLE_TIMEOUT_MS = 30_000;
const POOL_CONNECTION_TIMEOUT_MS = 15_000;
const POSTGRES_DEFAULT_PORT = 5432;

const poolMax = Math.min(
  POOL_MAX_CEILING,
  Math.max(POOL_MAX_FLOOR, parseInt(process.env.PG_POOL_MAX || String(POOL_MAX_DEFAULT), 10) || POOL_MAX_DEFAULT)
);

function trimEnv(value: string | undefined, fallback: string): string {
  const t = String(value ?? '').trim();
  return t || fallback;
}

/** Opções do `pg.Pool` — única fonte de verdade para ligação Postgres (runtime + scripts). */
export function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    return {
      connectionString,
      max: poolMax,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS
    };
  }
  const port = parseInt(process.env.PGPORT || String(POSTGRES_DEFAULT_PORT), 10) || POSTGRES_DEFAULT_PORT;
  return {
    user: trimEnv(process.env.PGUSER, 'postgres'),
    host: trimEnv(process.env.PGHOST, 'localhost'),
    database: trimEnv(process.env.PGDATABASE, 'minestation'),
    password: String(process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'postgres'),
    port,
    max: poolMax,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS
  };
}

const pool = new Pool(buildPoolConfig());

/** Query pontual (pega conexão do pool, roda, devolve — sem transação). */
export const query = (text: string, params?: unknown[]) => pool.query(text, params);

/** Pega uma conexão dedicada do pool — para transações (`BEGIN`/`COMMIT`/
 *  `ROLLBACK`) ou várias queries que precisam da mesma sessão. Quem chama
 *  é responsável por `client.release()`. */
export const getClient = () => pool.connect();

export default pool;
