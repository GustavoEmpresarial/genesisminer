import { afterEach, describe, expect, it } from 'vitest';
import {
  BLACK_MARKET_DEFAULT_LIMIT,
  BLACK_MARKET_MAX_OFFSET,
  BLACK_MARKET_MAX_PAGE,
  MARKET_RESERVE_MS,
  TAX_PERCENT_MAX,
  TAX_PERCENT_MIN,
  tsClampBlackMarketLimit,
  tsClampBlackMarketOffset,
  tsClampTaxPercent,
  tsComputeP2PBandReferenceUsd,
  tsComputeReservedUntil,
  tsIsReservationActive
} from '../../../../server/modules/black-market/services/black-market-rust-bridge.js';
import { MS_PER_MINUTE } from '../../../../server/shared/utils/time.js';

describe('black-market-rust-bridge TS domain', () => {
  afterEach(() => {
    delete process.env.GENESIS_MARKET_RUST;
  });

  it('reserve ms = 3 minutes', () => {
    expect(MARKET_RESERVE_MS).toBe(3 * MS_PER_MINUTE);
  });

  it('clamp limit/offset', () => {
    expect(tsClampBlackMarketLimit(undefined)).toBe(BLACK_MARKET_DEFAULT_LIMIT);
    expect(tsClampBlackMarketLimit(500)).toBe(BLACK_MARKET_MAX_PAGE);
    expect(tsClampBlackMarketOffset(undefined)).toBe(0);
    expect(tsClampBlackMarketOffset(999_999)).toBe(BLACK_MARKET_MAX_OFFSET);
  });

  it('tax + reservation + band', () => {
    expect(tsClampTaxPercent(-1)).toBe(TAX_PERCENT_MIN);
    expect(tsClampTaxPercent(150)).toBe(TAX_PERCENT_MAX);
    const now = 1_700_000_000_000;
    expect(tsIsReservationActive(now + 1, now)).toBe(true);
    expect(tsIsReservationActive(now, now)).toBe(false);
    expect(tsComputeReservedUntil(now)).toBe(now + MARKET_RESERVE_MS);
    expect(tsComputeP2PBandReferenceUsd(10, 99)).toBe(10);
    expect(tsComputeP2PBandReferenceUsd(0, 5)).toBe(5);
  });
});
