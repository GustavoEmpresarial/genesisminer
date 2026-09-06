import { describe, expect, it } from 'vitest';
import {
  CHECKIN_GRACE_MS,
  canEarlyCheckinForNextPeriod,
  hasCheckedInCurrentPeriod,
  isEarlyCheckinTimestamp,
  isWithinActiveCheckinWindow,
  nextCheckinPeriodEndMs,
  nextCheckinPeriodStartMs,
  nextUtcDay,
  previousUtcDay,
  utcCheckinPeriodStartMs,
  utcDayFromMs,
  utcDayStartMs
} from '../../../../server/modules/checkin/services/checkin.js';

describe('utcDayFromMs / previousUtcDay / nextUtcDay', () => {
  it('utcDayFromMs usa dia civil UTC', () => {
    expect(utcDayFromMs(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(utcDayFromMs(Date.UTC(2026, 0, 1, 0, 0, 0) - 1)).toBe('2025-12-31');
    expect(utcDayFromMs(Date.UTC(2026, 0, 1, 23, 59, 0))).toBe('2026-01-01');
  });

  it('previous/next atravessam mês/ano', () => {
    expect(previousUtcDay('2026-01-01')).toBe('2025-12-31');
    expect(nextUtcDay('2025-12-31')).toBe('2026-01-01');
  });
});

describe('utc period boundaries', () => {
  const dayStart = Date.UTC(2026, 0, 1, 0, 0, 0);

  it('period start is UTC midnight', () => {
    expect(utcCheckinPeriodStartMs(dayStart + 15 * 3600_000)).toBe(dayStart);
    expect(utcDayStartMs('2026-01-01')).toBe(dayStart);
  });

  it('next period is +24h', () => {
    expect(nextCheckinPeriodEndMs(dayStart)).toBe(dayStart + 24 * 3600_000);
    expect(nextCheckinPeriodStartMs(dayStart + 1000)).toBe(dayStart + 24 * 3600_000);
  });
});

describe('48h grace + same-day checkin', () => {
  const last = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('mining active within 48h', () => {
    expect(isWithinActiveCheckinWindow(last, last + CHECKIN_GRACE_MS)).toBe(true);
    expect(isWithinActiveCheckinWindow(last, last + CHECKIN_GRACE_MS + 1)).toBe(false);
  });

  it('todayCheckedIn only same UTC day', () => {
    expect(hasCheckedInCurrentPeriod(last, Date.UTC(2026, 0, 1, 23, 0, 0))).toBe(true);
    expect(hasCheckedInCurrentPeriod(last, Date.UTC(2026, 0, 2, 0, 0, 0))).toBe(false);
  });

  it('can check in next UTC day while still within grace', () => {
    const nextMorning = Date.UTC(2026, 0, 2, 10, 0, 0);
    expect(isWithinActiveCheckinWindow(last, nextMorning)).toBe(true);
    expect(hasCheckedInCurrentPeriod(last, nextMorning)).toBe(false);
  });

  it('early helpers disabled', () => {
    expect(canEarlyCheckinForNextPeriod(last, last + 1000)).toBe(false);
    expect(isEarlyCheckinTimestamp(last, last + 1000)).toBe(false);
  });
});
