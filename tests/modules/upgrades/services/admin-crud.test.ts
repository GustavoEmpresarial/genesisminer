import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('modules/upgrades/services/admin-crud', () => {
  let txMock: Record<string, any>;
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    txMock = {
      admin_upgrades: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(undefined), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      admin_upgrade_items: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue(undefined) },
      admin_upgrade_boxes: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue(undefined) },
      admin_upgrade_passes: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue(undefined) },
      admin_upgrade_coins: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue(undefined) },
      admin_upgrade_visibility: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue(undefined) }
    };
    prismaMock = {
      prisma: {
        $transaction: vi.fn((cb: any) => cb(txMock)),
        admin_upgrade_purchases: { findFirst: vi.fn().mockResolvedValue(null) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  async function load() {
    return import('../../../../server/modules/upgrades/services/admin-crud.js');
  }

  describe('upsertAdminUpgrade', () => {
    it('id vazio: lança HttpControlledError 400 sem tocar na BD', async () => {
      const { upsertAdminUpgrade } = await load();
      await expect(upsertAdminUpgrade({ id: '  ', name: 'X', priceUsdc: 1 })).rejects.toMatchObject({ statusCode: 400 });
      expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('limpa as 5 tabelas-filha (incluindo visibility) antes de recriar', async () => {
      const { upsertAdminUpgrade } = await load();
      await upsertAdminUpgrade({ id: 'pack_1', name: 'Pacote', priceUsdc: 10 });
      expect(txMock.admin_upgrade_items.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
      expect(txMock.admin_upgrade_boxes.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
      expect(txMock.admin_upgrade_passes.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
      expect(txMock.admin_upgrade_coins.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
      expect(txMock.admin_upgrade_visibility.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
    });

    it('version incrementa a partir do valor existente', async () => {
      txMock.admin_upgrades.findUnique.mockResolvedValue({ version: 5 });
      const { upsertAdminUpgrade } = await load();
      await upsertAdminUpgrade({ id: 'pack_1', name: 'Pacote', priceUsdc: 10 });
      expect(txMock.admin_upgrades.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ version: 6 }) }));
    });

    it('passes aceita string[] (ids) e objetos {passId,qty}, com qty default 1', async () => {
      const { upsertAdminUpgrade } = await load();
      await upsertAdminUpgrade({ id: 'pack_1', name: 'Pacote', priceUsdc: 10, passes: ['sp1', { passId: 'sp2', qty: 3 }] });
      expect(txMock.admin_upgrade_passes.createMany).toHaveBeenCalledWith({
        data: [
          { upgrade_id: 'pack_1', pass_id: 'sp1', qty: 1 },
          { upgrade_id: 'pack_1', pass_id: 'sp2', qty: 3 }
        ]
      });
    });

    it('items/boxes/coins/visibility vazios: não chama createMany', async () => {
      const { upsertAdminUpgrade } = await load();
      await upsertAdminUpgrade({ id: 'pack_1', name: 'Pacote', priceUsdc: 10 });
      expect(txMock.admin_upgrade_items.createMany).not.toHaveBeenCalled();
      expect(txMock.admin_upgrade_boxes.createMany).not.toHaveBeenCalled();
      expect(txMock.admin_upgrade_coins.createMany).not.toHaveBeenCalled();
      expect(txMock.admin_upgrade_visibility.createMany).not.toHaveBeenCalled();
    });

    it('items/boxes/coins/visibility preenchidos: repassa os dados mapeados', async () => {
      const { upsertAdminUpgrade } = await load();
      await upsertAdminUpgrade({
        id: 'pack_1',
        name: 'Pacote',
        priceUsdc: 10,
        items: [{ itemId: 'i1', qty: 2 }],
        boxes: [{ boxId: 'b1', qty: 1 }],
        coins: [{ coinId: 'c1', amount: 5 }],
        visibleToAccessLevelIds: ['lvl1']
      });
      expect(txMock.admin_upgrade_items.createMany).toHaveBeenCalledWith({ data: [{ upgrade_id: 'pack_1', item_id: 'i1', qty: 2 }] });
      expect(txMock.admin_upgrade_boxes.createMany).toHaveBeenCalledWith({ data: [{ upgrade_id: 'pack_1', box_id: 'b1', qty: 1 }] });
      expect(txMock.admin_upgrade_coins.createMany).toHaveBeenCalledWith({ data: [{ upgrade_id: 'pack_1', coin_id: 'c1', amount: 5 }] });
      expect(txMock.admin_upgrade_visibility.createMany).toHaveBeenCalledWith({ data: [{ upgrade_id: 'pack_1', access_level_id: 'lvl1' }] });
    });
  });

  describe('deleteAdminUpgrade', () => {
    it('já comprado: lança HttpControlledError 400 sem abrir transação', async () => {
      prismaMock.prisma.admin_upgrade_purchases.findFirst.mockResolvedValue({ user_id: 7 });
      const { deleteAdminUpgrade } = await load();
      await expect(deleteAdminUpgrade('pack_1')).rejects.toMatchObject({ statusCode: 400 });
      expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('não encontrado: lança HttpControlledError 404', async () => {
      txMock.admin_upgrades.deleteMany.mockResolvedValue({ count: 0 });
      const { deleteAdminUpgrade } = await load();
      await expect(deleteAdminUpgrade('pack_1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('caminho feliz: limpa as 5 tabelas-filha (incluindo visibility) e apaga o pai', async () => {
      const { deleteAdminUpgrade } = await load();
      await deleteAdminUpgrade('pack_1');
      expect(txMock.admin_upgrade_visibility.deleteMany).toHaveBeenCalledWith({ where: { upgrade_id: 'pack_1' } });
      expect(txMock.admin_upgrades.deleteMany).toHaveBeenCalledWith({ where: { id: 'pack_1' } });
    });
  });
});
