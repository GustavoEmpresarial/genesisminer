import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('checkin reward-policy', () => {
  let settingsRepo: Record<string, any>;
  let stored: Record<string, string>;

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
    vi.doMock('../../../../server/shared/settings/settings-repository.js', () => settingsRepo);
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/shared/settings/settings-repository.js');
  });

  it('loadCheckinRewardPolicy devolve os defaults quando nada está guardado', async () => {
    const { loadCheckinRewardPolicy } = await import('../../../../server/modules/checkin/services/reward-policy.js');
    const policy = await loadCheckinRewardPolicy();
    expect(policy).toEqual({
      rewardType: 'hashrate',
      dailyRewardAmount: 1,
      weeklyRewardAmount: 7,
      rewardItemId: 'battery_estelar',
      streakRewardEnabled: false,
      streakRewardItemId: '',
      streakRewardDurationAmount: 7,
      streakRewardDurationUnit: 'day'
    });
  });

  it('saveCheckinRewardPolicy grava só os campos informados e mantém o resto', async () => {
    const { loadCheckinRewardPolicy, saveCheckinRewardPolicy } = await import('../../../../server/modules/checkin/services/reward-policy.js');
    const saved = await saveCheckinRewardPolicy({ rewardType: 'item', rewardItemId: 'battery_x', dailyRewardAmount: 2 });
    expect(saved.rewardType).toBe('item');
    expect(saved.rewardItemId).toBe('battery_x');
    expect(saved.dailyRewardAmount).toBe(2);
    expect(saved.weeklyRewardAmount).toBe(7);

    const reloaded = await loadCheckinRewardPolicy();
    expect(reloaded).toEqual(saved);
  });

  it('tipo inválido cai no default (hashrate)', async () => {
    stored.checkin_reward_type = 'nao-existe';
    const { loadCheckinRewardPolicy } = await import('../../../../server/modules/checkin/services/reward-policy.js');
    const policy = await loadCheckinRewardPolicy();
    expect(policy.rewardType).toBe('hashrate');
  });

  it('checkinRewardUnitLabel mapeia cada tipo', async () => {
    const { checkinRewardUnitLabel } = await import('../../../../server/modules/checkin/services/reward-policy.js');
    expect(checkinRewardUnitLabel('hashrate')).toBe('H/s');
    expect(checkinRewardUnitLabel('battery')).toBe('bateria');
    expect(checkinRewardUnitLabel('item')).toBe('item');
  });

  it('streakRewardDurationConfig normaliza amount+unit da política', async () => {
    const { streakRewardDurationConfig } = await import('../../../../server/modules/checkin/services/reward-policy.js');
    const cfg = streakRewardDurationConfig({
      rewardType: 'hashrate',
      dailyRewardAmount: 1,
      weeklyRewardAmount: 7,
      rewardItemId: 'x',
      streakRewardEnabled: true,
      streakRewardItemId: 'asic-x',
      streakRewardDurationAmount: 3,
      streakRewardDurationUnit: 'day'
    });
    expect(cfg.amount).toBe(3);
    expect(cfg.unit).toBe('day');
  });
});
