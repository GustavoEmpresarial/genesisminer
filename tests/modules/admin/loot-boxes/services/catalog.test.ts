import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin loot-boxes services/catalog', () => {
  let prismaMock: Record<string, any>;
  let tx: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    tx = {
      loot_box_items: {
        groupBy: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      loot_boxes: {
        upsert: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0)
    };
    prismaMock = { prisma: { $transaction: vi.fn((cb: (t: any) => unknown) => cb(tx)) } };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('parseLootBoxId', () => {
    it('aceita ids válidos e rejeita inválidos/longos', async () => {
      const { parseLootBoxId } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      expect(parseLootBoxId('box_1')).toBe('box_1');
      expect(parseLootBoxId('box com espaço')).toBeNull();
      expect(parseLootBoxId('a'.repeat(201))).toBeNull();
      expect(parseLootBoxId('')).toBeNull();
    });
  });

  describe('upsertLootBoxCatalog', () => {
    it('caixa shop activa sem preço válido: HttpControlledError 400', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await expect(
        upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'shop', isActive: true, price: 0, items: [{ id: 'x', probability: 50 }] }], false)
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('caixa activa sem prémios (payload e DB): grava inactiva com aviso', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      const warnings = await upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'roleta', isActive: true, items: [] }], false);
      expect(warnings.length).toBe(1);
      expect(tx.loot_boxes.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ is_active: 0 }) }));
    });

    it('gatilho roleta_code fica activo mesmo sem lista de itens', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      const warnings = await upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'roleta_code', isActive: true, items: [] }], false);
      expect(warnings).toEqual([]);
      expect(tx.loot_boxes.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ is_active: 1 }) }));
    });

    it('items com entradas válidas: substitui (delete + createMany)', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await upsertLootBoxCatalog(
        [{ id: 'b1', name: 'Caixa', trigger: 'shop_once', isActive: false, items: [{ id: 'item_x', probability: 100, minQty: 1, maxQty: 2 }] }],
        false
      );
      expect(tx.loot_box_items.deleteMany).toHaveBeenCalledWith({ where: { box_id: 'b1' } });
      expect(tx.loot_box_items.createMany).toHaveBeenCalled();
    });

    it('items vazio sem clearItems: preserva o que já está em DB (não apaga)', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      tx.loot_box_items.groupBy.mockResolvedValue([{ box_id: 'b1', _count: { _all: 3 } }]);
      await upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'shop', isActive: false, items: [] }], false);
      expect(tx.loot_box_items.deleteMany).not.toHaveBeenCalled();
    });

    it('items vazio com clearItems=true: apaga explicitamente', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'shop', isActive: false, items: [], clearItems: true }], false);
      expect(tx.loot_box_items.deleteMany).toHaveBeenCalledWith({ where: { box_id: 'b1' } });
    });

    it('replaceCatalog=true: desactiva caixas fora do payload', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await upsertLootBoxCatalog([{ id: 'b1', name: 'Caixa', trigger: 'roleta_code', isActive: true, items: [] }], true);
      expect(tx.loot_boxes.updateMany).toHaveBeenCalledWith({ where: { id: { notIn: ['b1'] } }, data: { is_active: 0 } });
    });

    it('replaceCatalog=true com payload vazio: desactiva tudo', async () => {
      const { upsertLootBoxCatalog } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await upsertLootBoxCatalog([], true);
      expect(tx.loot_boxes.updateMany).toHaveBeenCalledWith({ data: { is_active: 0 } });
    });
  });

  describe('deleteLootBoxAdmin', () => {
    it('caixa inexistente: HttpControlledError 404', async () => {
      tx.$queryRawUnsafe.mockResolvedValue([]);
      const { deleteLootBoxAdmin } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await expect(deleteLootBoxAdmin('b1', false)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('brokenOnly=true com itens válidos (probability>0): HttpControlledError 409', async () => {
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'b1', name: 'Caixa' }]).mockResolvedValueOnce([{ n: 1, w: 100 }]);
      const { deleteLootBoxAdmin } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      await expect(deleteLootBoxAdmin('b1', true)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('brokenOnly=true com caixa quebrada (sem prémios válidos): apaga em cascata', async () => {
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'b1', name: 'Caixa' }]).mockResolvedValueOnce([{ n: 0, w: 0 }]);
      const { deleteLootBoxAdmin } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      const out = await deleteLootBoxAdmin('b1', true);
      expect(out.boxName).toBe('Caixa');
      expect(tx.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('caminho feliz sem brokenOnly: apaga direto', async () => {
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'b1', name: 'Caixa' }]);
      const { deleteLootBoxAdmin } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      const out = await deleteLootBoxAdmin('b1', false);
      expect(out.summary.lootBoxesRemoved).toBe(0);
    });
  });

  describe('isLootBoxBrokenForSafeDelete', () => {
    it('sem linhas: considerada quebrada', async () => {
      const { isLootBoxBrokenForSafeDelete } = await import('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
      const sql = { queryRows: vi.fn().mockResolvedValue([]), execute: vi.fn() };
      expect(await isLootBoxBrokenForSafeDelete(sql as any, 'b1')).toBe(true);
    });
  });
});
