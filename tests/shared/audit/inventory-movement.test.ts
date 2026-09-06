import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('shared/audit/inventory-movement', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: { inventory_movements: { create: vi.fn().mockResolvedValue(undefined) } } };
    vi.doMock('../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../server/core/database/prisma.js');
  });

  it('userId inválido: não grava nada', async () => {
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await recordInventoryMovement({ userId: 0, action: 'x' });
    await recordInventoryMovement({ userId: NaN, action: 'x' });
    expect(prismaMock.prisma.inventory_movements.create).not.toHaveBeenCalled();
  });

  it('action vazia: não grava nada', async () => {
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await recordInventoryMovement({ userId: 1, action: '  ' });
    expect(prismaMock.prisma.inventory_movements.create).not.toHaveBeenCalled();
  });

  it('grava o movimento com os campos truncados/normalizados', async () => {
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await recordInventoryMovement({
      userId: 7,
      action: ' merge_craft ',
      catalogItemId: 'gpu_1',
      instanceId: 'inst-1',
      quantityBefore: 2,
      quantityAfter: 3,
      meta: { foo: 'bar' }
    });
    expect(prismaMock.prisma.inventory_movements.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 7,
        action: 'merge_craft',
        catalog_item_id: 'gpu_1',
        instance_id: 'inst-1',
        quantity_before: 2,
        quantity_after: 3,
        meta: JSON.stringify({ foo: 'bar' })
      })
    });
  });

  it('sem meta: grava meta null', async () => {
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await recordInventoryMovement({ userId: 7, action: 'x' });
    expect(prismaMock.prisma.inventory_movements.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: null, catalog_item_id: null, instance_id: null, quantity_before: null, quantity_after: null }) });
  });

  it('meta não serializável: grava meta null sem lançar', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await expect(recordInventoryMovement({ userId: 7, action: 'x', meta: circular })).resolves.toBeUndefined();
    expect(prismaMock.prisma.inventory_movements.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: null }) });
  });

  it('falha ao gravar não propaga (best-effort, só loga aviso)', async () => {
    prismaMock.prisma.inventory_movements.create.mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { recordInventoryMovement } = await import('../../../server/shared/audit/inventory-movement.js');
    await expect(recordInventoryMovement({ userId: 7, action: 'x' })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('inventory_movements'), expect.stringContaining('boom'));
    warnSpy.mockRestore();
  });
});
