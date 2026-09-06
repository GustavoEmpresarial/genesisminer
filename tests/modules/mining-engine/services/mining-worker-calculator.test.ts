import { afterEach, describe, expect, it, vi } from 'vitest';

describe('mining-worker-client calculator snapshot', () => {
  const prev = process.env.GENESIS_MINING_WORKER_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.GENESIS_MINING_WORKER_URL;
    else process.env.GENESIS_MINING_WORKER_URL = prev;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerCalculatorSnapshot } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerCalculatorSnapshot(1, 'total')).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('happy path maps camelCase snapshot', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    const payload = {
      ok: true,
      scope: 'total',
      scopesUi: [{ id: 'total', name: 'Poder Total' }],
      generalPowerHps: 10,
      coinComparisons: [],
      coins: [
        {
          id: 'GHO',
          symbol: 'GHO',
          name: 'GHO',
          priceUSD: 1,
          networkHashrate: 965,
          blockReward: 1,
          blockTime: 600,
          userPowerHps: 100,
          dailyCoins: 14.4,
          dailyUsd: 14.4,
          projection30Usd: 432,
          nftRoomOnly: true,
          independentPool: true,
          rows: [{ label: '24 Horas', coins: 14.4, usd: 14.4 }],
          blockHistory: []
        }
      ]
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload)
      }))
    );
    const { callMiningWorkerCalculatorSnapshot } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerCalculatorSnapshot(7, 'total');
    expect(out.scope).toBe('total');
    expect(out.coins[0].independentPool).toBe(true);
    expect(out.coins[0].networkHashrate).toBe(965);
    expect(fetch).toHaveBeenCalledWith(
      'http://mining.test/v1/calculator/snapshot',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('422 INVALID_SCOPE → HttpControlledError', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ ok: false, error: 'Invalid scope parameter.', code: 'INVALID_SCOPE' })
      }))
    );
    const { callMiningWorkerCalculatorSnapshot } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    await expect(callMiningWorkerCalculatorSnapshot(1, 'sala!')).rejects.toBeInstanceOf(HttpControlledError);
    try {
      await callMiningWorkerCalculatorSnapshot(1, 'sala!');
    } catch (e) {
      expect((e as InstanceType<typeof HttpControlledError>).statusCode).toBe(422);
      expect((e as InstanceType<typeof HttpControlledError>).jsonBody.code).toBe('INVALID_SCOPE');
    }
  });

  it('403 FORBIDDEN_SCOPE → HttpControlledError', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ ok: false, error: 'No access to this room.', code: 'FORBIDDEN_SCOPE' })
      }))
    );
    const { callMiningWorkerCalculatorSnapshot } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    try {
      await callMiningWorkerCalculatorSnapshot(1, 'room_x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpControlledError);
      expect((e as InstanceType<typeof HttpControlledError>).statusCode).toBe(403);
      expect((e as InstanceType<typeof HttpControlledError>).jsonBody.code).toBe('FORBIDDEN_SCOPE');
    }
  });
});
