import { afterEach, describe, expect, it } from 'vitest';
import { miningRuntimeStats } from '../../../../../server/modules/mining-engine/services/runtime-stats.js';
import { getMiningRuntimeSummary } from '../../../../../server/modules/admin/mining-runtime-summary/services/mining-runtime-summary.js';

function resetRuntime() {
  miningRuntimeStats.globalNetworkHashrates.clear();
  miningRuntimeStats.globalActiveMinersByCoin.clear();
  miningRuntimeStats.globalActiveMiners = 0;
}

describe('getMiningRuntimeSummary', () => {
  afterEach(() => {
    resetRuntime();
  });

  it('ausência de miners → zeros e objectos vazios', () => {
    resetRuntime();
    expect(getMiningRuntimeSummary()).toEqual({
      realActiveMiners: 0,
      realNetworkHashrates: {},
      activeMinersByCoin: {}
    });
  });

  it('múltiplas moedas + runtime zero numa delas', () => {
    miningRuntimeStats.globalNetworkHashrates.set('btc', 12.5);
    miningRuntimeStats.globalNetworkHashrates.set('eth', 0);
    miningRuntimeStats.globalActiveMinersByCoin.set('btc', 3);
    miningRuntimeStats.globalActiveMinersByCoin.set('eth', 0);
    miningRuntimeStats.globalActiveMiners = 3;
    expect(getMiningRuntimeSummary()).toEqual({
      realActiveMiners: 3,
      realNetworkHashrates: { btc: 12.5, eth: 0 },
      activeMinersByCoin: { btc: 3, eth: 0 }
    });
  });

  it('não muta o Map fonte (snapshot Object.fromEntries)', () => {
    miningRuntimeStats.globalNetworkHashrates.set('btc', 1);
    const snap = getMiningRuntimeSummary();
    snap.realNetworkHashrates.btc = 99;
    expect(miningRuntimeStats.globalNetworkHashrates.get('btc')).toBe(1);
  });

  it('aceita fonte injectada (estados nulos/inválidos no Map vazio)', () => {
    const stats = {
      globalNetworkHashrates: new Map<string, number>(),
      globalActiveMiners: 0,
      globalActiveMinersByCoin: new Map<string, number>()
    };
    expect(getMiningRuntimeSummary(stats).realActiveMiners).toBe(0);
  });
});
