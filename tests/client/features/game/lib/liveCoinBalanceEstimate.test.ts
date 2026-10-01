import { describe, expect, it } from 'vitest';
import {
  estimateLiveCoinBalance,
  lastCompletedTenMinuteUtcGrid,
  LIVE_BALANCE_TICK_MS
} from '../../../../../client/src/features/game/lib/liveCoinBalanceEstimate.js';

describe('liveCoinBalanceEstimate', () => {
  it('exposes LIVE_BALANCE_TICK_MS as 1s', () => {
    expect(LIVE_BALANCE_TICK_MS).toBe(1000);
  });

  it('lastCompletedTenMinuteUtcGrid floors to UTC 10-minute boundary', () => {
    const nowMs = Date.UTC(2024, 0, 1, 12, 34, 56);
    expect(lastCompletedTenMinuteUtcGrid(nowMs)).toBe(Date.UTC(2024, 0, 1, 12, 30, 0));
    expect(lastCompletedTenMinuteUtcGrid(0)).toBe(0);
    expect(lastCompletedTenMinuteUtcGrid(Number.NaN)).toBe(0);
  });

  it('estimateLiveCoinBalance accrues coinsPerSec from anchor', () => {
    const anchor = 1_700_000_000_000;
    const elapsedSec = 30;
    expect(
      estimateLiveCoinBalance({
        serverBalance: 100,
        coinsPerSec: 2,
        accrualAnchorMs: anchor,
        nowMs: anchor + elapsedSec * LIVE_BALANCE_TICK_MS
      })
    ).toBe(100 + 2 * elapsedSec);
  });

  it('estimateLiveCoinBalance never goes below server balance for past nowMs', () => {
    expect(
      estimateLiveCoinBalance({
        serverBalance: 50,
        coinsPerSec: 10,
        accrualAnchorMs: 1000,
        nowMs: 500
      })
    ).toBe(50);
  });
});
