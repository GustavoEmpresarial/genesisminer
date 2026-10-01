/**
 * Public ranking POWER sort — uses generalCoins (excludes NFT/ASIC room power).
 */
import { describe, expect, it } from 'vitest';
import type { PublicRankingPayload, PublicRankingUser } from '../../../../client/src/shared/api/ranking.js';
import {
  getSortedRanking,
  sumGeneralPower
} from '../../../../client/src/features/ranking/lib/sortPublicRanking.js';

const COINS = [
  { id: 'btc', name: 'Bitcoin', symbol: 'BTC' },
  { id: 'eth', name: 'Ethereum', symbol: 'ETH' }
];

function payload(ranking: PublicRankingUser[]): PublicRankingPayload {
  return { timestamp: 0, ranking, coins: COINS };
}

describe('sumGeneralPower / getSortedRanking', () => {
  it('ALL: sums generalCoins; ASIC-only (coins filled, generalCoins {}) → power 0 / filtered out', () => {
    const asicOnly: PublicRankingUser = {
      user_id: 1,
      username: 'asic',
      coins: { btc: 1000, eth: 500 },
      generalCoins: {}
    };
    const gpu: PublicRankingUser = {
      user_id: 2,
      username: 'gpu',
      coins: { btc: 100 },
      generalCoins: { btc: 80, eth: 20 }
    };
    const data = payload([asicOnly, gpu]);

    expect(sumGeneralPower(asicOnly, data)).toBe(0);
    expect(sumGeneralPower(gpu, data)).toBe(100);

    const { list, activeCoin } = getSortedRanking(data, 'ALL');
    expect(activeCoin).toBe('ALL');
    expect(list).toHaveLength(1);
    expect(list[0]?.user_id).toBe(2);
    expect(list[0]?.power).toBe(100);
  });

  it('per-coin: coins has value, generalCoins missing/0 → power 0 / filtered out', () => {
    const missing: PublicRankingUser = {
      user_id: 1,
      username: 'missing',
      coins: { btc: 999 },
      generalCoins: {}
    };
    const zero: PublicRankingUser = {
      user_id: 2,
      username: 'zero',
      coins: { btc: 50 },
      generalCoins: { btc: 0 }
    };
    const data = payload([missing, zero]);

    const { list } = getSortedRanking(data, 'btc');
    expect(list).toHaveLength(0);
  });

  it('per-coin: generalCoins has value → sorts by that (not coins)', () => {
    const lowCoinsHighGeneral: PublicRankingUser = {
      user_id: 1,
      username: 'a',
      coins: { btc: 10 },
      generalCoins: { btc: 200 }
    };
    const highCoinsLowGeneral: PublicRankingUser = {
      user_id: 2,
      username: 'b',
      coins: { btc: 5000 },
      generalCoins: { btc: 50 }
    };
    const data = payload([highCoinsLowGeneral, lowCoinsHighGeneral]);

    const { list, activeCoin } = getSortedRanking(data, 'btc');
    expect(activeCoin).toBe('btc');
    expect(list.map((u) => u.user_id)).toEqual([1, 2]);
    expect(list[0]?.power).toBe(200);
    expect(list[1]?.power).toBe(50);
  });
});
