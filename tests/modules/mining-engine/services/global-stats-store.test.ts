import { describe, expect, it } from 'vitest';
import { getGlobalNetworkStats, setGlobalNetworkStats } from '../../../../server/modules/mining-engine/services/global-stats-store.js';

describe('mining-engine services/global-stats-store', () => {
  it('estado inicial vazio', () => {
    const s = getGlobalNetworkStats();
    expect(s.activeMiners).toBeGreaterThanOrEqual(0);
    expect(s.ranking).toBeInstanceOf(Array);
  });

  it('setGlobalNetworkStats substitui o estado por completo', () => {
    const next = { hashrates: { btc: 100 }, activeMiners: 5, activeMinersByCoin: { btc: 5 }, ranking: [{ user_id: 1, username: 'joe', coins: { btc: 100 }, totalPower: 100 }] };
    setGlobalNetworkStats(next);
    expect(getGlobalNetworkStats()).toEqual(next);
  });
});
