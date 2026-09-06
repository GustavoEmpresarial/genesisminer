import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPLIXIR_REWARD_MESSAGE,
  mapMonetizationSettingsFromKv,
  planMonetizationSettingsPersist,
  toPublicMonetizationSettings
} from '../../../../../server/modules/admin/monetization-settings/services/monetization-settings.js';

describe('mapMonetizationSettingsFromKv', () => {
  it('ausente: flags false, strings vazias, mensagem default, secret vazio', () => {
    expect(mapMonetizationSettingsFromKv({})).toEqual({
      applixirEnabled: false,
      applixirSiteId: '',
      applixirZoneId: '',
      applixirAccountId: '',
      applixirRewardMessage: DEFAULT_APPLIXIR_REWARD_MESSAGE,
      applixirCallbackSecret: '',
      ezoicEnabled: false,
      ezoicPublisherId: '',
      ezoicAppId: '',
      ezoicPlaceholderId: ''
    });
  });

  it("enabled só com '1'", () => {
    expect(mapMonetizationSettingsFromKv({ applixir_enabled: '1', ezoic_enabled: '0' }).applixirEnabled).toBe(true);
    expect(mapMonetizationSettingsFromKv({ applixir_enabled: 'true' }).applixirEnabled).toBe(false);
  });
});

describe('toPublicMonetizationSettings', () => {
  it('omite applixirCallbackSecret', () => {
    const full = mapMonetizationSettingsFromKv({ applixir_callback_secret: 'sekrit' });
    const pub = toPublicMonetizationSettings(full);
    expect(pub).not.toHaveProperty('applixirCallbackSecret');
    expect(JSON.stringify(pub)).not.toMatch(/sekrit/);
  });
});

describe('planMonetizationSettingsPersist', () => {
  it('booleanos truthy → 1; ids String(||""); mensagem só se string', () => {
    const entries = planMonetizationSettingsPersist({
      applixirEnabled: 1,
      applixirSiteId: 99,
      applixirRewardMessage: 12,
      applixirCallbackSecret: 99,
      ezoicEnabled: false
    });
    const map = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(map.applixir_enabled).toBe('1');
    expect(map.applixir_site_id).toBe('99');
    expect(map.applixir_reward_message).toBe(DEFAULT_APPLIXIR_REWARD_MESSAGE);
    expect(map.applixir_callback_secret).toBe('');
    expect(map.ezoic_enabled).toBe('0');
  });

  it('string vazia de mensagem persiste vazia (não substitui default)', () => {
    const map = Object.fromEntries(planMonetizationSettingsPersist({ applixirRewardMessage: '' }).map((e) => [e.key, e.value]));
    expect(map.applixir_reward_message).toBe('');
  });

  it('body null/array trata como {}', () => {
    const map = Object.fromEntries(planMonetizationSettingsPersist(null).map((e) => [e.key, e.value]));
    expect(map.applixir_enabled).toBe('0');
    expect(planMonetizationSettingsPersist([1]).length).toBe(10);
  });
});

describe('load/persist monetization-settings', () => {
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

  it('round-trip persiste secret mas GET pública não o devolve', async () => {
    const mod = await import(
      '../../../../../server/modules/admin/monetization-settings/services/monetization-settings.js'
    );
    await mod.persistMonetizationSettings({
      applixirEnabled: true,
      applixirSiteId: 's',
      applixirZoneId: 'z',
      applixirAccountId: 'a',
      applixirRewardMessage: 'hi {reward}',
      applixirCallbackSecret: 'sekrit',
      ezoicEnabled: true,
      ezoicPublisherId: 'p',
      ezoicAppId: 'app',
      ezoicPlaceholderId: 'ph'
    });
    expect(settingsRepo.upsertSettingsEntries).toHaveBeenCalledTimes(1);
    const loaded = await mod.loadMonetizationSettings();
    expect(loaded.applixirCallbackSecret).toBe('sekrit');
    expect(loaded.applixirEnabled).toBe(true);
    expect(mod.toPublicMonetizationSettings(loaded)).not.toHaveProperty('applixirCallbackSecret');
  });

  it('erro de persistência propaga sem o secret na mensagem', async () => {
    settingsRepo.upsertSettingsEntries.mockRejectedValue(new Error('db down'));
    const { persistMonetizationSettings } = await import(
      '../../../../../server/modules/admin/monetization-settings/services/monetization-settings.js'
    );
    await expect(persistMonetizationSettings({ applixirCallbackSecret: 'sekrit' })).rejects.toThrow('db down');
    try {
      await persistMonetizationSettings({ applixirCallbackSecret: 'sekrit' });
    } catch (e) {
      expect(String(e)).not.toMatch(/sekrit/);
    }
  });
});
