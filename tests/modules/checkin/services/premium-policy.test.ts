import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('checkin premium-policy', () => {
  let settingsRepo: Record<string, any>;
  let stored: Record<string, string>;
  let prismaMock: Record<string, any>;
  let queryRawResult: Array<{ ok: number }>;

  beforeEach(() => {
    vi.resetModules();
    stored = {};
    queryRawResult = [];
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
    prismaMock = {
      prisma: {
        $queryRaw: vi.fn(async () => queryRawResult)
      }
    };
    vi.doMock('../../../../server/shared/settings/settings-repository.js', () => settingsRepo);
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/shared/settings/settings-repository.js');
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  it('loadCheckinPremiumPolicy defaults (enabled=true quando não configurado)', async () => {
    const { loadCheckinPremiumPolicy } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const policy = await loadCheckinPremiumPolicy();
    expect(policy).toEqual({ enabled: true, minUsdc: 195, intervalDays: 7 });
  });

  it('saveCheckinPremiumPolicy grava e persiste', async () => {
    const { loadCheckinPremiumPolicy, saveCheckinPremiumPolicy } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const saved = await saveCheckinPremiumPolicy({ enabled: false, minUsdc: 300, intervalDays: 14 });
    expect(saved).toEqual({ enabled: false, minUsdc: 300, intervalDays: 14 });
    const reloaded = await loadCheckinPremiumPolicy();
    expect(reloaded).toEqual(saved);
  });

  it('premiumIntervalMs converte dias em ms', async () => {
    const { premiumIntervalMs } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(premiumIntervalMs(7)).toBe(7 * MS_PER_DAY);
    expect(premiumIntervalMs(0)).toBe(7 * MS_PER_DAY);
  });

  it('canPerformPremiumCheckinNow: sem check-in anterior sempre pode', async () => {
    const { canPerformPremiumCheckinNow } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(canPerformPremiumCheckinNow(null, Date.now(), 7)).toBe(true);
  });

  it('canPerformPremiumCheckinNow: dentro do intervalo não pode, depois pode', async () => {
    const { canPerformPremiumCheckinNow } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const last = 1000;
    expect(canPerformPremiumCheckinNow(last, last + 3 * MS_PER_DAY, 7)).toBe(false);
    expect(canPerformPremiumCheckinNow(last, last + 7 * MS_PER_DAY, 7)).toBe(true);
  });

  it('nextPremiumCheckinAllowedMs: null sem check-in anterior', async () => {
    const { nextPremiumCheckinAllowedMs } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(nextPremiumCheckinAllowedMs(null, 7)).toBeNull();
    expect(nextPremiumCheckinAllowedMs(1000, 7)).toBe(1000 + 7 * MS_PER_DAY);
  });

  it('isPremiumWithinActiveWindow', async () => {
    const { isPremiumWithinActiveWindow } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(isPremiumWithinActiveWindow(null, Date.now(), 7)).toBe(false);
    expect(isPremiumWithinActiveWindow(1000, 1000 + MS_PER_DAY, 7)).toBe(true);
    expect(isPremiumWithinActiveWindow(1000, 1000 + 8 * MS_PER_DAY, 7)).toBe(false);
  });

  it('userHasPremiumUpgradePurchase: true quando existe compra >= limite', async () => {
    queryRawResult = [{ ok: 1 }];
    const { userHasPremiumUpgradePurchase } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(await userHasPremiumUpgradePurchase(1, 195)).toBe(true);
  });

  it('userHasPremiumUpgradePurchase: false quando não há compra', async () => {
    queryRawResult = [];
    const { userHasPremiumUpgradePurchase } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(await userHasPremiumUpgradePurchase(1, 195)).toBe(false);
  });

  it('resolveUserCheckinPremiumContext: elegível quando policy enabled e comprou upgrade', async () => {
    queryRawResult = [{ ok: 1 }];
    const { resolveUserCheckinPremiumContext } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const ctx = await resolveUserCheckinPremiumContext(1);
    expect(ctx.eligible).toBe(true);
    expect(ctx.premiumWeeklyCheckin).toBe(true);
  });

  it('resolveUserCheckinPremiumContext: não elegível quando policy desabilitada (não consulta compra)', async () => {
    stored.checkin_premium_enabled = '0';
    const { resolveUserCheckinPremiumContext } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const ctx = await resolveUserCheckinPremiumContext(1);
    expect(ctx.eligible).toBe(false);
    expect(ctx.premiumWeeklyCheckin).toBe(false);
    expect(prismaMock.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
