import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('core/database/pool', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('buildPoolConfig', () => {
    it('usa DATABASE_URL quando definida (ignora PG* individuais)', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://u:p@host:5432/db');
      const { buildPoolConfig } = await import('../../../server/core/database/pool.js');
      const cfg = buildPoolConfig();
      expect(cfg.connectionString).toBe('postgres://u:p@host:5432/db');
      expect(cfg.max).toBeGreaterThan(0);
    });

    it('sem DATABASE_URL: monta config a partir de PG* com defaults sensatos', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('PGHOST', '');
      vi.stubEnv('PGUSER', '');
      vi.stubEnv('PGDATABASE', '');
      vi.stubEnv('PGPASSWORD', '');
      vi.stubEnv('POSTGRES_PASSWORD', '');
      vi.stubEnv('PGPORT', '');
      const { buildPoolConfig } = await import('../../../server/core/database/pool.js');
      const cfg = buildPoolConfig();
      expect(cfg).toMatchObject({ host: 'localhost', user: 'postgres', database: 'minestation', port: 5432 });
    });

    it('respeita PGHOST/PGUSER/PGDATABASE/PGPORT customizados', async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('PGHOST', 'db.internal');
      vi.stubEnv('PGUSER', 'app');
      vi.stubEnv('PGDATABASE', 'gm');
      vi.stubEnv('PGPORT', '5433');
      const { buildPoolConfig } = await import('../../../server/core/database/pool.js');
      const cfg = buildPoolConfig();
      expect(cfg).toMatchObject({ host: 'db.internal', user: 'app', database: 'gm', port: 5433 });
    });

    it('PG_POOL_MAX é limitado ao piso/teto (5-50)', async () => {
      vi.stubEnv('PG_POOL_MAX', '1000');
      const { buildPoolConfig } = await import('../../../server/core/database/pool.js');
      expect(buildPoolConfig().max).toBe(50);

      vi.resetModules();
      vi.stubEnv('PG_POOL_MAX', '1');
      const { buildPoolConfig: buildPoolConfig2 } = await import('../../../server/core/database/pool.js');
      expect(buildPoolConfig2().max).toBe(5);
    });

    it('PG_POOL_MAX inválido cai no default (20)', async () => {
      vi.stubEnv('PG_POOL_MAX', 'not-a-number');
      const { buildPoolConfig } = await import('../../../server/core/database/pool.js');
      expect(buildPoolConfig().max).toBe(20);
    });
  });

  describe('default export / helpers', () => {
    it('exporta um pool pg com query/connect', async () => {
      const mod = await import('../../../server/core/database/pool.js');
      expect(typeof mod.default.query).toBe('function');
      expect(typeof mod.default.connect).toBe('function');
      expect(typeof mod.query).toBe('function');
      expect(typeof mod.getClient).toBe('function');
    });
  });
});
