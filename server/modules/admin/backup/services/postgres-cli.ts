/**
 * Localização do binário `pg_dump` + opções de `spawn` alinhadas com a ligação
 * Postgres real (`core/database/pool.ts:buildPoolConfig`) — sem concatenar
 * credenciais na shell, credenciais só via env do processo filho.
 *
 * Migrado de legacy/backend/config/{postgresCliPaths,pgDump,database}.ts —
 * só a parte usada por `pg_dump` (criação de backup). `psql`/`pg_restore`
 * (restore) ficam de fora — ver corte de escopo em
 * `../controllers/backup.controller.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

function trimEnv(value: string | undefined, fallback: string): string {
  const t = String(value ?? '').trim();
  return t || fallback;
}

const POSTGRES_DEFAULT_PORT = 5432;
const UNIX_PG_BIN_DIRS = ['/usr/bin', '/usr/local/bin'];
const POSTGRESQL_VERSIONED_ROOT = '/usr/lib/postgresql';
const MAX_SAFE_UNIX_PATH_LENGTH = 512;
const SAFE_UNIX_PATH_RE = /^[/a-zA-Z0-9._+-]+$/;

/** Caminho absoluto seguro (sem `..` nem caracteres de shell). */
function isSafeAbsUnixPath(p: string): boolean {
  if (!p || p.length > MAX_SAFE_UNIX_PATH_LENGTH || !p.startsWith('/') || p.includes('..')) return false;
  return SAFE_UNIX_PATH_RE.test(p);
}

/**
 * Resolve `pg_dump` em Linux/macOS: `PG_DUMP_PATH` (ficheiro absoluto existente),
 * `POSTGRES_CLIENT_BIN` (directório com o binário), ou locais típicos
 * (`/usr/bin`, `/usr/local/bin`, `/usr/lib/postgresql/<versão>/bin`).
 */
function resolveUnixPgDumpPath(): string | null {
  const rawFile = process.env.PG_DUMP_PATH;
  if (typeof rawFile === 'string' && rawFile.trim()) {
    const t = rawFile.trim();
    if (isSafeAbsUnixPath(t) && fs.existsSync(t) && path.basename(t) === 'pg_dump') return t;
  }
  const rawDir = process.env.POSTGRES_CLIENT_BIN?.trim();
  if (rawDir && isSafeAbsUnixPath(rawDir)) {
    const joined = path.join(rawDir, 'pg_dump');
    if (fs.existsSync(joined)) return joined;
  }
  for (const dir of UNIX_PG_BIN_DIRS) {
    const joined = path.join(dir, 'pg_dump');
    if (fs.existsSync(joined)) return joined;
  }
  try {
    const versions = fs
      .readdirSync(POSTGRESQL_VERSIONED_ROOT)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const joined = path.join(POSTGRESQL_VERSIONED_ROOT, v, 'bin', 'pg_dump');
      if (fs.existsSync(joined)) return joined;
    }
  } catch {
    /* ignora — pasta versionada não existe neste ambiente */
  }
  return null;
}

const KNOWN_WINDOWS_PG_DUMP_PATHS = [
  'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\13\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\12\\bin\\pg_dump.exe',
  'C:\\Program Files (x86)\\PostgreSQL\\18\\bin\\pg_dump.exe',
  'C:\\Program Files (x86)\\PostgreSQL\\17\\bin\\pg_dump.exe'
] as const;

export function getPgDumpPath(): string {
  if (process.platform === 'win32') {
    for (const p of KNOWN_WINDOWS_PG_DUMP_PATHS) {
      if (fs.existsSync(p)) return p;
    }
    return 'pg_dump';
  }
  return resolveUnixPgDumpPath() ?? 'pg_dump';
}

/** Opções alinhadas para `spawn` de `pg_dump` (sem concatenar credenciais na shell). */
export type PgCliSpawnOptions =
  | { useConnectionString: true; databaseUrl: string; extraEnv: Record<string, string> }
  | { useConnectionString: false; databaseUrl: null; extraEnv: Record<string, string>; host: string; port: string; user: string; database: string };

/** Para `pg_dump` CLI: env e ligação alinhados a `core/database/pool.ts:buildPoolConfig`. */
export function getPostgresCliSpawnOptions(): PgCliSpawnOptions {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return { useConnectionString: true, databaseUrl, extraEnv: {} };
  }
  const password = String(process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'postgres');
  return {
    useConnectionString: false,
    databaseUrl: null,
    extraEnv: { PGPASSWORD: password },
    host: trimEnv(process.env.PGHOST, 'localhost'),
    port: String(parseInt(process.env.PGPORT || String(POSTGRES_DEFAULT_PORT), 10) || POSTGRES_DEFAULT_PORT),
    user: trimEnv(process.env.PGUSER, 'postgres'),
    database: trimEnv(process.env.PGDATABASE, 'minestation')
  };
}
