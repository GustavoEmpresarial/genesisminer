/**
 * Um `pg_dump` automático por dia (hora local do processo).
 *
 * **Cron no-op:** o agendamento vive em `genesis-mining-worker`
 * (`run_backup_sql_loop`, Redis lock `genesis:lock:job:backup-sql`,
 * advisory PG, `pg_dump`). Mantido como export de bootstrap para não partir
 * `startBackgroundSchedulers`.
 *
 * `createScheduledSqlBackupOnce` / `msUntilNextLocalClockRun` continuam para
 * a UI HTTP admin de backup manual / testes.
 *
 * Migrado de legacy/backend/controllers/backupController.ts (parte de agendamento).
 */
import fs from 'node:fs';
import { log } from '../../../../core/ops/logger.js';
import { AUTO_SQL_BACKUP_PREFIX, ensureBackupDir, getBackupDir, pruneAutoSqlBackups, resolveSafeBackupPath, runPgDumpToFile } from './backup-files.js';

const DEFAULT_BACKUP_SQL_KEEP = 14;

/** Um ciclo de backup automático: `pg_dump` SQL + rotação de ficheiros antigos. */
export async function createScheduledSqlBackupOnce(
  signal?: AbortSignal
): Promise<{ filename: string; path: string; bytes: number }> {
  if (signal?.aborted) {
    throw Object.assign(new Error('backup aborted'), { name: 'AbortError' });
  }
  ensureBackupDir();
  const fn = `${AUTO_SQL_BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
  const dest = resolveSafeBackupPath(fn);
  if (!dest) throw new Error('Caminho de backup inválido');
  await runPgDumpToFile(dest, signal);
  if (signal?.aborted) {
    throw Object.assign(new Error('backup aborted'), { name: 'AbortError' });
  }
  const keep = parseInt(process.env.BACKUP_SQL_KEEP || String(DEFAULT_BACKUP_SQL_KEEP), 10) || DEFAULT_BACKUP_SQL_KEEP;
  pruneAutoSqlBackups(getBackupDir(), keep);
  const st = fs.statSync(dest);
  return { filename: fn, path: dest, bytes: st.size };
}

const HOURS_MAX = 23;
const MINUTES_MAX = 59;
const SCHEDULE_MIN_DELAY_MS = 1000;

function parseAutoBackupLocalClock(): { hour: number; minute: number } {
  const hour = Math.min(HOURS_MAX, Math.max(0, parseInt(process.env.BACKUP_AUTO_LOCAL_HOUR || '0', 10) || 0));
  const minute = Math.min(MINUTES_MAX, Math.max(0, parseInt(process.env.BACKUP_AUTO_LOCAL_MINUTE || '0', 10) || 0));
  return { hour, minute };
}

/** Tempo até a próxima ocorrência de `hour:minute` no relógio local do processo (TZ do servidor). */
export function msUntilNextLocalClockRun(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const { hour, minute } = parseAutoBackupLocalClock();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.max(SCHEDULE_MIN_DELAY_MS, target.getTime() - now.getTime());
}

/**
 * Agenda desligada no Node — worker Rust owns o tick diário.
 * Devolve `stop()` no-op para compat com bootstrap.
 */
export function startScheduledSqlBackups(): () => void {
  log.info('auto SQL backup cron not scheduled', {
    module: 'backup',
    event: 'disabled',
    reason: 'Rust mining-worker owns auto SQL backup tick'
  });
  return () => undefined;
}
