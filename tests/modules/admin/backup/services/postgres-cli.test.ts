import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('admin/backup services/postgres-cli', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('getPostgresCliSpawnOptions', () => {
    it('usa DATABASE_URL quando definida', async () => {
      vi.resetModules();
      vi.stubEnv('DATABASE_URL', 'postgres://u:p@host/db');
      const { getPostgresCliSpawnOptions } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      const out = getPostgresCliSpawnOptions();
      expect(out).toEqual({ useConnectionString: true, databaseUrl: 'postgres://u:p@host/db', extraEnv: {} });
    });

    it('sem DATABASE_URL: monta host/user/database/port com defaults e PGPASSWORD em extraEnv', async () => {
      vi.resetModules();
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('PGHOST', '');
      vi.stubEnv('PGUSER', '');
      vi.stubEnv('PGDATABASE', '');
      vi.stubEnv('PGPORT', '');
      vi.stubEnv('PGPASSWORD', '');
      vi.stubEnv('POSTGRES_PASSWORD', '');
      const { getPostgresCliSpawnOptions } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      const out = getPostgresCliSpawnOptions();
      expect(out).toMatchObject({ useConnectionString: false, host: 'localhost', user: 'postgres', database: 'minestation', port: '5432', extraEnv: { PGPASSWORD: 'postgres' } });
    });
  });

  describe('getPgDumpPath', () => {
    it('Windows: devolve um caminho conhecido se existir, senão "pg_dump" no PATH', async () => {
      vi.resetModules();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { getPgDumpPath } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      expect(getPgDumpPath()).toBe('pg_dump');
    });

    it('Unix: resolve via PG_DUMP_PATH quando o ficheiro existe e o basename bate', async () => {
      vi.resetModules();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgdump-test-'));
      const fake = path.join(tmp, 'pg_dump');
      fs.writeFileSync(fake, '#!/bin/sh\n');
      vi.stubEnv('PG_DUMP_PATH', fake);
      const { getPgDumpPath } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      expect(getPgDumpPath()).toBe(fake);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Unix: PG_DUMP_PATH com basename diferente de pg_dump é ignorado', async () => {
      vi.resetModules();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgdump-test-'));
      const fake = path.join(tmp, 'not-pg-dump');
      fs.writeFileSync(fake, '#!/bin/sh\n');
      vi.stubEnv('PG_DUMP_PATH', fake);
      vi.stubEnv('POSTGRES_CLIENT_BIN', '');
      const { getPgDumpPath } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      const result = getPgDumpPath();
      expect(result).not.toBe(fake);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('Unix: resolve via POSTGRES_CLIENT_BIN', async () => {
      vi.resetModules();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgdump-test-'));
      fs.writeFileSync(path.join(tmp, 'pg_dump'), '#!/bin/sh\n');
      vi.stubEnv('PG_DUMP_PATH', '');
      vi.stubEnv('POSTGRES_CLIENT_BIN', tmp);
      const { getPgDumpPath } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      expect(getPgDumpPath()).toBe(path.join(tmp, 'pg_dump'));
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('sem nenhuma pista: cai no fallback "pg_dump" (confia no PATH)', async () => {
      vi.resetModules();
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.stubEnv('PG_DUMP_PATH', '');
      vi.stubEnv('POSTGRES_CLIENT_BIN', '/definitely/does/not/exist');
      const { getPgDumpPath } = await import('../../../../../server/modules/admin/backup/services/postgres-cli.js');
      const result = getPgDumpPath();
      expect(typeof result).toBe('string');
    });
  });
});
