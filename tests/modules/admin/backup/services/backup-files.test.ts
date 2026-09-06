import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeChildProcess() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((sig?: string) => {
    child.killed = true;
    child.emit('close', sig === 'SIGKILL' || sig === 'SIGTERM' ? null : 1);
    return true;
  });
  return child;
}

describe('admin/backup services/backup-files', () => {
  let root: string;
  let cliMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-files-test-'));
    cliMock = {
      getPgDumpPath: vi.fn().mockReturnValue('/usr/bin/pg_dump'),
      getPostgresCliSpawnOptions: vi.fn().mockReturnValue({ useConnectionString: true, databaseUrl: 'postgres://x', extraEnv: {} })
    };
    vi.doMock('../../../../../server/modules/admin/backup/services/postgres-cli.js', () => cliMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/backup/services/postgres-cli.js');
    vi.doUnmock('node:child_process');
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('ensureBackupDir / getBackupDir', () => {
    it('usa BACKUP_DIR quando definido e cria o directório', async () => {
      const dir = path.join(root, 'meus-backups');
      vi.stubEnv('BACKUP_DIR', dir);
      const { ensureBackupDir } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = ensureBackupDir();
      expect(out).toBe(path.resolve(dir));
      expect(fs.existsSync(out)).toBe(true);
    });

    it('getBackupDir devolve o mesmo caminho que ensureBackupDir', async () => {
      const dir = path.join(root, 'mesmo-dir');
      vi.stubEnv('BACKUP_DIR', dir);
      const { ensureBackupDir, getBackupDir } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      expect(getBackupDir()).toBe(ensureBackupDir());
      expect(getBackupDir()).toBe(path.resolve(dir));
    });

    it('sem BACKUP_DIR: default é cwd/storage/backups, não ../backups nem /backups', async () => {
      vi.stubEnv('BACKUP_DIR', '');
      const { ensureBackupDir, getBackupDir, DEFAULT_BACKUP_DIR_SEGMENTS } = await import(
        '../../../../../server/modules/admin/backup/services/backup-files.js'
      );
      const expected = path.resolve(process.cwd(), ...DEFAULT_BACKUP_DIR_SEGMENTS);
      const out = ensureBackupDir();
      expect(out).toBe(expected);
      expect(getBackupDir()).toBe(expected);
      expect(out).not.toBe('/backups');
      expect(out).not.toBe(path.resolve(process.cwd(), '../backups'));
      expect(out.endsWith(path.join('storage', 'backups'))).toBe(true);
    });

    it('com BACKUP_DIR definido, o destino efectivo não é ../backups nem /backups', async () => {
      const dir = path.join(root, 'storage', 'backups');
      vi.stubEnv('BACKUP_DIR', dir);
      const { ensureBackupDir, resolveSafeBackupPath } = await import(
        '../../../../../server/modules/admin/backup/services/backup-files.js'
      );
      const out = ensureBackupDir();
      expect(out).toBe(path.resolve(dir));
      expect(out).not.toBe('/backups');
      expect(out).not.toBe(path.resolve(process.cwd(), '../backups'));
      const dump = resolveSafeBackupPath('auto_pgdump_x.sql');
      expect(dump).toBe(path.resolve(dir, 'auto_pgdump_x.sql'));
      expect(dump!.startsWith(path.resolve(dir))).toBe(true);
    });
  });

  describe('resolveSafeBackupPath', () => {
    it('resolve nomes simples dentro do directório de backup', async () => {
      const { resolveSafeBackupPath } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = resolveSafeBackupPath('foo.sql', root);
      expect(out).toBe(path.resolve(root, 'foo.sql'));
    });

    it('rejeita path traversal (../) — path.basename já neutraliza, mas confirma o comportamento seguro', async () => {
      const { resolveSafeBackupPath } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = resolveSafeBackupPath('../../etc/passwd', root);
      expect(out).toBe(path.resolve(root, 'passwd'));
      expect(out!.startsWith(path.resolve(root))).toBe(true);
    });

    it('rejeita nome vazio, "." ou ".."', async () => {
      const { resolveSafeBackupPath } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      expect(resolveSafeBackupPath('', root)).toBeNull();
      expect(resolveSafeBackupPath('.', root)).toBeNull();
      expect(resolveSafeBackupPath('..', root)).toBeNull();
    });
  });

  describe('runPgDumpToFile', () => {
    it('resolve quando o processo termina com código 0 (tmp→rename)', async () => {
      const child = fakeChildProcess();
      const spawn = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({ spawn }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = path.join(root, 'out.sql');
      const promise = runPgDumpToFile(out);
      fs.writeFileSync(`${out}.tmp`, 'dump');
      child.emit('close', 0);
      await expect(promise).resolves.toBeUndefined();
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.existsSync(`${out}.tmp`)).toBe(false);
      expect(spawn).toHaveBeenCalledWith('/usr/bin/pg_dump', expect.arrayContaining(['--format=plain', `${out}.tmp`, 'postgres://x']), expect.anything());
    });

    it('rejeita quando o processo termina com código != 0, incluindo stderr na mensagem', async () => {
      const child = fakeChildProcess();
      vi.doMock('node:child_process', () => ({ spawn: vi.fn().mockReturnValue(child) }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = path.join(root, 'out.sql');
      const promise = runPgDumpToFile(out);
      fs.writeFileSync(`${out}.tmp`, 'partial');
      child.stderr.emit('data', Buffer.from('erro de conexão'));
      child.emit('close', 1);
      await expect(promise).rejects.toThrow('erro de conexão');
      expect(fs.existsSync(`${out}.tmp`)).toBe(false);
      expect(fs.existsSync(out)).toBe(false);
    });

    it('rejeita se o processo falhar ao iniciar (erro ENOENT)', async () => {
      const child = fakeChildProcess();
      vi.doMock('node:child_process', () => ({ spawn: vi.fn().mockReturnValue(child) }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const promise = runPgDumpToFile(path.join(root, 'out.sql'));
      child.emit('error', new Error('ENOENT'));
      await expect(promise).rejects.toThrow('ENOENT');
    });

    it('sem connectionString: monta -h/-p/-U/-d e escreve para .tmp', async () => {
      cliMock.getPostgresCliSpawnOptions.mockReturnValue({ useConnectionString: false, databaseUrl: null, extraEnv: {}, host: 'db', port: '5432', user: 'app', database: 'gm' });
      const child = fakeChildProcess();
      const spawn = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({ spawn }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = path.join(root, 'out.sql');
      const promise = runPgDumpToFile(out);
      fs.writeFileSync(`${out}.tmp`, 'dump');
      child.emit('close', 0);
      await promise;
      expect(spawn).toHaveBeenCalledWith('/usr/bin/pg_dump', expect.arrayContaining(['-h', 'db', '-p', '5432', '-U', 'app', '-d', 'gm', `${out}.tmp`]), expect.anything());
    });

    it('abort: mata child, limpa .tmp e NÃO renomeia para .sql final', async () => {
      const child = fakeChildProcess();
      // Override kill to not auto-close so we can assert rename never happened mid-flight
      child.kill = vi.fn(() => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null));
        return true;
      });
      vi.doMock('node:child_process', () => ({ spawn: vi.fn().mockReturnValue(child) }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const out = path.join(root, 'out.sql');
      const ac = new AbortController();
      const promise = runPgDumpToFile(out, ac.signal);
      fs.writeFileSync(`${out}.tmp`, 'partial-dump');
      ac.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(child.kill).toHaveBeenCalled();
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(`${out}.tmp`)).toBe(false);
    });

    it('signal já abortado: rejeita sem spawn rename', async () => {
      const spawn = vi.fn();
      vi.doMock('node:child_process', () => ({ spawn }));
      const { runPgDumpToFile } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      const ac = new AbortController();
      ac.abort();
      await expect(runPgDumpToFile(path.join(root, 'out.sql'), ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, 'out.sql'))).toBe(false);
    });
  });

  describe('pruneAutoSqlBackups', () => {
    it('directório inexistente: no-op', async () => {
      const { pruneAutoSqlBackups } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      expect(() => pruneAutoSqlBackups(path.join(root, 'nao-existe'), 5)).not.toThrow();
    });

    it('mantém só os N mais recentes com o prefixo auto_pgdump_', async () => {
      const names = ['auto_pgdump_1.sql', 'auto_pgdump_2.sql', 'auto_pgdump_3.sql', 'manual.sql'];
      const now = Date.now();
      names.forEach((n, i) => {
        const p = path.join(root, n);
        fs.writeFileSync(p, 'x');
        fs.utimesSync(p, new Date(now + i * 1000), new Date(now + i * 1000));
      });
      const { pruneAutoSqlBackups } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      pruneAutoSqlBackups(root, 2);
      expect(fs.existsSync(path.join(root, 'auto_pgdump_3.sql'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'auto_pgdump_2.sql'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'auto_pgdump_1.sql'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'manual.sql'))).toBe(true);
    });

    it('keepCount é clampado entre 1 e 500', async () => {
      fs.writeFileSync(path.join(root, 'auto_pgdump_only.sql'), 'x');
      const { pruneAutoSqlBackups } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      expect(() => pruneAutoSqlBackups(root, -5)).not.toThrow();
      expect(fs.existsSync(path.join(root, 'auto_pgdump_only.sql'))).toBe(true);
    });

    it('ignora .tmp e ficheiros vazios no prune (não contam como backups válidos)', async () => {
      const now = Date.now();
      fs.writeFileSync(path.join(root, 'auto_pgdump_good.sql'), 'valid');
      fs.utimesSync(path.join(root, 'auto_pgdump_good.sql'), new Date(now + 2000), new Date(now + 2000));
      fs.writeFileSync(path.join(root, 'auto_pgdump_empty.sql'), '');
      fs.writeFileSync(path.join(root, 'auto_pgdump_partial.sql.tmp'), 'partial');
      const { pruneAutoSqlBackups } = await import('../../../../../server/modules/admin/backup/services/backup-files.js');
      pruneAutoSqlBackups(root, 1);
      expect(fs.existsSync(path.join(root, 'auto_pgdump_good.sql'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'auto_pgdump_partial.sql.tmp'))).toBe(true);
    });
  });
});
