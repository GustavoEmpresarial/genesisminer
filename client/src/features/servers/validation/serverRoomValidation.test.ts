/**
 * Contrato de capacidade da sala — igual a `room-capacity.ts` no servidor.
 */
import { describe, expect, it } from 'vitest';
import { roomEffectiveCapacity, roomPurchasableSlotsRemaining } from './serverRoomValidation';

describe('roomEffectiveCapacity', () => {
  it('nunca excede max (20+1, max 20 → 20)', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 20, maxCapacity: 20 }, 1)).toBe(20);
  });

  it('permite crescer até ao max (20+1, max 21 → 21)', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 20, maxCapacity: 21 }, 1)).toBe(21);
  });

  it('max 0 / initial 0 → 0', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 0, maxCapacity: 0 }, 0)).toBe(0);
  });

  it('max 0 → efectiva 0 mesmo com unlocks', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 0, maxCapacity: 0 }, 5)).toBe(0);
  });

  it('hard cap 18: initial 12 + unlock 9 → 18', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 12, maxCapacity: 18 }, 9)).toBe(18);
  });

  it('initial=max=18 + unlocks → 18', () => {
    expect(roomEffectiveCapacity({ initialCapacity: 18, maxCapacity: 18 }, 17)).toBe(18);
  });
});

describe('roomPurchasableSlotsRemaining', () => {
  it('max 21, initial 20, unlock 0 → 1', () => {
    expect(roomPurchasableSlotsRemaining({ initialCapacity: 20, maxCapacity: 21 }, 0)).toBe(1);
  });

  it('zero quando já no tecto', () => {
    expect(roomPurchasableSlotsRemaining({ initialCapacity: 20, maxCapacity: 20 }, 1)).toBe(0);
    expect(roomPurchasableSlotsRemaining({ initialCapacity: 18, maxCapacity: 18 }, 12)).toBe(0);
  });
});
