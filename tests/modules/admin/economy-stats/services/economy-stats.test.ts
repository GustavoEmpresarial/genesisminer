import { describe, expect, it } from 'vitest';
import {
  aggregateEconomyStats,
  rackEffectiveHashrate,
  type EconomyCoinRow
} from '../../../../../server/modules/admin/economy-stats/services/economy-stats.js';

const coin = (over: Partial<EconomyCoinRow> = {}): EconomyCoinRow => ({
  id: 'btc',
  name: 'Bitcoin',
  symbol: 'BTC',
  description: '',
  network_hashrate: 1000,
  block_reward: 0.5,
  block_time: 600,
  price_usd: 1.2,
  algorithm: '',
  difficulty: 1,
  multiplier: 1,
  color: '#fff',
  min_proportion: 0,
  usdc_rate: 1,
  is_active: 1,
  target_daily_usd: 0,
  show_in_exchange: 1,
  nft_room_only: 0,
  ...over
});

describe('rackEffectiveHashrate', () => {
  const ups = new Map([
    ['asic', { id: 'asic', base_production: 10, multiplier: null, power_capacity: null }],
    ['asic2', { id: 'asic2', base_production: 5, multiplier: null, power_capacity: null }],
    ['mult', { id: 'mult', base_production: 0, multiplier: 0.5, power_capacity: null }],
    ['zero', { id: 'zero', base_production: 0, multiplier: 9, power_capacity: null }]
  ]);

  it('base 0 (sem máquinas / produção nula) → null (rack ignorado)', () => {
    expect(rackEffectiveHashrate([], [], ups)).toBeNull();
    expect(rackEffectiveHashrate(['zero'], ['mult'], ups)).toBeNull();
    expect(rackEffectiveHashrate(['missing'], [], ups)).toBeNull();
  });

  it('base × (1 + Σ multiplier); nulos tratam como 0', () => {
    expect(rackEffectiveHashrate(['asic', 'asic2'], ['mult'], ups)).toBe(15 * 1.5);
    expect(rackEffectiveHashrate(['asic'], [null], ups)).toBe(10);
  });
});

describe('aggregateEconomyStats', () => {
  const upgrades = [
    { id: 'asic', base_production: 10, multiplier: null, power_capacity: null },
    { id: 'mult', base_production: 0, multiplier: 1, power_capacity: null }
  ];

  it('sem moedas → []', () => {
    expect(aggregateEconomyStats([], [], [], [], [])).toEqual([]);
  });

  it('moedas sem racks → miners 0 e hashrate 0', () => {
    const rows = aggregateEconomyStats([coin(), coin({ id: 'eth', name: 'Eth', symbol: 'ETH' })], [], [], [], upgrades);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.realActiveMiners === 0 && r.realTotalHashrate === 0)).toBe(true);
  });

  it('ignora rack sem selected_coin_id, moeda desconhecida e base 0', () => {
    const rows = aggregateEconomyStats(
      [coin()],
      [
        { id: 'r1', user_id: 1, selected_coin_id: null },
        { id: 'r2', user_id: 1, selected_coin_id: 'nope' },
        { id: 'r3', user_id: 1, selected_coin_id: 'btc' }
      ],
      [{ rack_id: 'r3', machine_item_id: null }],
      [],
      upgrades
    );
    expect(rows[0]!.realActiveMiners).toBe(0);
    expect(rows[0]!.realTotalHashrate).toBe(0);
  });

  it('agrega hashrate; miners = users distintos por moeda', () => {
    const rows = aggregateEconomyStats(
      [coin(), coin({ id: 'eth', name: 'Eth', symbol: 'ETH' })],
      [
        { id: 'a', user_id: 1, selected_coin_id: 'btc' },
        { id: 'b', user_id: 1, selected_coin_id: 'btc' },
        { id: 'c', user_id: 2, selected_coin_id: 'btc' },
        { id: 'd', user_id: 2, selected_coin_id: 'eth' }
      ],
      [
        { rack_id: 'a', machine_item_id: 'asic' },
        { rack_id: 'b', machine_item_id: 'asic' },
        { rack_id: 'c', machine_item_id: 'asic' },
        { rack_id: 'd', machine_item_id: 'asic' }
      ],
      [{ rack_id: 'a', multiplier_item_id: 'mult' }],
      upgrades
    );
    const btc = rows.find((r) => r.id === 'btc')!;
    const eth = rows.find((r) => r.id === 'eth')!;
    expect(btc.realActiveMiners).toBe(2);
    expect(btc.realTotalHashrate).toBe(10 * 2 + 10 + 10);
    expect(eth.realActiveMiners).toBe(1);
    expect(eth.realTotalHashrate).toBe(10);
  });

  it('preserva campos da moeda (price_usd, block_reward) sem arredondar hashrate', () => {
    const rows = aggregateEconomyStats(
      [coin({ price_usd: 0.123456, block_reward: 0.00000001 })],
      [{ id: 'a', user_id: 9, selected_coin_id: 'btc' }],
      [{ rack_id: 'a', machine_item_id: 'asic' }],
      [],
      [{ id: 'asic', base_production: 1 / 3, multiplier: null, power_capacity: null }]
    );
    expect(rows[0]!.price_usd).toBe(0.123456);
    expect(rows[0]!.block_reward).toBe(0.00000001);
    expect(rows[0]!.realTotalHashrate).toBe(1 / 3);
  });
});
