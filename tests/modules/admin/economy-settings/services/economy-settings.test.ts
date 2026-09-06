import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapEconomySettingsFromStores } from '../../../../../server/modules/admin/economy-settings/services/economy-settings.js';

describe('mapEconomySettingsFromStores (GET)', () => {
  it('sem linha e sem KV: defaults mercados true, taxa 0, banda 20', () => {
    expect(mapEconomySettingsFromStores(null, {})).toEqual({
      hardwareMarketEnabled: true,
      blackMarketEnabled: true,
      marketTaxPercent: 0,
      blackMarketPriceBandPercent: 20
    });
  });

  it('linha economy_settings manda nos flags (null na linha = desligado, não cai no KV)', () => {
    expect(
      mapEconomySettingsFromStores(
        {
          hardware_market_enabled: null,
          black_market_enabled: 1,
          market_tax_percent: 5,
          black_market_price_band_percent: 30
        },
        { hardware_market_enabled: '1', black_market_enabled: '0' }
      )
    ).toEqual({
      hardwareMarketEnabled: false,
      blackMarketEnabled: true,
      marketTaxPercent: 5,
      blackMarketPriceBandPercent: 30
    });
  });

  it('sem linha: fallback KV + clamp de taxa/banda', () => {
    expect(
      mapEconomySettingsFromStores(null, {
        hardware_market_enabled: '0',
        black_market_enabled: '1',
        market_tax_percent: '150',
        black_market_price_band_percent: '250'
      })
    ).toEqual({
      hardwareMarketEnabled: false,
      blackMarketEnabled: true,
      marketTaxPercent: 100,
      blackMarketPriceBandPercent: 200
    });
  });

  it('valores inválidos na taxa: fallback 0; banda inválida: 20', () => {
    expect(
      mapEconomySettingsFromStores(
        { market_tax_percent: 'nope', black_market_price_band_percent: 'x', hardware_market_enabled: 1, black_market_enabled: 1 },
        { market_tax_percent: 'also-bad' }
      )
    ).toEqual({
      hardwareMarketEnabled: true,
      blackMarketEnabled: true,
      marketTaxPercent: 0,
      blackMarketPriceBandPercent: 20
    });
  });
});

describe('persistEconomySettings (POST)', () => {
  let prismaMock: Record<string, any>;
  let appliedKeys: Record<string, string>;
  let economyRow: Record<string, unknown> | null;
  let txRan: boolean;

  beforeEach(() => {
    vi.resetModules();
    appliedKeys = {};
    economyRow = { black_market_price_band_percent: 33 };
    txRan = false;
    prismaMock = {
      prisma: {
        economy_settings: {
          findUnique: vi.fn(async () => economyRow),
          upsert: vi.fn((args: { create: Record<string, unknown> }) => ({
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              economyRow = args.create;
              return Promise.resolve(args.create).then(onF, onR);
            }
          }))
        },
        settings: {
          upsert: vi.fn((args: { create: { key: string; value: string } }) => ({
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              appliedKeys[args.create.key] = args.create.value;
              return Promise.resolve({}).then(onF, onR);
            }
          }))
        },
        $transaction: vi.fn(async (ops: Array<PromiseLike<unknown>>) => {
          txRan = true;
          for (const op of ops) await op;
          return ops;
        })
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('grava as 4 chaves KV e o singleton economy_settings atomicamente', async () => {
    const { persistEconomySettings } = await import(
      '../../../../../server/modules/admin/economy-settings/services/economy-settings.js'
    );
    const out = await persistEconomySettings({
      hardwareMarketEnabled: true,
      blackMarketEnabled: false,
      marketTaxPercent: 7.5,
      blackMarketPriceBandPercent: 40
    });
    expect(out).toEqual({ ok: true });
    expect(txRan).toBe(true);
    expect(prismaMock.prisma.$transaction.mock.calls[0][0]).toHaveLength(5);
    expect(appliedKeys).toEqual({
      hardware_market_enabled: '1',
      black_market_enabled: '0',
      market_tax_percent: '7.5',
      black_market_price_band_percent: '40'
    });
    expect(economyRow).toMatchObject({
      id: 1,
      hardware_market_enabled: 1,
      black_market_enabled: 0,
      market_tax_percent: 7.5,
      black_market_price_band_percent: 40
    });
  });

  it('tax inválida vira 0 (legado Number(x)||0); banda inválida reusa anterior', async () => {
    const { persistEconomySettings } = await import(
      '../../../../../server/modules/admin/economy-settings/services/economy-settings.js'
    );
    await persistEconomySettings({
      hardwareMarketEnabled: true,
      blackMarketEnabled: true,
      marketTaxPercent: 'nope',
      blackMarketPriceBandPercent: 'x'
    });
    expect(appliedKeys.market_tax_percent).toBe('0');
    expect(appliedKeys.black_market_price_band_percent).toBe('33');
  });

  it('array no body: 400 e não transaciona', async () => {
    const { persistEconomySettings } = await import(
      '../../../../../server/modules/admin/economy-settings/services/economy-settings.js'
    );
    await expect(persistEconomySettings([1, 2])).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: { error: 'Invalid payload.' }
    });
    expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('falha na transação: ops não são aplicadas (sem estado parcial)', async () => {
    prismaMock.prisma.$transaction.mockRejectedValue(new Error('deadlock'));
    const { persistEconomySettings } = await import(
      '../../../../../server/modules/admin/economy-settings/services/economy-settings.js'
    );
    await expect(
      persistEconomySettings({
        hardwareMarketEnabled: true,
        blackMarketEnabled: true,
        marketTaxPercent: 1,
        blackMarketPriceBandPercent: 20
      })
    ).rejects.toThrow('deadlock');
    expect(appliedKeys).toEqual({});
  });
});
