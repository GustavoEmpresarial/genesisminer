import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mapExchangeSettingsFromKv,
  planExchangeSettingsPersist
} from '../../../../../server/modules/admin/exchange-settings/services/exchange-settings.js';

describe('mapExchangeSettingsFromKv (GET)', () => {
  it('ausentes: min 0.1, fee 0', () => {
    expect(mapExchangeSettingsFromKv({})).toEqual({ minExchangeAmount: 0.1, exchangeFeePercent: 0 });
  });

  it('string vazia trata como ausente', () => {
    expect(mapExchangeSettingsFromKv({ exchange_min_usdc: '', exchange_fee_percent: '' })).toEqual({
      minExchangeAmount: 0.1,
      exchangeFeePercent: 0
    });
  });

  it('valores existentes: Number cru, sem clamp (min 0 permanece 0)', () => {
    expect(mapExchangeSettingsFromKv({ exchange_min_usdc: '0', exchange_fee_percent: '12.5' })).toEqual({
      minExchangeAmount: 0,
      exchangeFeePercent: 12.5
    });
  });

  it('fee armazenada >100 no GET não é clampada (só o POST clampa)', () => {
    expect(mapExchangeSettingsFromKv({ exchange_min_usdc: '1', exchange_fee_percent: '150' })).toEqual({
      minExchangeAmount: 1,
      exchangeFeePercent: 150
    });
  });
});

describe('planExchangeSettingsPersist (POST)', () => {
  it('clampa min≥0 e fee 0–100; Number||0', () => {
    expect(planExchangeSettingsPersist({ minExchangeAmount: -4, exchangeFeePercent: 150 })).toEqual({ min: 0, fee: 100 });
    expect(planExchangeSettingsPersist({ minExchangeAmount: 'nope', exchangeFeePercent: undefined })).toEqual({
      min: 0,
      fee: 0
    });
    expect(planExchangeSettingsPersist({ minExchangeAmount: 0.5, exchangeFeePercent: 7 })).toEqual({ min: 0.5, fee: 7 });
  });

  it('array: 400', () => {
    try {
      planExchangeSettingsPersist([1]);
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });
});

describe('persistExchangeSettings + load round-trip', () => {
  let stored: Record<string, string>;
  let settingsRepo: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    stored = {};
    settingsRepo = {
      getSettingsRecord: vi.fn(async (keys: string[]) => {
        const out: Record<string, string> = {};
        for (const k of keys) if (stored[k] !== undefined) out[k] = stored[k];
        return out;
      }),
      upsertSettingsEntries: vi.fn(async (entries: Array<{ key: string; value: string }>) => {
        for (const e of entries) stored[e.key] = e.value;
      })
    };
    vi.doMock('../../../../../server/shared/settings/settings-repository.js', () => settingsRepo);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/shared/settings/settings-repository.js');
  });

  it('grava as duas chaves numa chamada e a leitura posterior casa', async () => {
    const { persistExchangeSettings, loadExchangeSettings } = await import(
      '../../../../../server/modules/admin/exchange-settings/services/exchange-settings.js'
    );
    await expect(persistExchangeSettings({ minExchangeAmount: 2, exchangeFeePercent: 8 })).resolves.toEqual({ ok: true });
    expect(settingsRepo.upsertSettingsEntries).toHaveBeenCalledTimes(1);
    expect(settingsRepo.upsertSettingsEntries.mock.calls[0][0]).toEqual([
      { key: 'exchange_min_usdc', value: '2' },
      { key: 'exchange_fee_percent', value: '8' }
    ]);
    expect(await loadExchangeSettings()).toEqual({ minExchangeAmount: 2, exchangeFeePercent: 8 });
  });

  it('falha no upsert: não deixa metade das chaves (helper é a transação)', async () => {
    settingsRepo.upsertSettingsEntries.mockRejectedValue(new Error('db down'));
    const { persistExchangeSettings } = await import(
      '../../../../../server/modules/admin/exchange-settings/services/exchange-settings.js'
    );
    await expect(persistExchangeSettings({ minExchangeAmount: 1, exchangeFeePercent: 1 })).rejects.toThrow('db down');
    expect(stored).toEqual({});
  });
});
