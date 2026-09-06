import { describe, expect, it } from 'vitest';
import type { Upgrade } from '../../../client/src/features/servers/types.js';
import {
  resolveCompatibleRackNames,
  getUpgradeMarketSpecs
} from '../../../client/src/features/black-market/lib/upgradeMarketSpec.js';

const rackA: Upgrade = {
  id: 'rack_a61',
  name: 'RACK A1',
  category: 'Infra',
  type: 'infrastructure',
  baseCost: 1,
  baseProduction: 0,
  description: '',
  icon: '🗄',
  status: 'normal',
  slotsCapacity: 4
};

const rackPromo: Upgrade = {
  id: 'rack_promo',
  name: 'Rack promo free to play',
  category: 'Infra',
  type: 'infrastructure',
  baseCost: 1,
  baseProduction: 0,
  description: '',
  icon: '🗄',
  status: 'normal',
  slotsCapacity: 2
};

const gpu: Upgrade = {
  id: 'office',
  name: 'Office',
  category: 'GPU',
  type: 'machine',
  baseCost: 0.1,
  baseProduction: 1,
  powerConsumption: 1,
  description: '',
  icon: '🎮',
  status: 'normal',
  compatibleRacks: [
    'rack_a61',
    'merge_rack_a61_uncommon_c8e05a8154',
    'merge_merge_rack_a61_uncommon_c8e05a8154_rare_26c2bed52c',
    'merge_merge_merge_merge_merge_rack_a61_uncommon_c8e05a_supreme_c2e0df9830',
    'rack_promo',
    'merge_rack_promo_uncommon_c90fe6a8bf',
    'rack_10u',
    'merge_armario_1_uncommon_2279e97d39'
  ]
};

describe('resolveCompatibleRackNames (P2P cards)', () => {
  it('dedupe linhagem merge e resolve nome da raiz', () => {
    const text = resolveCompatibleRackNames(gpu, [rackA, rackPromo]);
    expect(text).toContain('RACK A1');
    expect(text).toContain('Rack promo free to play');
    expect(text).not.toMatch(/merge_/);
    // só 1 entrada por linhagem rack_a61
    expect(text.split('RACK A1').length - 1).toBe(1);
  });

  it('limita a 4 nomes + resto', () => {
    const many: Upgrade = {
      ...gpu,
      compatibleRacks: [
        'rack_a61',
        'rack_promo',
        'rack_b',
        'rack_c',
        'rack_d',
        'rack_e'
      ]
    };
    const catalog: Upgrade[] = [
      rackA,
      rackPromo,
      { ...rackA, id: 'rack_b', name: 'B' },
      { ...rackA, id: 'rack_c', name: 'C' },
      { ...rackA, id: 'rack_d', name: 'D' },
      { ...rackA, id: 'rack_e', name: 'E' }
    ];
    const text = resolveCompatibleRackNames(many, catalog);
    expect(text).toMatch(/… \+2$/);
    expect(text.split(', ').length).toBe(4);
  });

  it('GPU specs não despejam parede de merge_*', () => {
    const specs = getUpgradeMarketSpecs(gpu, [rackA, rackPromo]);
    const compat = specs.find((s) => s.label === 'Compatível');
    expect(compat?.value).toBeTruthy();
    expect(compat!.value.length).toBeLessThan(120);
    expect(compat!.value).not.toMatch(/merge_/);
  });
});
