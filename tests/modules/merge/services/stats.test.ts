import { describe, expect, it } from 'vitest';
import { computeMergeResultStats, mergeResultDisplayName, statsMatchExisting, type MergeSourceCatalog } from '../../../../server/modules/merge/services/stats.js';
import type { MergeRuntimeSettings } from '../../../../server/modules/merge/services/settings.js';

const SETTINGS: MergeRuntimeSettings = {
  enabled: true,
  enabledMachine: true,
  enabledMultiplier: true,
  enabledInfrastructure: true,
  gainPercent: 5,
  costPctByRarity: { common: 10, uncommon: 15, rare: 20, epic: 25, legendary: 30 },
  rackHsBonusPctByRarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, supreme: 10 }
};

function machineSource(overrides: Partial<MergeSourceCatalog> = {}): MergeSourceCatalog {
  return {
    id: 'gpu_1',
    name: 'GPU X',
    category: 'gpu',
    type: 'machine',
    rarity: 'common',
    base_cost: 100,
    base_production: 10,
    power_consumption: 200,
    multiplier: null,
    slots_capacity: null,
    ai_slots_capacity: null,
    description: '',
    icon: '📦',
    image: null,
    status: 'normal',
    ...overrides
  };
}

describe('mergeResultDisplayName', () => {
  it('prefixa "Merged " sem duplicar se já tiver o prefixo', () => {
    expect(mergeResultDisplayName('GPU X')).toBe('Merged GPU X');
    expect(mergeResultDisplayName('Merged GPU X')).toBe('Merged GPU X');
  });
});

describe('computeMergeResultStats', () => {
  it('supreme não gera resultado (não é raridade de origem válida)', () => {
    expect(computeMergeResultStats(machineSource({ rarity: 'supreme' }), SETTINGS)).toBeNull();
  });

  it('machine: dobra base_cost/base_production com o ganho, e reduz consumo em 5%', () => {
    const stats = computeMergeResultStats(machineSource(), SETTINGS)!;
    expect(stats.resultRarity).toBe('uncommon');
    expect(stats.baseCost).toBeCloseTo(210); // (100+100) * 1.05
    expect(stats.baseProduction).toBeCloseTo(21); // (10+10) * 1.05
    expect(stats.powerConsumption).toBeCloseTo(380); // (200+200) * 0.95
    expect(stats.feeUsdc).toBeCloseTo(20); // (100+100) * 10%
  });

  it('multiplier: dobra o multiplicador com o ganho', () => {
    const src = machineSource({ type: 'multiplier', multiplier: 0.1, base_production: 0 });
    const stats = computeMergeResultStats(src, SETTINGS)!;
    expect(stats.multiplier).toBeCloseTo(0.21);
    expect(stats.baseProduction).toBe(0);
  });

  it('infrastructure: multiplier vem do bónus H/s configurado pra raridade resultado', () => {
    const src = machineSource({ type: 'infrastructure', rarity: 'legendary', slots_capacity: 4, ai_slots_capacity: 1 });
    const stats = computeMergeResultStats(src, SETTINGS)!;
    expect(stats.resultRarity).toBe('supreme');
    expect(stats.multiplier).toBeCloseTo(0.1); // 10% bonus configurado pra supreme
    expect(stats.slotsCapacity).toBe(4);
    expect(stats.aiSlotsCapacity).toBe(1);
  });

  it('tipo não suportado devolve null', () => {
    const src = machineSource({ type: 'unknown_type' as any });
    expect(computeMergeResultStats(src, SETTINGS)).toBeNull();
  });
});

describe('statsMatchExisting', () => {
  it('machine: compara base_cost/base_production/power_consumption com tolerância', () => {
    const stats = computeMergeResultStats(machineSource(), SETTINGS)!;
    const row = { base_cost: stats.baseCost, base_production: stats.baseProduction, power_consumption: stats.powerConsumption, multiplier: null };
    expect(statsMatchExisting(row, stats, 'machine')).toBe(true);
    expect(statsMatchExisting({ ...row, base_production: 999 }, stats, 'machine')).toBe(false);
  });

  it('infrastructure: também compara slots_capacity/ai_slots_capacity', () => {
    const src = machineSource({ type: 'infrastructure', rarity: 'legendary', slots_capacity: 4, ai_slots_capacity: 1 });
    const stats = computeMergeResultStats(src, SETTINGS)!;
    const row = { base_cost: stats.baseCost, base_production: 0, power_consumption: null, multiplier: stats.multiplier, slots_capacity: 4, ai_slots_capacity: 1 };
    expect(statsMatchExisting(row, stats, 'infrastructure')).toBe(true);
    expect(statsMatchExisting({ ...row, slots_capacity: 999 }, stats, 'infrastructure')).toBe(false);
  });
});
