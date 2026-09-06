import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKIN_REWARD_EVERY_DAYS,
  computeNextDailyCheckinStreak,
  computeNextPremiumCheckinStreak,
  grantCheckinReward,
  grantCheckinStreakTemporaryItem,
  shouldGrantCheckinReward,
  shouldGrantStreakMilestoneReward
} from '../../../../server/modules/checkin/services/reward.js';
import type { CheckinRewardPolicy } from '../../../../server/modules/checkin/services/reward-policy.js';

const HARDWARE_URL = 'http://hw.test';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const HASHRATE_POLICY: CheckinRewardPolicy = {
  rewardType: 'hashrate',
  dailyRewardAmount: 1,
  weeklyRewardAmount: 7,
  rewardItemId: 'battery_estelar',
  streakRewardEnabled: false,
  streakRewardItemId: '',
  streakRewardDurationAmount: 7,
  streakRewardDurationUnit: 'day'
};

describe('computeNextDailyCheckinStreak', () => {
  it('primeiro check-in de sempre → streak 1, sem reset', () => {
    expect(computeNextDailyCheckinStreak(0, null, 1000)).toEqual({ nextStreak: 1, streakReset: false });
  });

  it('ciclo seguinte imediato → incrementa', () => {
    const prevPeriod = 0;
    const nextPeriod = MS_PER_DAY;
    expect(computeNextDailyCheckinStreak(3, prevPeriod, nextPeriod)).toEqual({ nextStreak: 4, streakReset: false });
  });

  it('1 ciclo perdido (grace de 48h) → ainda incrementa', () => {
    const prevPeriod = 0;
    const anchor = 2 * MS_PER_DAY;
    expect(computeNextDailyCheckinStreak(3, prevPeriod, anchor)).toEqual({ nextStreak: 4, streakReset: false });
  });

  it('2+ ciclos perdidos → reseta pra 1', () => {
    const prevPeriod = 0;
    const anchor = 3 * MS_PER_DAY;
    expect(computeNextDailyCheckinStreak(5, prevPeriod, anchor)).toEqual({ nextStreak: 1, streakReset: true });
  });

  it('reset a partir de streak 0 não marca streakReset', () => {
    const prevPeriod = 0;
    const anchor = 3 * MS_PER_DAY;
    expect(computeNextDailyCheckinStreak(0, prevPeriod, anchor)).toEqual({ nextStreak: 1, streakReset: false });
  });
});

describe('computeNextPremiumCheckinStreak', () => {
  const intervalMs = 7 * MS_PER_DAY;

  it('primeiro check-in premium → streak 1', () => {
    expect(computeNextPremiumCheckinStreak(0, null, 1000, intervalMs)).toEqual({ nextStreak: 1, streakReset: false });
  });

  it('dentro da janela (intervalo + 1 ciclo de graça) → incrementa', () => {
    const prevAt = 0;
    const now = intervalMs + MS_PER_DAY;
    expect(computeNextPremiumCheckinStreak(2, prevAt, now, intervalMs)).toEqual({ nextStreak: 3, streakReset: false });
  });

  it('fora da janela → reseta', () => {
    const prevAt = 0;
    const now = intervalMs + MS_PER_DAY + 1;
    expect(computeNextPremiumCheckinStreak(2, prevAt, now, intervalMs)).toEqual({ nextStreak: 1, streakReset: true });
  });
});

describe('shouldGrantCheckinReward', () => {
  it('sempre concede (diário ou premium)', () => {
    expect(shouldGrantCheckinReward(1, false)).toBe(true);
    expect(shouldGrantCheckinReward(1, true)).toBe(true);
  });
});

describe('shouldGrantStreakMilestoneReward', () => {
  it('só nos múltiplos de CHECKIN_REWARD_EVERY_DAYS', () => {
    expect(shouldGrantStreakMilestoneReward(CHECKIN_REWARD_EVERY_DAYS)).toBe(true);
    expect(shouldGrantStreakMilestoneReward(2 * CHECKIN_REWARD_EVERY_DAYS)).toBe(true);
    expect(shouldGrantStreakMilestoneReward(1)).toBe(false);
    expect(shouldGrantStreakMilestoneReward(0)).toBe(false);
  });
});

describe('grantCheckinStreakTemporaryItem', () => {
  const STREAK_POLICY: CheckinRewardPolicy = { ...HASHRATE_POLICY, streakRewardEnabled: true, streakRewardItemId: 'asic-x', streakRewardDurationAmount: 7, streakRewardDurationUnit: 'day' };

  it('streakRewardEnabled=false: não concede nada, sem tocar no client', async () => {
    const client = { query: vi.fn() };
    const result = await grantCheckinStreakTemporaryItem(client as any, 1, { ...STREAK_POLICY, streakRewardEnabled: false }, Date.now());
    expect(result).toEqual({ granted: 0, itemId: null, itemName: null, expiresAtMs: null, durationLabel: null });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('streakRewardItemId vazio: não concede nada', async () => {
    const client = { query: vi.fn() };
    const result = await grantCheckinStreakTemporaryItem(client as any, 1, { ...STREAK_POLICY, streakRewardItemId: '' }, Date.now());
    expect(result.granted).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('upgrade ausente/inactivo: não concede', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await grantCheckinStreakTemporaryItem(client as any, 1, STREAK_POLICY, Date.now());
    expect(result.granted).toBe(0);
  });

  it('upgrade não é type=machine: não concede', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'asic-x', name: 'ASIC X', type: 'part' }] }) };
    const result = await grantCheckinStreakTemporaryItem(client as any, 1, STREAK_POLICY, Date.now());
    expect(result.granted).toBe(0);
  });

  it('GENESIS_HARDWARE_URL: callHardwareCredit com durationAmount/Unit — sem INSERT player_asic_leases', async () => {
    const prevUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = HARDWARE_URL;
    vi.resetModules();
    const now = Date.now();
    const expiresAt = now + 7 * MS_PER_DAY;
    const callHardwareCredit = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
    try {
      const { grantCheckinStreakTemporaryItem: grantWithUrl } = await import(
        '../../../../server/modules/checkin/services/reward.js'
      );
      const client = {
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          if (s.includes('SELECT id, name, type FROM upgrades')) {
            return { rows: [{ id: 'asic-x', name: 'ASIC X', type: 'machine' }] };
          }
          if (s.includes('SELECT expires_at FROM player_asic_leases')) {
            return { rows: [{ expires_at: expiresAt }] };
          }
          return { rows: [], rowCount: 0 };
        })
      };
      const result = await grantWithUrl(client as never, 1, STREAK_POLICY, now);
      expect(result).toEqual({
        granted: 1,
        itemId: 'asic-x',
        itemName: 'ASIC X',
        expiresAtMs: expiresAt,
        durationLabel: expect.any(String)
      });
      expect(callHardwareCredit).toHaveBeenCalledTimes(1);
      expect(callHardwareCredit).toHaveBeenCalledWith({
        userId: 1,
        itemId: 'asic-x',
        qty: 1,
        durationAmount: 7,
        durationUnit: 'day'
      });
      const insertCalls = client.query.mock.calls.filter((args) =>
        String(args[0]).includes('INSERT INTO player_asic_leases')
      );
      expect(insertCalls).toHaveLength(0);
    } finally {
      if (prevUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
      else process.env.GENESIS_HARDWARE_URL = prevUrl;
      vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
      vi.resetModules();
    }
  });
});

describe('grantCheckinReward', () => {
  let client: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = { query: vi.fn() };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quantidade <= 0 não concede nada nem toca no client', async () => {
    const result = await grantCheckinReward(client as any, 1, 0, HASHRATE_POLICY);
    expect(result).toEqual({ rewardGranted: 0, rewardType: 'hashrate', rewardUnit: 'H/s', batteryId: null, checkinBonusHps: 0 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('tipo hashrate soma em checkin_bonus_hps e devolve o total', async () => {
    client.query.mockResolvedValue({ rows: [{ checkin_bonus_hps: '4.5' }] });
    const result = await grantCheckinReward(client as any, 1, 1, HASHRATE_POLICY);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE game_states'), [1, 1]);
    expect(result).toEqual({ rewardGranted: 1, rewardType: 'hashrate', rewardUnit: 'H/s', batteryId: null, checkinBonusHps: 4.5 });
  });

  it('tipo item concede via callHardwareCredit quando o upgrade existe', async () => {
    const prevUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = HARDWARE_URL;
    vi.resetModules();
    const callHardwareCredit = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
    try {
      const { grantCheckinReward: grantWithUrl } = await import(
        '../../../../server/modules/checkin/services/reward.js'
      );
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM upgrades')) return { rows: [{ id: 'battery_estelar' }] };
        return { rows: [], rowCount: 0 };
      });
      const policy: CheckinRewardPolicy = { ...HASHRATE_POLICY, rewardType: 'item', rewardItemId: 'battery_estelar' };
      const result = await grantWithUrl(client as never, 1, 1, policy);
      expect(result.rewardGranted).toBe(1);
      expect(result.rewardType).toBe('item');
      expect(result.batteryId).toBeNull();
      expect(result.checkinBonusHps).toBe(0);
      expect(callHardwareCredit).toHaveBeenCalledWith({ userId: 1, itemId: 'battery_estelar', qty: 1 });
      const stockInserts = client.query.mock.calls.filter((args) => String(args[0]).includes('INSERT INTO stock'));
      expect(stockInserts).toHaveLength(0);
    } finally {
      if (prevUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
      else process.env.GENESIS_HARDWARE_URL = prevUrl;
      vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
      vi.resetModules();
    }
  });

  it('tipo item com qty>1 credita via callHardwareCredit e devolve granted=N (não mente qty)', async () => {
    const QTY = 3;
    const prevUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = HARDWARE_URL;
    vi.resetModules();
    const callHardwareCredit = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => HARDWARE_URL,
      callHardwareCredit
    }));
    try {
      const { grantCheckinReward: grantWithUrl } = await import(
        '../../../../server/modules/checkin/services/reward.js'
      );
      client.query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('SELECT id FROM upgrades')) return { rows: [{ id: 'battery_estelar' }] };
        return { rows: [], rowCount: 0 };
      });
      const policy: CheckinRewardPolicy = { ...HASHRATE_POLICY, rewardType: 'battery', rewardItemId: 'battery_estelar' };
      const result = await grantWithUrl(client as never, 1, QTY, policy);

      expect(result.rewardGranted).toBe(QTY);
      expect(callHardwareCredit).toHaveBeenCalledWith({ userId: 1, itemId: 'battery_estelar', qty: QTY });
      const stockInserts = client.query.mock.calls.filter((args) => String(args[0]).includes('INSERT INTO stock'));
      expect(stockInserts).toHaveLength(0);
      expect(client.query).toHaveBeenCalledTimes(1);
    } finally {
      if (prevUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
      else process.env.GENESIS_HARDWARE_URL = prevUrl;
      vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
      vi.resetModules();
    }
  });

  it('tipo item não concede quando o upgrade não existe/está inactivo', async () => {
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const policy: CheckinRewardPolicy = { ...HASHRATE_POLICY, rewardType: 'item', rewardItemId: 'inexistente' };
    const result = await grantCheckinReward(client as any, 1, 1, policy);
    expect(result).toEqual({ rewardGranted: 0, rewardType: 'item', rewardUnit: 'item', batteryId: null, checkinBonusHps: 0 });
  });
});
