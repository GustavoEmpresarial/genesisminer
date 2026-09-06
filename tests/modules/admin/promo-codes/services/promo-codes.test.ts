import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mapPromoCodeAdminDto,
  planBulkDeleteCodes,
  planCreatePromoCode
} from '../../../../../server/modules/admin/promo-codes/services/promo-codes.js';

describe('planCreatePromoCode', () => {
  const now = 1_700_000_000_000;

  it('400 se faltar code ou recompensa', () => {
    try {
      planCreatePromoCode({ code: 'A' }, now);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
      expect(e.jsonBody.error).toMatch(/Faltam campos/);
    }
    try {
      planCreatePromoCode({ lootBoxId: 'b' }, now);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });

  it('type default per_player; expiresAt futuro clamp 10 anos; passado ignorado', () => {
    const a = planCreatePromoCode({ code: 'X1', lootBoxId: 'box' }, now);
    expect(a.type).toBe('per_player');
    expect(a.expiresAt).toBeNull();
    const future = planCreatePromoCode({ code: 'X1', upgradeId: 'u', expiresAt: now + 1000, type: 'global_once' }, now);
    expect(future.expiresAt).toBe(now + 1000);
    expect(future.type).toBe('global_once');
    const tooFar = now + 20 * 365 * 24 * 60 * 60 * 1000;
    const clamped = planCreatePromoCode({ code: 'X1', adminUpgradeId: 'p', expiresAt: tooFar }, now);
    expect(clamped.expiresAt).toBe(now + 10 * 365 * 24 * 60 * 60 * 1000);
    const past = planCreatePromoCode({ code: 'X1', lootBoxId: 'b', expiresAt: now - 1 }, now);
    expect(past.expiresAt).toBeNull();
  });
});

describe('planBulkDeleteCodes', () => {
  it('lista vazia / inválidos / máximo', () => {
    try {
      planBulkDeleteCodes([]);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Lista de códigos vazia ou inválida.');
    }
    try {
      planBulkDeleteCodes(['!!']);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Nenhum código válido para apagar.');
    }
    try {
      planBulkDeleteCodes(Array.from({ length: 2001 }, (_, i) => `CODE${i}AB`));
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Máximo 2000 códigos por pedido.');
    }
  });

  it('normaliza trim+upper e filtra regex', () => {
    expect(planBulkDeleteCodes([' ab-1 ', 'ZZ_2'])).toEqual(['AB-1', 'ZZ_2']);
  });
});

describe('mapPromoCodeAdminDto', () => {
  it('camelCase + snake; expiresAt omitido se 0/inválido; isActive !!', () => {
    const dto = mapPromoCodeAdminDto(
      {
        code: 'A',
        loot_box_id: 'b',
        upgrade_id: null,
        admin_upgrade_id: null,
        type: 'per_player',
        is_active: 0,
        created_at: 10,
        expires_at: 0
      },
      3,
      [{ userName: 'joe', redeemedAt: 20 }]
    );
    expect(dto.isActive).toBe(false);
    expect(dto.lootBoxId).toBe('b');
    expect(dto.expiresAt).toBeUndefined();
    expect(dto.redemptionsCount).toBe(3);
    expect(dto.lastRedemptions[0]!.userName).toBe('joe');
  });
});

describe('list/upsert/delete/toggle/bulk', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        promo_codes: {
          findMany: vi.fn(),
          upsert: vi.fn(),
          deleteMany: vi.fn(),
          updateMany: vi.fn()
        },
        promo_code_redemptions: {
          groupBy: vi.fn(),
          deleteMany: vi.fn()
        },
        $queryRaw: vi.fn(),
        $transaction: vi.fn(async (arg: any) => {
          if (typeof arg === 'function') return arg(prismaMock.prisma);
          if (Array.isArray(arg)) {
            const results = [];
            for (const p of arg) results.push(await p);
            return results;
          }
          return arg;
        })
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('list vazia → [] sem groupBy', async () => {
    prismaMock.prisma.promo_codes.findMany.mockResolvedValue([]);
    const { listPromoCodes } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(listPromoCodes()).resolves.toEqual([]);
    expect(prismaMock.prisma.promo_code_redemptions.groupBy).not.toHaveBeenCalled();
  });

  it('list agrega counts e últimos resgates', async () => {
    prismaMock.prisma.promo_codes.findMany.mockResolvedValue([
      {
        code: 'A',
        loot_box_id: 'b',
        upgrade_id: null,
        admin_upgrade_id: null,
        type: 'per_player',
        is_active: 1,
        created_at: 5,
        expires_at: null
      }
    ]);
    prismaMock.prisma.promo_code_redemptions.groupBy.mockResolvedValue([{ code: 'A', _count: { _all: 2 } }]);
    prismaMock.prisma.$queryRaw.mockResolvedValue([
      { code: 'A', user_name: 'u1', redeemed_at: 9 },
      { code: 'A', user_name: 'u2', redeemed_at: 8 }
    ]);
    const { listPromoCodes } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    const rows = await listPromoCodes();
    expect(rows[0]!.redemptionsCount).toBe(2);
    expect(rows[0]!.lastRedemptions).toHaveLength(2);
    expect(rows[0]!.isActive).toBe(true);
  });

  it('upsert create vs conflito (não mexe is_active no update)', async () => {
    prismaMock.prisma.promo_codes.upsert.mockResolvedValue({});
    const { upsertPromoCode } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(upsertPromoCode({ code: 'Z', lootBoxId: 'box' }, 100)).resolves.toEqual({ ok: true });
    const arg = prismaMock.prisma.promo_codes.upsert.mock.calls[0][0];
    expect(arg.create.is_active).toBe(1);
    expect(arg.update).not.toHaveProperty('is_active');
    expect(arg.update).not.toHaveProperty('created_at');
  });

  it('upsert duplicado com expiresAt null não zera expires_at', async () => {
    prismaMock.prisma.promo_codes.upsert.mockResolvedValue({});
    const { upsertPromoCode } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await upsertPromoCode({ code: 'Z', lootBoxId: 'box' }, 100);
    expect(prismaMock.prisma.promo_codes.upsert.mock.calls[0][0].update.expires_at).toBeUndefined();
  });

  it('delete corre em transação redemptions+codes', async () => {
    prismaMock.prisma.promo_code_redemptions.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.prisma.promo_codes.deleteMany.mockResolvedValue({ count: 1 });
    const { deletePromoCode } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(deletePromoCode('Z')).resolves.toEqual({ ok: true });
    expect(prismaMock.prisma.$transaction).toHaveBeenCalled();
  });

  it('toggle inexistente ainda { ok: true }', async () => {
    prismaMock.prisma.promo_codes.updateMany.mockResolvedValue({ count: 0 });
    const { togglePromoCode } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(togglePromoCode('NOPE', true)).resolves.toEqual({ ok: true });
  });

  it('bulk-delete atómico devolve deleted', async () => {
    prismaMock.prisma.promo_code_redemptions.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.prisma.promo_codes.deleteMany.mockResolvedValue({ count: 2 });
    const { bulkDeletePromoCodes } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(bulkDeletePromoCodes(['AAAA', 'BBBB'])).resolves.toEqual({ ok: true, deleted: 2 });
  });

  it('erro de banco em list propaga', async () => {
    prismaMock.prisma.promo_codes.findMany.mockRejectedValue(new Error('db down'));
    const { listPromoCodes } = await import('../../../../../server/modules/admin/promo-codes/services/promo-codes.js');
    await expect(listPromoCodes()).rejects.toThrow('db down');
  });
});
