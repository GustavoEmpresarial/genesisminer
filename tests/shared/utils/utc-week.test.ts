import { describe, expect, it } from 'vitest';
import { previousUtcWeekStartMs, utcWeekStartMs } from '../../../server/shared/utils/utc-week.js';

describe('utcWeekStartMs', () => {
  it('devolve segunda 00:00 UTC da semana', () => {
    // 2026-01-07 é quarta-feira UTC
    const wed = Date.UTC(2026, 0, 7, 15, 30, 0);
    expect(utcWeekStartMs(wed)).toBe(Date.UTC(2026, 0, 5, 0, 0, 0, 0));
  });

  it('domingo pertence à semana que começou na segunda anterior', () => {
    const sun = Date.UTC(2026, 0, 11, 12, 0, 0);
    expect(utcWeekStartMs(sun)).toBe(Date.UTC(2026, 0, 5, 0, 0, 0, 0));
  });

  it('já em cima da segunda 00:00 devolve o próprio instante', () => {
    const mon = Date.UTC(2026, 0, 5, 0, 0, 0, 0);
    expect(utcWeekStartMs(mon)).toBe(mon);
  });
});

describe('previousUtcWeekStartMs', () => {
  it('devolve a segunda da semana anterior', () => {
    const wed = Date.UTC(2026, 0, 7, 15, 30, 0);
    expect(previousUtcWeekStartMs(wed)).toBe(Date.UTC(2025, 11, 29, 0, 0, 0, 0));
  });
});
