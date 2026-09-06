import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin loot-boxes services/user-inventory', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ id: 7 })
        },
        unopened_boxes: {
          findMany: vi.fn().mockResolvedValue([
            { box_id: 'box_a', qty: 3 },
            { box_id: 'box_b', qty: 1 }
          ]),
          findUnique: vi.fn().mockResolvedValue({ qty: 2 }),
          delete: vi.fn().mockResolvedValue(undefined)
        }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('listUserUnopenedBoxes', () => {
    it('email missing: HttpControlledError 400 Email required', async () => {
      const { listUserUnopenedBoxes } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      await expect(listUserUnopenedBoxes('')).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: { error: 'Email required' }
      });
      expect(prismaMock.prisma.users.findFirst).not.toHaveBeenCalled();
    });

    it('user missing: 404 User not found', async () => {
      prismaMock.prisma.users.findFirst.mockResolvedValue(null);
      const { listUserUnopenedBoxes } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      await expect(listUserUnopenedBoxes('ghost@x.com')).rejects.toMatchObject({
        statusCode: 404,
        jsonBody: { error: 'User not found' }
      });
    });

    it('caminho feliz: boxes ordenadas por qty desc', async () => {
      const { listUserUnopenedBoxes } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      const out = await listUserUnopenedBoxes('Player@X.com');
      expect(prismaMock.prisma.users.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'Player@X.com', mode: 'insensitive' } },
        select: { id: true }
      });
      expect(prismaMock.prisma.unopened_boxes.findMany).toHaveBeenCalledWith({
        where: { user_id: 7 },
        select: { box_id: true, qty: true },
        orderBy: { qty: 'desc' }
      });
      expect(out).toEqual({
        boxes: [
          { box_id: 'box_a', qty: 3 },
          { box_id: 'box_b', qty: 1 }
        ]
      });
    });
  });

  describe('deleteUserUnopenedBox', () => {
    it('email ou boxId missing: 400', async () => {
      const { deleteUserUnopenedBox } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      await expect(deleteUserUnopenedBox('', 'b1')).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: { error: 'Email and boxId required' }
      });
      await expect(deleteUserUnopenedBox('a@b.c', '')).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: { error: 'Email and boxId required' }
      });
    });

    it('user missing: 404', async () => {
      prismaMock.prisma.users.findFirst.mockResolvedValue(null);
      const { deleteUserUnopenedBox } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      await expect(deleteUserUnopenedBox('ghost@x.com', 'box_a')).rejects.toMatchObject({
        statusCode: 404,
        jsonBody: { error: 'User not found' }
      });
    });

    it('box missing no inventário: 404', async () => {
      prismaMock.prisma.unopened_boxes.findUnique.mockResolvedValue(null);
      const { deleteUserUnopenedBox } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      await expect(deleteUserUnopenedBox('a@b.c', 'missing')).rejects.toMatchObject({
        statusCode: 404,
        jsonBody: { error: 'Box not found in user inventory' }
      });
    });

    it('caminho feliz: apaga e devolve deletedQty', async () => {
      const { deleteUserUnopenedBox } = await import(
        '../../../../../server/modules/admin/loot-boxes/services/user-inventory.js'
      );
      const out = await deleteUserUnopenedBox('a@b.c', 'box_a');
      expect(prismaMock.prisma.unopened_boxes.delete).toHaveBeenCalledWith({
        where: { user_id_box_id: { user_id: 7, box_id: 'box_a' } }
      });
      expect(out).toEqual({
        ok: true,
        message: 'Deleted 2x box box_a from a@b.c',
        deletedQty: 2
      });
    });
  });
});
