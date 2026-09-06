import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('isRoomAccessAllowedForUser', () => {
  it('sala sem restrição libera qualquer utilizador', async () => {
    const { isRoomAccessAllowedForUser } = await import('../../../../server/modules/rooms/services/rooms.js');
    expect(isRoomAccessAllowedForUser({ allowedPlanIds: [], allowedSeasonPassIds: [] }, { planIds: [], passIds: [] })).toBe(true);
  });

  it('sala restrita por plano: só libera quem tem o plano', async () => {
    const { isRoomAccessAllowedForUser } = await import('../../../../server/modules/rooms/services/rooms.js');
    expect(isRoomAccessAllowedForUser({ allowedPlanIds: ['founder'], allowedSeasonPassIds: [] }, { planIds: ['founder'], passIds: [] })).toBe(true);
    expect(isRoomAccessAllowedForUser({ allowedPlanIds: ['founder'], allowedSeasonPassIds: [] }, { planIds: ['normal'], passIds: [] })).toBe(false);
  });

  it('sala restrita por season pass: só libera quem comprou o passe', async () => {
    const { isRoomAccessAllowedForUser } = await import('../../../../server/modules/rooms/services/rooms.js');
    expect(isRoomAccessAllowedForUser({ allowedPlanIds: [], allowedSeasonPassIds: ['pass_a'] }, { planIds: [], passIds: ['pass_a'] })).toBe(true);
    expect(isRoomAccessAllowedForUser({ allowedPlanIds: [], allowedSeasonPassIds: ['pass_a'] }, { planIds: [], passIds: [] })).toBe(false);
  });

  it('sala restrita nos 2 eixos precisa bater plano E passe (mesma regra do legado)', async () => {
    const { isRoomAccessAllowedForUser } = await import('../../../../server/modules/rooms/services/rooms.js');
    const room = { allowedPlanIds: ['founder'], allowedSeasonPassIds: ['pass_a'] };
    expect(isRoomAccessAllowedForUser(room, { planIds: ['founder'], passIds: ['pass_a'] })).toBe(true);
    expect(isRoomAccessAllowedForUser(room, { planIds: ['founder'], passIds: [] })).toBe(false);
    expect(isRoomAccessAllowedForUser(room, { planIds: [], passIds: ['pass_a'] })).toBe(false);
    expect(isRoomAccessAllowedForUser(room, { planIds: ['normal'], passIds: ['pass_b'] })).toBe(false);
  });
});

describe('parseRigRoomId / parsePurchaseQuantity', () => {
  it('parseRigRoomId rejeita ids fora do padrão', async () => {
    const { parseRigRoomId } = await import('../../../../server/modules/rooms/services/rooms.js');
    expect(parseRigRoomId('room_1')).toBe('room_1');
    expect(parseRigRoomId('  room_1  ')).toBe('room_1');
    expect(parseRigRoomId('room com espaço')).toBeNull();
    expect(parseRigRoomId(123)).toBeNull();
    expect(parseRigRoomId(null)).toBeNull();
  });

  it('parsePurchaseQuantity: default 1, mínimo 1', async () => {
    const { parsePurchaseQuantity } = await import('../../../../server/modules/rooms/services/rooms.js');
    expect(parsePurchaseQuantity(undefined)).toBe(1);
    expect(parsePurchaseQuantity(0)).toBe(1);
    expect(parsePurchaseQuantity(-5)).toBe(1);
    expect(parsePurchaseQuantity(7)).toBe(7);
    expect(parsePurchaseQuantity(7.9)).toBe(7);
  });
});

describe('listRigRooms / resolveUserRoomAccess / purchaseRigRoomSlot', () => {
  let prismaMock: Record<string, unknown>;
  let callRoomPurchaseSlot: ReturnType<typeof vi.fn>;
  let HardwareMarketError: new (status: number, body: Record<string, unknown>) => Error & {
    statusCode: number;
    jsonBody: Record<string, unknown>;
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        rig_rooms: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'room_initial',
              name: 'Sala Inicial',
              initial_capacity: 4,
              max_capacity: 10,
              base_slot_price: 10,
              slot_price_increase_percent: 10,
              allowed_levels: null,
              allowed_season_pass_ids: null,
              is_active: 1,
              sort_order: 0
            }
          ])
        },
        users: { findUnique: vi.fn().mockResolvedValue({ access_level_id: null }) },
        user_access_levels: { findMany: vi.fn().mockResolvedValue([]) },
        season_purchases: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };

    class HME extends Error {
      statusCode: number;
      jsonBody: Record<string, unknown>;
      constructor(statusCode: number, jsonBody: Record<string, unknown>) {
        super(typeof jsonBody.error === 'string' ? jsonBody.error : 'fail');
        this.name = 'HardwareMarketError';
        this.statusCode = statusCode;
        this.jsonBody = jsonBody;
      }
    }
    HardwareMarketError = HME as never;
    callRoomPurchaseSlot = vi.fn().mockResolvedValue({
      ok: true,
      roomId: 'room_founder',
      slotsPurchased: 1,
      totalPrice: 10,
      newUsdc: 990
    });

    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      callRoomPurchaseSlot,
      isHardwareMarketError: (e: unknown) => e instanceof HME,
      HardwareMarketError: HME
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
  });

  describe('listRigRooms', () => {
    it('mapeia allowed_levels/allowed_season_pass_ids de JSON pra array', async () => {
      const { listRigRooms } = await import('../../../../server/modules/rooms/services/rooms.js');
      const rooms = await listRigRooms();
      expect(rooms).toHaveLength(1);
      expect(rooms[0]).toMatchObject({ id: 'room_initial', allowedPlanIds: [], allowedSeasonPassIds: [], isActive: true });
    });
  });

  describe('resolveUserRoomAccess', () => {
    it('combina access_level_id actual + user_access_levels + season_purchases', async () => {
      (prismaMock.prisma as { users: { findUnique: ReturnType<typeof vi.fn> } }).users.findUnique.mockResolvedValue({
        access_level_id: 'founder'
      });
      (prismaMock.prisma as { user_access_levels: { findMany: ReturnType<typeof vi.fn> } }).user_access_levels.findMany.mockResolvedValue([
        { access_level_id: 'partner' }
      ]);
      (prismaMock.prisma as { season_purchases: { findMany: ReturnType<typeof vi.fn> } }).season_purchases.findMany.mockResolvedValue([
        { pass_id: 'pass_a' }
      ]);
      const { resolveUserRoomAccess } = await import('../../../../server/modules/rooms/services/rooms.js');
      const access = await resolveUserRoomAccess(1);
      expect(access.planIds.sort()).toEqual(['founder', 'partner']);
      expect(access.passIds).toEqual(['pass_a']);
    });
  });

  describe('purchaseRigRoomSlot — worker fail-closed', () => {
    const IDEM = 'roomkey12';

    it('delega ao hardware worker', async () => {
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      const result = await purchaseRigRoomSlot(1, 'room_founder', 1, IDEM);
      expect(result).toMatchObject({ ok: true, roomId: 'room_founder', slotsPurchased: 1 });
      expect(callRoomPurchaseSlot).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, roomId: 'room_founder', quantity: 1, idempotencyKey: IDEM })
      );
    });

    it('mapeia HardwareMarketError → HttpControlledError (ROOM_ACCESS_DENIED)', async () => {
      callRoomPurchaseSlot.mockRejectedValue(
        new HardwareMarketError(401, {
          ok: false,
          error: 'This room is exclusive — your plan or season pass does not unlock it.',
          code: 'ROOM_ACCESS_DENIED'
        })
      );
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      await expect(purchaseRigRoomSlot(1, 'room_founder', 1, IDEM)).rejects.toMatchObject({
        statusCode: 401,
        jsonBody: expect.objectContaining({ code: 'ROOM_ACCESS_DENIED' })
      });
    });

    it('saldo insuficiente: 400 com missing', async () => {
      callRoomPurchaseSlot.mockRejectedValue(
        new HardwareMarketError(400, { ok: false, error: 'Insufficient USDC balance.', missing: 10 })
      );
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      await expect(purchaseRigRoomSlot(1, 'room_founder', 1, IDEM)).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: expect.objectContaining({ missing: expect.any(Number) })
      });
    });

    it('quantidade clampada a 50 antes do worker', async () => {
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      await purchaseRigRoomSlot(1, 'room_founder', 999, IDEM);
      expect(callRoomPurchaseSlot).toHaveBeenCalledWith(expect.objectContaining({ quantity: 50 }));
    });

    it('idempotencyKey vazia: 400 sem chamar worker', async () => {
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      await expect(purchaseRigRoomSlot(1, 'room_founder', 1, '')).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
      });
      expect(callRoomPurchaseSlot).not.toHaveBeenCalled();
    });

    it('GENESIS_HARDWARE_URL unset: propaga throw', async () => {
      callRoomPurchaseSlot.mockRejectedValue(new Error('GENESIS_HARDWARE_URL unset'));
      const { purchaseRigRoomSlot } = await import('../../../../server/modules/rooms/services/rooms.js');
      await expect(purchaseRigRoomSlot(1, 'room_founder', 1, IDEM)).rejects.toThrow('GENESIS_HARDWARE_URL unset');
    });
  });
});
