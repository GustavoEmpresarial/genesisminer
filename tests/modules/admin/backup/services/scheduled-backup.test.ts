import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/backup services/scheduled-backup', () => {
  let filesMock: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    filesMock = {
      AUTO_SQL_BACKUP_PREFIX: 'auto_pgdump_',
      ensureBackupDir: vi.fn().mockReturnValue('/app/storage/backups'),
      getBackupDir: vi.fn().mockReturnValue('/app/storage/backups'),
      resolveSafeBackupPath: vi.fn((fn: string) => `/app/storage/backups/${fn}`),
      runPgDumpToFile: vi.fn().mockResolvedValue(undefined),
      pruneAutoSqlBackups: vi.fn()
    };
    vi.doMock('../../../../../server/modules/admin/backup/services/backup-files.js', () => filesMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/backup/services/backup-files.js');
    vi.unstubAllEnvs();
  });

  describe('createScheduledSqlBackupOnce', () => {
    it('caminho inválido de resolveSafeBackupPath: lança', async () => {
      (filesMock.resolveSafeBackupPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const { createScheduledSqlBackupOnce } = await import('../../../../../server/modules/admin/backup/services/scheduled-backup.js');
      await expect(createScheduledSqlBackupOnce()).rejects.toThrow('Caminho de backup inválido');
    });

    it('faz o dump, poda os antigos e devolve filename/path/bytes', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-backup-test-')), 'out.sql');
      (filesMock.resolveSafeBackupPath as ReturnType<typeof vi.fn>).mockImplementation((fn: string) => {
        void fn;
        return tmpFile;
      });
      (filesMock.runPgDumpToFile as ReturnType<typeof vi.fn>).mockImplementation(async (dest: string) => {
        fs.writeFileSync(dest, '0123456789');
      });
      const { createScheduledSqlBackupOnce } = await import('../../../../../server/modules/admin/backup/services/scheduled-backup.js');
      const out = await createScheduledSqlBackupOnce();
      expect(out.bytes).toBe(10);
      expect(out.filename).toMatch(/^auto_pgdump_.*\.sql$/);
      expect(filesMock.ensureBackupDir).toHaveBeenCalled();
      expect(filesMock.runPgDumpToFile).toHaveBeenCalled();
      expect(filesMock.getBackupDir).toHaveBeenCalled();
      expect(filesMock.pruneAutoSqlBackups).toHaveBeenCalledWith('/app/storage/backups', expect.any(Number));
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    });
  });

  describe('msUntilNextLocalClockRun', () => {
    it('devolve o delay até a próxima hora:minuto configurados (mesmo dia se ainda não passou)', async () => {
      vi.stubEnv('BACKUP_AUTO_LOCAL_HOUR', '10');
      vi.stubEnv('BACKUP_AUTO_LOCAL_MINUTE', '0');
      const { msUntilNextLocalClockRun } = await import('../../../../../server/modules/admin/backup/services/scheduled-backup.js');
      const now = new Date(2026, 0, 1, 9, 0, 0, 0).getTime();
      const delay = msUntilNextLocalClockRun(now);
      expect(delay).toBe(60 * 60 * 1000);
    });

    it('se a hora já passou hoje: agenda para amanhã', async () => {
      vi.stubEnv('BACKUP_AUTO_LOCAL_HOUR', '10');
      vi.stubEnv('BACKUP_AUTO_LOCAL_MINUTE', '0');
      const { msUntilNextLocalClockRun } = await import('../../../../../server/modules/admin/backup/services/scheduled-backup.js');
      const now = new Date(2026, 0, 1, 11, 0, 0, 0).getTime();
      const delay = msUntilNextLocalClockRun(now);
      expect(delay).toBe(23 * 60 * 60 * 1000);
    });

    it('hour/minute fora do intervalo são clampados (0-23 / 0-59)', async () => {
      vi.stubEnv('BACKUP_AUTO_LOCAL_HOUR', '99');
      vi.stubEnv('BACKUP_AUTO_LOCAL_MINUTE', '-5');
      const { msUntilNextLocalClockRun } = await import('../../../../../server/modules/admin/backup/services/scheduled-backup.js');
      expect(() => msUntilNextLocalClockRun(Date.now())).not.toThrow();
    });
  });

});
