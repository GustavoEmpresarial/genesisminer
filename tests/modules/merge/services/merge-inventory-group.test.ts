import { describe, expect, it } from 'vitest';
import { mergeSourceCatalogsEquivalent } from '../../../../server/modules/merge/services/stats.js';

describe('mergeSourceCatalogsEquivalent', () => {
  const base = {
    id: 'merge_a',
    name: 'Merged GPU X',
    category: 'gpu',
    type: 'machine',
    rarity: 'uncommon',
    base_cost: 6.6,
    base_production: 6.6,
    power_consumption: 1,
    multiplier: null,
    slots_capacity: null,
    ai_slots_capacity: null,
    description: '',
    icon: '📦',
    image: null,
    status: 'normal'
  };

  it('trata SKUs distintos com mesmo nome/stats como equivalentes', () => {
    expect(mergeSourceCatalogsEquivalent(base, { ...base, id: 'merge_b' })).toBe(true);
  });

  it('rejeita stats diferentes (ex.: gain antigo vs novo)', () => {
    expect(mergeSourceCatalogsEquivalent(base, { ...base, id: 'merge_c', base_cost: 6.3, base_production: 6.3 })).toBe(false);
  });
});
