import { describe, expect, it } from 'vitest';
import { parseCalculatorProjection } from '../../../../client/src/shared/api/calculator.js';

describe('parseCalculatorProjection', () => {
  it('narrows a valid payload', () => {
    const raw = {
      ok: true,
      scope: 'total',
      scopesUi: [{ id: 'total', name: 'Poder Total' }],
      checkinFrozen: false,
      generalPowerHps: 12.5,
      coins: [
        {
          id: 'c1',
          symbol: 'GEM',
          name: 'Gem',
          iconUrl: null,
          priceUsd: 1,
          distributionMode: 'usd_month',
          distributionUsdMonth: 50,
          nftRoomOnly: false,
          independentPool: false,
          userPowerHps: 10,
          networkHps: 100,
          yieldPerHash: 0.000001,
          sharePct: 10,
          coinsPerSec: 0.00001,
          dailyCoins: 0.864,
          dailyUsd: 0.864,
          monthUsd: 5,
          rows: [
            { periodId: 'hour', coins: 0.036, usd: 0.036 },
            { periodId: 'day', coins: 0.864, usd: 0.864 },
            { periodId: 'week', coins: 6.048, usd: 6.048 },
            { periodId: 'month', coins: 25.92, usd: 25.92 }
          ],
          blockHistory: []
        }
      ]
    };
    const parsed = parseCalculatorProjection(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.scope).toBe('total');
    expect(parsed.coins).toHaveLength(1);
    expect(parsed.coins[0]!.symbol).toBe('GEM');
    expect(parsed.coins[0]!.iconUrl).toBeNull();
    expect(parsed.coins[0]!.rows).toHaveLength(4);
    expect(parsed.coins[0]!.rows[0]!.periodId).toBe('hour');
  });

  it('trims iconUrl and maps empty/whitespace to null', () => {
    const baseCoin = {
      id: 'c2',
      symbol: 'BTC',
      name: 'Bitcoin',
      priceUsd: 1,
      distributionMode: 'legacy',
      distributionUsdMonth: null,
      nftRoomOnly: false,
      independentPool: false,
      userPowerHps: 0,
      networkHps: 0,
      yieldPerHash: 0,
      sharePct: 0,
      coinsPerSec: 0,
      dailyCoins: 0,
      dailyUsd: 0,
      monthUsd: 0,
      rows: [],
      blockHistory: []
    };
    const withUrl = parseCalculatorProjection({
      ok: true,
      scope: 'total',
      scopesUi: [],
      checkinFrozen: false,
      generalPowerHps: 0,
      coins: [{ ...baseCoin, iconUrl: '  /img/moedas/btc.png  ' }]
    });
    expect(withUrl.coins[0]!.iconUrl).toBe('/img/moedas/btc.png');

    const blank = parseCalculatorProjection({
      ok: true,
      scope: 'total',
      scopesUi: [],
      checkinFrozen: false,
      generalPowerHps: 0,
      coins: [{ ...baseCoin, iconUrl: '   ' }]
    });
    expect(blank.coins[0]!.iconUrl).toBeNull();

    const missing = parseCalculatorProjection({
      ok: true,
      scope: 'total',
      scopesUi: [],
      checkinFrozen: false,
      generalPowerHps: 0,
      coins: [{ ...baseCoin }]
    });
    expect(missing.coins[0]!.iconUrl).toBeNull();
  });

  it('rejects ok:false with error message', () => {
    expect(() => parseCalculatorProjection({ ok: false, error: 'boom' })).toThrow(/boom/);
  });

  it('rejects non-object', () => {
    expect(() => parseCalculatorProjection(null)).toThrow(/Invalid/);
  });
});
