/**
 * Contract freeze index (T7) — lacunas explícitas + âncoras do contrato.
 * Não duplica T1–T6; ver docs/catalog/CANONICAL-CATALOG-CONTRACT.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('canonical catalog contract freeze (T7)', () => {
  describe('read path — bootstrap admin vs operacional', () => {
    afterEach(() => {
      vi.doUnmock('../../../../server/core/database/prisma.js');
      vi.doUnmock('../../../../server/core/database/pool.js');
      vi.doUnmock('../../../../server/modules/mining-engine/services/runtime-stats.js');
    });

    it('admin GET set: exclui protected; NÃO filtra status retired', async () => {
      vi.resetModules();
      const findMany = vi.fn().mockResolvedValue([]);
      vi.doMock('../../../../server/core/database/prisma.js', () => ({
        prisma: {
          users: { findUnique: vi.fn().mockResolvedValue({ is_admin: 1 }) },
          upgrades: { findMany },
          upgrade_compat_racks: { findMany: vi.fn().mockResolvedValue([]) }
        }
      }));
      vi.doMock('../../../../server/core/database/pool.js', () => ({ default: { query: vi.fn() } }));
      vi.doMock('../../../../server/modules/mining-engine/services/runtime-stats.js', () => ({
        miningRuntimeStats: { globalNetworkHashrates: new Map() }
      }));
      const { loadUpgradesForBootstrap } = await import(
        '../../../../server/modules/servers/services/bootstrap-catalog.js'
      );
      await loadUpgradesForBootstrap(1);
      const where = findMany.mock.calls[0][0].where;
      const serialized = JSON.stringify(where);
      expect(serialized).toContain('temp_legacy_');
      expect(serialized).toContain('legacy-temp');
      expect(serialized).not.toContain('retired');
    });

    it('não-admin GET: exclui retired (e inactivos)', async () => {
      vi.resetModules();
      const findMany = vi.fn().mockResolvedValue([]);
      vi.doMock('../../../../server/core/database/prisma.js', () => ({
        prisma: {
          users: { findUnique: vi.fn() },
          upgrades: { findMany },
          upgrade_compat_racks: { findMany: vi.fn().mockResolvedValue([]) }
        }
      }));
      vi.doMock('../../../../server/core/database/pool.js', () => ({ default: { query: vi.fn() } }));
      vi.doMock('../../../../server/modules/mining-engine/services/runtime-stats.js', () => ({
        miningRuntimeStats: { globalNetworkHashrates: new Map() }
      }));
      const { loadUpgradesForBootstrap } = await import(
        '../../../../server/modules/servers/services/bootstrap-catalog.js'
      );
      await loadUpgradesForBootstrap(undefined);
      const where = findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain('retired');
      expect(where).toMatchObject({
        AND: expect.arrayContaining([
          { is_active: 1 },
          { status: { notIn: expect.arrayContaining(['retired']) } }
        ])
      });
    });
  });

  describe('âncoras do contrato (exports estáveis)', () => {
    it('constante de conflito de revisão exportada', async () => {
      const { CATALOG_VERSION_CONFLICT } = await import(
        '../../../../server/modules/catalog/services/catalog-revision.js'
      );
      expect(CATALOG_VERSION_CONFLICT).toBe('CATALOG_VERSION_CONFLICT');
    });
  });
});
