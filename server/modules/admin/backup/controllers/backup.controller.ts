/**
 * Rotas admin: listar / criar (`pg_dump`) / apagar / baixar backups SQL
 * (`/api/admin/backup*`).
 *
 * Migrado de legacy/backend/controllers/backupController.ts.
 *
 * ⚠️ Corte de escopo deliberado (confirmado com o dono do projeto): **restore
 * não foi portado**. O legado tem `POST /api/admin/restore` — sobrescreve
 * tabelas inteiras da base via `pg_restore`/`psql` (dumps binários/SQL) ou via
 * JSON/SQLite legado (linha a linha, com `SAVEPOINT` por registo) — é a rota
 * de maior blast radius de todo o backend (pode apagar/sobrescrever dados de
 * produção). Fica fora desta leva. `POST /api/admin/backups/upload` também
 * não foi portada — só fazia sentido como preparação para o restore.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { sanitizeApiMessage, sanitizeForLog } from '../../../../shared/utils/safe-text.js';
import { getBackupDir, resolveSafeBackupPath, runPgDumpToFile } from '../services/backup-files.js';

export type AdminBackupModuleDeps = { isAdmin: import('express').RequestHandler };

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const BACKUP_NAME_MAX_LENGTH = 80;
const ERROR_DETAIL_MAX_LENGTH = 180;
const STAT_ERROR_LOG_MAX_LENGTH = 120;

const BACKUP_FILENAME_EXTENSIONS = ['.db', '.sqlite', '.back', '.sql', '.json.gz', '.json', '.gz', '.dump'];

function isBackupFilename(name: string): boolean {
  const lower = String(name).toLowerCase();
  return BACKUP_FILENAME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerAdminBackupModuleRoutes(app: Express, deps: AdminBackupModuleDeps): void {
  const { isAdmin } = deps;

  app.get('/api/admin/backups', isAdmin, async (_req: Request, res: Response) => {
    try {
      const backupDir = getBackupDir();
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const list: Array<{ filename: string; size: number; createdAt: number }> = [];
      for (const ent of fs.readdirSync(backupDir, { withFileTypes: true })) {
        if (!ent.isFile() || !isBackupFilename(ent.name)) continue;
        try {
          const stats = fs.statSync(path.join(backupDir, ent.name));
          list.push({ filename: ent.name, size: stats.size, createdAt: stats.mtimeMs });
        } catch (statErr) {
          console.warn('[Backups] Ignorando ficheiro ao listar:', sanitizeForLog(ent.name), sanitizeForLog(toErrorMessage(statErr), STAT_ERROR_LOG_MAX_LENGTH));
        }
      }
      res.json(list.sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) {
      console.error('[Backups] Listagem:', sanitizeForLog(toErrorMessage(e)));
      res.status(HTTP_INTERNAL_SERVER_ERROR).json({ error: 'Falha ao listar backups' });
    }
  });

  app.post('/api/admin/backup', isAdmin, async (req: Request, res: Response) => {
    const body = req.body as { name?: unknown } | undefined;
    const safeBase = path.basename(String(body?.name ?? 'backup')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, BACKUP_NAME_MAX_LENGTH) || 'backup';
    const filename = `${safeBase}_${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    const dest = resolveSafeBackupPath(filename);
    if (!dest) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Nome de backup inválido' });
      return;
    }
    try {
      await runPgDumpToFile(dest);
      const st = fs.statSync(dest);
      console.log(`[Backups] Manual pg_dump OK: ${sanitizeForLog(filename)} (${st.size} bytes)`);
      res.json({ ok: true, filename, bytes: st.size, format: 'sql' });
    } catch (e) {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* melhor esforço — não bloquear a resposta de erro por causa da limpeza */
      }
      console.error('[Backups] pg_dump:', sanitizeForLog(toErrorMessage(e)));
      const detail = sanitizeApiMessage(toErrorMessage(e), ERROR_DETAIL_MAX_LENGTH);
      const hint = detail.includes('ENOENT') ? ' Em Docker: reconstrua a imagem (inclua postgresql-client) ou defina PG_DUMP_PATH. ' : ' ';
      res.status(HTTP_INTERNAL_SERVER_ERROR).json({
        error: 'Falha ao criar backup SQL (pg_dump). Instale o cliente PostgreSQL (pacote que fornece pg_dump no PATH). ' + hint + detail
      });
    }
  });

  app.delete('/api/admin/backups/:filename', isAdmin, async (req: Request, res: Response) => {
    const fullPath = resolveSafeBackupPath(req.params.filename);
    if (!fullPath) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Nome de arquivo inválido' });
      return;
    }
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        res.json({ ok: true });
      } else {
        res.status(HTTP_NOT_FOUND).json({ error: 'Arquivo não encontrado' });
      }
    } catch {
      res.status(HTTP_INTERNAL_SERVER_ERROR).json({ error: 'Falha ao deletar backup' });
    }
  });

  app.get('/api/admin/backups/download/:filename', isAdmin, (req: Request, res: Response) => {
    const fullPath = resolveSafeBackupPath(req.params.filename);
    if (!fullPath) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Nome de arquivo inválido' });
      return;
    }
    if (!fs.existsSync(fullPath)) {
      res.status(HTTP_NOT_FOUND).json({ error: 'Arquivo não encontrado' });
      return;
    }
    const base = path.basename(fullPath);
    if (base.toLowerCase().endsWith('.sql')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.download(fullPath, base);
  });
}
