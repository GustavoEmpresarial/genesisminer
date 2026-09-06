import { describe, expect, it } from 'vitest';
import { normalizePlacedRackRoomId } from '../../../../server/modules/mining-engine/services/rack-room-id.js';

describe('normalizePlacedRackRoomId', () => {
  it('null/vazio/"main" viram room_initial', () => {
    expect(normalizePlacedRackRoomId(null)).toBe('room_initial');
    expect(normalizePlacedRackRoomId('')).toBe('room_initial');
    expect(normalizePlacedRackRoomId('main')).toBe('room_initial');
  });

  it('outros ids passam trimados', () => {
    expect(normalizePlacedRackRoomId('  room_x  ')).toBe('room_x');
  });
});
