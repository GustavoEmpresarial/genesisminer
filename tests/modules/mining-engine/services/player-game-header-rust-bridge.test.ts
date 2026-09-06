import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateHeaderHash,
  tsAggregateHeaderHash
} from '../../../../server/modules/mining-engine/services/player-game-header-rust-bridge.js';

describe('player-game-header-rust-bridge', () => {
  afterEach(() => {
    delete process.env.GENESIS_HEADER_RUST;
  });

  it('tsAggregateHeaderHash: totalHash só créditos general', () => {
    const out = tsAggregateHeaderHash([
      { coinId: 'btc', effectiveHps: 10, countsTowardGeneralPower: true },
      { coinId: 'usdt', effectiveHps: 50, countsTowardGeneralPower: false },
      { coinId: 'btc', effectiveHps: 5, countsTowardGeneralPower: true }
    ]);
    expect(out.hashByCoinId).toEqual({ btc: 15, usdt: 50 });
    expect(out.totalHash).toBe(15);
  });

  it('aggregateHeaderHash sem flag: fallback TS', () => {
    delete process.env.GENESIS_HEADER_RUST;
    const out = aggregateHeaderHash([
      { coinId: 'eth', effectiveHps: 3, countsTowardGeneralPower: true },
      { coinId: 'nft', effectiveHps: 9, countsTowardGeneralPower: false }
    ]);
    expect(out).toEqual({ hashByCoinId: { eth: 3, nft: 9 }, totalHash: 3 });
  });
});
