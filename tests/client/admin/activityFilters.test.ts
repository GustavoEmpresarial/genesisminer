import { describe, expect, it } from 'vitest';
import { filterUserActivityLogs } from '../../../client/src/features/admin/utils/activityEventFormatter';

describe('filterUserActivityLogs compras e vendas', () => {
  const rows = [
    { action: 'p2p_trade_buy', meta: null, createdAt: 10 },
    { action: 'p2p_trade_sell', meta: null, createdAt: 20 },
    { action: 'p2p_listing_buy', meta: null, createdAt: 30 },
    { action: 'shop_checkout', meta: null, createdAt: 40 },
    { action: 'miner_equip', meta: null, createdAt: 50 }
  ];

  it('separa compra de venda', () => {
    expect(filterUserActivityLogs(rows, 'p2p_buy', '').map((r) => r.action)).toEqual([
      'p2p_trade_buy',
      'p2p_listing_buy'
    ]);
    expect(filterUserActivityLogs(rows, 'p2p_sell', '').map((r) => r.action)).toEqual(['p2p_trade_sell']);
  });

  it('money junta loja e P2P e ignora inventário', () => {
    expect(filterUserActivityLogs(rows, 'money', '').map((r) => r.action)).toEqual([
      'p2p_trade_buy',
      'p2p_trade_sell',
      'p2p_listing_buy',
      'shop_checkout'
    ]);
  });

  it('money inclui pacotes, caixas, roleta paga, expansão de salas e merge', () => {
    const allPurchases = [
      { action: 'upgrade_package_buy', meta: { upgradeName: 'VIP', priceUsdc: 10 }, createdAt: 1 },
      { action: 'loot_box_buy', meta: { boxName: 'Mística', price: 5 }, createdAt: 2 },
      { action: 'wheel_spin_paid', meta: { chargedUsdc: 2 }, createdAt: 3 },
      { action: 'rig_room_slot_purchase', meta: { totalPrice: 15 }, createdAt: 4 },
      { action: 'merge_craft_paid', meta: { feeUsdc: 1 }, createdAt: 5 },
      { action: 'miner_equip', meta: {}, createdAt: 6 }
    ];
    const filtered = filterUserActivityLogs(allPurchases, 'money', '');
    expect(filtered.map((r) => r.action)).toEqual([
      'upgrade_package_buy',
      'loot_box_buy',
      'wheel_spin_paid',
      'rig_room_slot_purchase',
      'merge_craft_paid'
    ]);
  });
});
