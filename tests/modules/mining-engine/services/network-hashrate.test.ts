import { describe, expect, it } from 'vitest';
import {
  assessNetworkFloorSanity,
  effectiveNetworkHashrateForCoin,
  networkHashrateFromYieldPerHash
} from '../../../../server/modules/mining-engine/services/network-hashrate.js';

describe('effectiveNetworkHashrateForCoin', () => {
  it('usa max(runtime, floor) — alinhado ao yield-cron', () => {
    expect(effectiveNetworkHashrateForCoin('btc', 100, new Map([['btc', 1e12]]))).toBe(1e12);
    // live < floor: mining usa o floor (calculadora antiga usava live e sobrestimava)
    expect(effectiveNetworkHashrateForCoin('btc', 1e12, new Map([['btc', 100]]))).toBe(1e12);
  });

  it('cai no floor da BD quando runtime ausente', () => {
    expect(effectiveNetworkHashrateForCoin('x', 500, new Map())).toBe(500);
  });

  it('usa rede implícita do yield quando runtime vazio', () => {
    const implied = new Map<string, number>([['pol', 9_000]]);
    expect(effectiveNetworkHashrateForCoin('pol', 100, new Map(), implied)).toBe(9_000);
  });

  it('pool independente: floor-only; ignora live e implied', () => {
    const implied = new Map<string, number>([['gho', 50_000]]);
    expect(
      effectiveNetworkHashrateForCoin('gho', 500, new Map([['gho', 1e12]]), implied, {
        independentPool: true
      })
    ).toBe(500);
    expect(
      effectiveNetworkHashrateForCoin('gho', 965, new Map([['gho', 5_216]]), implied, {
        independentPool: true
      })
    ).toBe(965);
    expect(
      effectiveNetworkHashrateForCoin('gho', 965, new Map(), implied, {
        independentPool: true
      })
    ).toBe(965);
  });

  it('pool independente com piso 0 cai no mínimo de sanidade', () => {
    expect(effectiveNetworkHashrateForCoin('x', 0, new Map(), undefined, { independentPool: true })).toBe(1);
    expect(
      effectiveNetworkHashrateForCoin('x', 0, new Map([['x', 999]]), undefined, { independentPool: true })
    ).toBe(1);
  });
});

describe('networkHashrateFromYieldPerHash', () => {
  it('inverte yield_per_hash = (br/bt)/net', () => {
    // br=6, bt=60 → reward/s=0.1; yph=0.0001 → net=1000
    expect(networkHashrateFromYieldPerHash(0.0001, 6, 60)).toBeCloseTo(1000, 6);
  });
});

describe('assessNetworkFloorSanity', () => {
  it('GHO: piso 197 + maior minerador 200 H/s → warn (dominância)', () => {
    const r = assessNetworkFloorSanity({ floorHps: 197, liveNetworkHps: 197, largestMinerHps: 200 });
    expect(r.level).toBe('warn');
    expect(r.dominancePct).toBeCloseTo((200 / 197) * 100, 4);
    expect(r.message).toMatch(/200.*Confirma\?/);
  });

  it('POL: piso 33k + live 29k → ok (piso acima do live, sem dominância extrema)', () => {
    const r = assessNetworkFloorSanity({ floorHps: 33_000, liveNetworkHps: 29_000, largestMinerHps: 5_000 });
    expect(r.level).toBe('ok');
  });

  it('warn quando piso muito abaixo do live (inflação)', () => {
    const r = assessNetworkFloorSanity({ floorHps: 100, liveNetworkHps: 5_000 });
    expect(r.level).toBe('warn');
    expect(r.message).toMatch(/inflacionar/);
  });

  it('ok quando piso e live proporcionais', () => {
    const r = assessNetworkFloorSanity({ floorHps: 2_000, liveNetworkHps: 5_000, largestMinerHps: 500 });
    expect(r.level).toBe('ok');
  });
});

describe('progress-computer alignment', () => {
  it('substitui Math.max(live, floor) por effectiveNetworkHashrateForCoin (sem implied)', () => {
    const floor = 1_000;
    const live = 250;
    const legacy = Math.max(live, floor > 0 ? floor : 1);
    expect(effectiveNetworkHashrateForCoin('x', floor, new Map([['x', live]]))).toBe(legacy);
  });

  it('inclui implied quando runtime vazio (progress-computer com yield history)', () => {
    const implied = new Map<string, number>([['pol', 9_000]]);
    expect(effectiveNetworkHashrateForCoin('pol', 100, new Map(), implied)).toBe(9_000);
  });
});
