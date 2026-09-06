import { describe, expect, it } from 'vitest';
import {
  computeOwnedRoomDiff,
  ensureOwnedRoomIds,
  DEFAULT_PLAYER_OWNED_ROOM_IDS,
  partitionRacksForRoomRevoke,
  roomIdsFromPlacedRacks
} from '../../../../../server/modules/admin/users/services/owned-rooms-diff.js';
import {
  EXTRA_ROOM_ID,
  ROOM_INITIAL_ID
} from '../../../../../server/modules/mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../../../../server/modules/mining-engine/services/room-kind.js';

const ACTIVE = new Set([
  ROOM_INITIAL_ID,
  ASIC_ROOM_ID,
  EXTRA_ROOM_ID,
  'room_vip',
  'room_gold'
]);

describe('ensureOwnedRoomIds', () => {
  it('prefixes all default player rooms', () => {
    expect(ensureOwnedRoomIds(['room_vip'])).toEqual([
      ...DEFAULT_PLAYER_OWNED_ROOM_IDS,
      'room_vip'
    ]);
  });

  it('dedupes when defaults already present', () => {
    expect(ensureOwnedRoomIds([EXTRA_ROOM_ID, ASIC_ROOM_ID, ROOM_INITIAL_ID])).toEqual([
      ...DEFAULT_PLAYER_OWNED_ROOM_IDS
    ]);
  });
});

describe('computeOwnedRoomDiff', () => {
  it('grants new rooms and revokes unchecked active rooms', () => {
    const { toAdd, toRemove } = computeOwnedRoomDiff({
      currentIds: [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID, 'room_vip'],
      desiredIds: [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID, 'room_gold'],
      activeIds: ACTIVE
    });
    expect(toAdd.sort()).toEqual(['room_gold']);
    expect(toRemove.sort()).toEqual(['room_vip']);
  });

  it('never revokes default rooms even if omitted from desired', () => {
    const { toAdd, toRemove } = computeOwnedRoomDiff({
      currentIds: [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID, 'room_vip'],
      desiredIds: ['room_vip'],
      activeIds: ACTIVE
    });
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  it('revokes other rooms while keeping defaults when desired is empty', () => {
    const { toAdd, toRemove } = computeOwnedRoomDiff({
      currentIds: [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID, 'room_vip'],
      desiredIds: [],
      activeIds: ACTIVE
    });
    expect(toAdd).toEqual([]);
    expect(toRemove.sort()).toEqual(['room_vip']);
  });

  it('ignores inactive / unknown ids', () => {
    const { toAdd, toRemove } = computeOwnedRoomDiff({
      currentIds: [ROOM_INITIAL_ID, 'room_dead'],
      desiredIds: [ROOM_INITIAL_ID, 'room_vip', 'room_dead'],
      activeIds: ACTIVE
    });
    expect(toAdd).toEqual(['room_vip']);
    expect(toRemove).toEqual([]);
  });
});

describe('roomIdsFromPlacedRacks', () => {
  it('normalizes blank/main and dedupes', () => {
    expect(
      roomIdsFromPlacedRacks([
        { roomId: '' },
        { roomId: 'main' },
        { roomId: EXTRA_ROOM_ID },
        { roomId: EXTRA_ROOM_ID },
        { roomId: 'room_vip' }
      ])
    ).toEqual([ROOM_INITIAL_ID, EXTRA_ROOM_ID, 'room_vip']);
  });
});

describe('partitionRacksForRoomRevoke', () => {
  it('matches blank/main room ids to room_initial', () => {
    const { keep, removed } = partitionRacksForRoomRevoke(
      [{ roomId: '' }, { roomId: 'main' }, { roomId: EXTRA_ROOM_ID }, { roomId: 'room_vip' }],
      [ROOM_INITIAL_ID, EXTRA_ROOM_ID]
    );
    expect(removed.map((r) => r.roomId).sort()).toEqual(['', 'main', EXTRA_ROOM_ID].sort());
    expect(keep.map((r) => r.roomId)).toEqual(['room_vip']);
  });
});
