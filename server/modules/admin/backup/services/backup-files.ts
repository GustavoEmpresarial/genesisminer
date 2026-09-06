/**
 * Diretório de backups, caminhos seguros (sem path traversal), `pg_dump` pro
 * disco, e poda dos backups automáticos mais antigos.
 *
 * Migrado de legacy/backend/models/backupModel.ts — só a parte de criação/
 * listagem/poda. `RESTORE_ALLOWED_TABLES`/`isSafeSqlIdentifier`/
 * `isLikelyPlainSqlDumpFile`/`runPsqlRestoreFile` (usadas só pelo restore)
 * ficam de fora — ver corte de escopo em `../controllers/backup.controller.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getPgDumpPath, getPostgresCliSpawnOptions } from './postgres-cli.js';

/** Ficheiros gerados pelo job automático diário (para rotação por idade). */
export const AUTO_SQL_BACKUP_PREFIX = 'auto_pgdump_';
const DEFAULT_AUTO_BACKUP_KEEP_COUNT = 14;
const AUTO_BACKUP_KEEP_MIN = 1;
const AUTO_BACKUP_KEEP_MAX = 500;

/**
 * Destino canónico: `storage/backups` relativo ao cwd (`/app/storage/backups` no Docker).
 * `BACKUP_DIR` (absoluto ou relativo) sobrepõe o default — compatibilidade para
 * quem ainda aponta para `../backups`.
 */
export const DEFAULT_BACKUP_DIR_SEGMENTS = ['storage', 'backups'] as const;

export function ensureBackupDir(): string {
  const raw = process.env.BACKUP_DIR && String(process.env.BACKUP_DIR).trim();
  const dir = raw ? path.resolve(raw) : path.resolve(process.cwd(), ...DEFAULT_BACKUP_DIR_SEGMENTS);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* idempotente */
  }
  return dir;
}

export function getBackupDir(): string {
  return ensureBackupDir();
}

/** Caminho absoluto dentro do diretório de backups (evita path traversal). */
export function resolveSafeBackupPath(filename: unknown, backupDir: string = getBackupDir()): string | null {
  const base = path.resolve(backupDir);
  const safeName = path.basename(String(filename ?? ''));
  if (!safeName || safeName === '.' || safeName === '..') return null;
  const resolved = path.resolve(base, safeName);
  const baseSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(baseSep)) return null;
  return resolved;
}

/** Export fiel do Postgres (schema + dados + constraints) via `pg_dump` em SQL plain.
 * Escreve primeiro para `*.tmp` e só renomeia no sucesso — crash mid-dump não deixa
 * `.sql` parcial a ser tratado como backup válido pelo prune.
 *
 * AbortSignal (cooperativo via child process):
 * - em abort: SIGTERM → (após ~2s) SIGKILL no pg_dump;
 * - remove `.tmp`;
 * - NUNCA faz rename para o `.sql` final.
 */
export function runPgDumpToFile(outputAbsolutePath: string, signal?: AbortSignal): Promise<void> {
  const opts = getPostgresCliSpawnOptions();
  const exe = getPgDumpPath();
  const tmpPath = `${outputAbsolutePath}.tmp`;
  const args = ['--format=plain', '--encoding=UTF8', '--no-owner', '--no-acl', '--clean', '--if-exists', '-f', tmpPath];
  if (opts.useConnectionString) {
    args.push(opts.databaseUrl);
  } else {
    args.push('-h', opts.host, '-p', opts.port, '-U', opts.user, '-d', opts.database);
  }

  const cleanupTmp = (): void => {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  };

  if (signal?.aborted) {
    cleanupTmp();
    return Promise.reject(Object.assign(new Error('pg_dump aborted'), { name: 'AbortError' }));
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ...opts.extraEnv } });
    let settled = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2_000);
      killTimer.unref?.();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(`[pg_dump] ${s}`);
    });
    child.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[pg_dump] ${d}`);
    });
    child.on('error', (err: Error) => {
      cleanupTmp();
      settle(() => reject(err));
    });
    child.on('close', (code) => {
      if (aborted || signal?.aborted) {
        cleanupTmp();
        settle(() => reject(Object.assign(new Error('pg_dump aborted'), { name: 'AbortError' })));
        return;
      }
      if (code === 0) {
        try {
          fs.renameSync(tmpPath, outputAbsolutePath);
          settle(() => resolve());
        } catch (e) {
          cleanupTmp();
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
        return;
      }
      cleanupTmp();
      settle(() => reject(new Error(stderr.trim() || `pg_dump terminou com código ${code}`)));
    });
  });
}

/** Mantém os N backups automáticos mais recentes; apaga os mais antigos.
 * Ignora `*.tmp` e ficheiros vazios (dumps incompletos / órfãos).
 */
export function pruneAutoSqlBackups(backupDir: string = getBackupDir(), keepCount: number = DEFAULT_AUTO_BACKUP_KEEP_COUNT): void {
  const keep = Math.max(AUTO_BACKUP_KEEP_MIN, Math.min(AUTO_BACKUP_KEEP_MAX, Math.floor(Number(keepCount)) || DEFAULT_AUTO_BACKUP_KEEP_COUNT));
  if (!fs.existsSync(backupDir)) return;
  const entries: Array<{ path: string; name: string; mtime: number }> = [];
  for (const ent of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const n = ent.name;
    if (n.toLowerCase().endsWith('.tmp')) continue;
    if (!n.startsWith(AUTO_SQL_BACKUP_PREFIX) || !n.toLowerCase().endsWith('.sql')) continue;
    const full = path.join(backupDir, n);
    try {
      const st = fs.statSync(full);
      if (st.size <= 0) continue;
      entries.push({ path: full, name: n, mtime: st.mtimeMs });
    } catch {
      /* ficheiro removido entre o readdir e o stat — ignora */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (let i = keep; i < entries.length; i++) {
    try {
      fs.unlinkSync(entries[i].path);
      console.log('[Backup] Backup automático antigo removido:', entries[i].name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Backup] Falha ao remover:', entries[i].name, msg);
    }
  }
}
