import { describe, expect, it } from 'vitest';
import { computeNftRoomPaybackStats } from '../../../../client/src/features/servers/models/nftRoomPaybackModel.js';
import {
  ASIC_LEASE_NO_CLOCK_EXPIRES_AT,
  isTimedAsicLeasePast,
  visibleMachineSlotId,
  type AsicLeaseDetail,
  type PlacedRack,
  type Upgrade
} from '../../../../client/src/features/servers/types.js';

const NOW_MS = 1_700_000_000_000;
const ROOM_ID = 'room-a';

function lease(
  expiresAt: number,
  leaseId = 'lease-1'
): AsicLeaseDetail {
  return {
    leaseId,
    itemId: 'asic_s19',
    expiresAt,
    status: 'equipped',
    rackId: 'rack-1',
    slotIndex: 0
  };
}

function rack(): PlacedRack {
  return {
    id: 'rack-1',
    itemId: 'rack_10u',
    slots: ['asic_s19'],
    slotLeaseIds: ['lease-1'],
    roomId: ROOM_ID,
    slotIndex: 0,
    wiringId: 'wire',
    batteryId: 'bat',
    multiplierSlots: [],
    isOn: true
  };
}

const upgrade: Upgrade = {
  id: 'asic_s19',
  name: 'S19',
  category: 'asic',
  type: 'machine',
  baseCost: 100,
  baseProduction: 10,
  description: '',
  icon: '',
  status: 'normal'
};

describe('expired asic slot', () => {
  it('hides a lease whose clock has already passed', () => {
    const past = lease(NOW_MS - 1);
    expect(isTimedAsicLeasePast(past.expiresAt, NOW_MS)).toBe(true);
    expect(visibleMachineSlotId('asic_s19', past, NOW_MS)).toBeNull();
    const stats = computeNftRoomPaybackStats([rack()], ROOM_ID, [upgrade], [], 0, [past], NOW_MS);
    expect(stats.asics).toEqual([]);
  });

  it('keeps a lease that is still inside its life', () => {
    const future = lease(NOW_MS + 1);
    expect(isTimedAsicLeasePast(future.expiresAt, NOW_MS)).toBe(false);
    expect(visibleMachineSlotId('asic_s19', future, NOW_MS)).toBe('asic_s19');
    const stats = computeNftRoomPaybackStats([rack()], ROOM_ID, [upgrade], [], 0, [future], NOW_MS);
    expect(stats.asics.map((row) => row.upgradeId)).toEqual(['asic_s19']);
  });

  it('keeps a permanent machine and a slot with no lease clock', () => {
    const permanent = lease(ASIC_LEASE_NO_CLOCK_EXPIRES_AT);
    expect(isTimedAsicLeasePast(permanent.expiresAt, NOW_MS)).toBe(false);
    expect(isTimedAsicLeasePast(undefined, NOW_MS)).toBe(false);
    expect(visibleMachineSlotId('asic_s19', permanent, NOW_MS)).toBe('asic_s19');
    expect(visibleMachineSlotId('asic_s19', undefined, NOW_MS)).toBe('asic_s19');
    const stats = computeNftRoomPaybackStats(
      [rack()],
      ROOM_ID,
      [upgrade],
      [],
      0,
      [permanent],
      NOW_MS
    );
    expect(stats.asics).toHaveLength(1);
  });
});
