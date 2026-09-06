import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mining-ranking', () => {
  let rankingClientMock: {
    callRankingPublic: ReturnType<typeof vi.fn>;
    callRankingAdmin: ReturnType<typeof vi.fn>;
    callRankingMe: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    rankingClientMock = {
      callRankingPublic: vi.fn().mockResolvedValue({
        timestamp: 1,
        ranking: [],
        coins: [{ id: 'btc', name: 'Bitcoin', symbol: 'BTC' }]
      }),
      callRankingAdmin: vi.fn().mockResolvedValue({ timestamp: 1, ranking: [], coins: [] }),
      callRankingMe: vi.fn().mockResolvedValue({ position: null, totalRanked: 0, hash: 0 })
    };
    vi.doMock('../../../../server/modules/ranking/services/ranking-worker-client.js', () => rankingClientMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/ranking/services/ranking-worker-client.js');
  });

  describe('sumGeneralRankingPower', () => {
    it('soma só valores positivos', async () => {
      const { sumGeneralRankingPower } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      expect(sumGeneralRankingPower({ btc: 10, eth: -5, ltc: 0 })).toBe(10);
      expect(sumGeneralRankingPower(null)).toBe(0);
    });
  });

  describe('getPublicMiningRankingPayload', () => {
    it('delega ao HTTP worker', async () => {
      const payload = {
        timestamp: 42,
        ranking: [{ user_id: 1, username: 'alice', coins: { btc: 10 }, generalCoins: { btc: 10 } }],
        coins: [{ id: 'btc', name: 'Bitcoin', symbol: 'BTC' }]
      };
      rankingClientMock.callRankingPublic.mockResolvedValue(payload);
      const { getPublicMiningRankingPayload } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      expect(await getPublicMiningRankingPayload()).toEqual(payload);
      expect(rankingClientMock.callRankingPublic).toHaveBeenCalledWith(false);
    });

    it('{ fresh: true } passa fresh ao worker', async () => {
      const { getPublicMiningRankingPayload } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      await getPublicMiningRankingPayload({ fresh: true });
      expect(rankingClientMock.callRankingPublic).toHaveBeenCalledWith(true);
    });
  });

  describe('getAdminMiningRankingPayload', () => {
    it('delega ao HTTP worker', async () => {
      const payload = {
        timestamp: 7,
        ranking: [{ user_id: 2, username: 'bob', coins: {}, generalCoins: {}, balances: { btc: 5 } }],
        coins: [{ id: 'btc', name: 'Bitcoin', symbol: 'BTC' }]
      };
      rankingClientMock.callRankingAdmin.mockResolvedValue(payload);
      const { getAdminMiningRankingPayload } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      expect(await getAdminMiningRankingPayload()).toEqual(payload);
      expect(rankingClientMock.callRankingAdmin).toHaveBeenCalledOnce();
    });
  });

  describe('getMyGlobalMiningRank', () => {
    it('userId inválido: devolve posição nula sem HTTP', async () => {
      const { getMyGlobalMiningRank } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      expect(await getMyGlobalMiningRank(0)).toEqual({ position: null, totalRanked: 0, hash: 0 });
      expect(rankingClientMock.callRankingMe).not.toHaveBeenCalled();
    });

    it('delega ao HTTP worker', async () => {
      rankingClientMock.callRankingMe.mockResolvedValue({ position: 1, totalRanked: 4, hash: 10 });
      const { getMyGlobalMiningRank } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      expect(await getMyGlobalMiningRank(1)).toEqual({ position: 1, totalRanked: 4, hash: 10 });
      expect(rankingClientMock.callRankingMe).toHaveBeenCalledWith(1, false);
    });

    it('{ fresh: true } passa fresh ao worker', async () => {
      const { getMyGlobalMiningRank } = await import('../../../../server/modules/ranking/services/mining-ranking.js');
      await getMyGlobalMiningRank(3, { fresh: true });
      expect(rankingClientMock.callRankingMe).toHaveBeenCalledWith(3, true);
    });
  });

  describe('startPublicMiningRankingRefreshLoop', () => {
    it('sempre no-op: não agenda setInterval', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      try {
        const { startPublicMiningRankingRefreshLoop, RANKING_REFRESH_INTERVAL_MS } = await import(
          '../../../../server/modules/ranking/services/mining-ranking.js'
        );
        const stop = startPublicMiningRankingRefreshLoop(RANKING_REFRESH_INTERVAL_MS);
        expect(typeof stop).toBe('function');
        expect(setIntervalSpy).not.toHaveBeenCalled();
        stop();
      } finally {
        setIntervalSpy.mockRestore();
      }
    });
  });
});
