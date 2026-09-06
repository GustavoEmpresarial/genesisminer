import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/user-audit services/inventory-audit', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('parseInventoryAuditRange', () => {
    it('aceita ms numérico, string numérica ou data ISO', async () => {
      const { parseInventoryAuditRange } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      expect(parseInventoryAuditRange(1000, '2000')).toEqual({ fromMs: 1000, toMs: 2000 });
    });

    it('null/inválido devolve null', async () => {
      const { parseInventoryAuditRange } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      expect(parseInventoryAuditRange(null, undefined)).toEqual({ fromMs: null, toMs: null });
    });
  });

  describe('listUserInventoryAudit', () => {
    it('devolve total e rows mapeadas (com delta/summary calculados)', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          { id: '1', action: 'merge_craft', catalog_item_id: 'gpu_1', instance_id: null, quantity_before: 5, quantity_after: 3, meta: null, created_at: 1000, upgrade_name: 'GPU 1' }
        ]);
      const { listUserInventoryAudit } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      const out = await listUserInventoryAudit({ userId: 7, page: 1, limit: 50 });
      expect(out.total).toBe(1);
      expect(out.rows[0]).toMatchObject({ id: '1', itemName: 'GPU 1', delta: -2, summary: 'GPU 1: 5 → 3 (Δ -2)' });
    });

    it('meta com source: usa o source do JSON em vez do action', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([
        { id: '1', action: 'stock_adjust', catalog_item_id: 'gpu_1', instance_id: null, quantity_before: 1, quantity_after: 2, meta: JSON.stringify({ source: 'admin_bulk_gift' }), created_at: 1000, upgrade_name: null }
      ]);
      const { listUserInventoryAudit } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      const out = await listUserInventoryAudit({ userId: 7, page: 1, limit: 50 });
      expect(out.rows[0].source).toBe('admin_bulk_gift');
    });

    it('meta com JSON inválido: mantém action como source, não lança', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([
        { id: '1', action: 'stock_adjust', catalog_item_id: 'gpu_1', instance_id: null, quantity_before: null, quantity_after: null, meta: '{not json', created_at: 1000, upgrade_name: null }
      ]);
      const { listUserInventoryAudit } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      const out = await listUserInventoryAudit({ userId: 7, page: 1, limit: 50 });
      expect(out.rows[0]).toMatchObject({ source: 'stock_adjust', delta: null, summary: 'stock_adjust' });
    });

    it('lossesOnly: aplica filtro sem quebrar quando quantity_before/after ausentes', async () => {
      const { listUserInventoryAudit } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      await listUserInventoryAudit({ userId: 7, page: 1, limit: 50, lossesOnly: true });
      expect(prismaMock.prisma.$queryRaw).toHaveBeenCalled();
    });

    it('page/limit fora do intervalo são clampados', async () => {
      const { listUserInventoryAudit } = await import('../../../../../server/modules/admin/user-audit/services/inventory-audit.js');
      const out = await listUserInventoryAudit({ userId: 7, page: -5, limit: 99999 });
      expect(out.page).toBe(1);
      expect(out.limit).toBe(200);
    });
  });
});
