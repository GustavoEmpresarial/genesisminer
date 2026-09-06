import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRA_ROOM_ID } from '../../../../server/modules/mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../../../server/modules/mining-engine/services/room-kind.js';

describe('modules/rooms/services/grant-default-asic-room', () => {
  let prismaMock: { prisma: { user_rig_rooms: { createMany: ReturnType<typeof vi.fn> } } };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        user_rig_rooms: { createMany: vi.fn().mockResolvedValue({ count: 2 }) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  async function loadHelper() {
    return import('../../../../server/modules/rooms/services/grant-default-asic-room.js');
  }

  it('createMany skipDuplicates com ASICs + EXTRA e unlocked_slots default', async () => {
    const {
      ensureUserHasDefaultPlayerRooms,
      ensureUserHasDefaultAsicRoom,
      DEFAULT_ASIC_UNLOCKED_SLOTS
    } = await loadHelper();
    expect(ensureUserHasDefaultAsicRoom).toBe(ensureUserHasDefaultPlayerRooms);
    await ensureUserHasDefaultPlayerRooms(42);
    expect(DEFAULT_ASIC_UNLOCKED_SLOTS).toBe(0);
    expect(prismaMock.prisma.user_rig_rooms.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.prisma.user_rig_rooms.createMany).toHaveBeenCalledWith({
      data: [
        {
          user_id: 42,
          room_id: ASIC_ROOM_ID,
          purchased_at: expect.any(BigInt),
          unlocked_slots: DEFAULT_ASIC_UNLOCKED_SLOTS
        },
        {
          user_id: 42,
          room_id: EXTRA_ROOM_ID,
          purchased_at: expect.any(BigInt),
          unlocked_slots: DEFAULT_ASIC_UNLOCKED_SLOTS
        }
      ],
      skipDuplicates: true
    });
  });

  it('alias ensureUserHasDefaultAsicRoom chama a mesma grant', async () => {
    const { ensureUserHasDefaultAsicRoom, DEFAULT_ASIC_UNLOCKED_SLOTS } = await loadHelper();
    await ensureUserHasDefaultAsicRoom(7);
    expect(prismaMock.prisma.user_rig_rooms.createMany).toHaveBeenCalledWith({
      data: [
        {
          user_id: 7,
          room_id: ASIC_ROOM_ID,
          purchased_at: expect.any(BigInt),
          unlocked_slots: DEFAULT_ASIC_UNLOCKED_SLOTS
        },
        {
          user_id: 7,
          room_id: EXTRA_ROOM_ID,
          purchased_at: expect.any(BigInt),
          unlocked_slots: DEFAULT_ASIC_UNLOCKED_SLOTS
        }
      ],
      skipDuplicates: true
    });
  });

  it('não grava se userId inválido', async () => {
    const { ensureUserHasDefaultPlayerRooms } = await loadHelper();
    await ensureUserHasDefaultPlayerRooms(0);
    await ensureUserHasDefaultPlayerRooms(-1);
    await ensureUserHasDefaultPlayerRooms(Number.NaN);
    await ensureUserHasDefaultPlayerRooms(1.5);
    expect(prismaMock.prisma.user_rig_rooms.createMany).not.toHaveBeenCalled();
  });
});
