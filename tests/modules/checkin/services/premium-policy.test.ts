import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('checkin premium-policy', () => {
  let settingsRepo: Record<string, unknown>;
  let stored: Record<string, string>;
  let prismaMock: {
    prisma: {
      $queryRaw: ReturnType<typeof vi.fn>;
      $executeRaw: ReturnType<typeof vi.fn>;
    };
  };
  let queryRawQueue: unknown[][];

  beforeEach(() => {
    vi.resetModules();
    stored = {};
    queryRawQueue = [];
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
        $queryRaw: vi.fn(async () => queryRawQueue.shift() ?? []),
        $executeRaw: vi.fn(async () => 1)
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
    expect(policy).toEqual({ enabled: true, minUsdc: 100, intervalDays: 7 });
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

  it('userHasPremiumUsdcSpend: true quando já unlocked', async () => {
    queryRawQueue = [[{ ok: 1 }]];
    const { userHasPremiumUsdcSpend } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(await userHasPremiumUsdcSpend(1, 100)).toBe(true);
    expect(prismaMock.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('userHasPremiumUsdcSpend: true quando gasto >= limite (persiste unlock)', async () => {
    queryRawQueue = [[], [{ spent: 150 }]];
    const { userHasPremiumUsdcSpend } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(await userHasPremiumUsdcSpend(1, 100)).toBe(true);
    expect(prismaMock.prisma.$executeRaw).toHaveBeenCalled();
  });

  it('userHasPremiumUsdcSpend: false quando gasto abaixo do limite', async () => {
    queryRawQueue = [[], [{ spent: 40 }]];
    const { userHasPremiumUsdcSpend } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    expect(await userHasPremiumUsdcSpend(1, 100)).toBe(false);
    expect(prismaMock.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('resolveUserCheckinPremiumContext: elegível quando policy enabled e spend/unlock', async () => {
    queryRawQueue = [[{ ok: 1 }]];
    const { resolveUserCheckinPremiumContext } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const ctx = await resolveUserCheckinPremiumContext(1);
    expect(ctx.eligible).toBe(true);
    expect(ctx.premiumWeeklyCheckin).toBe(true);
  });

  it('resolveUserCheckinPremiumContext: não elegível quando policy desabilitada (não consulta spend)', async () => {
    stored.checkin_premium_enabled = '0';
    const { resolveUserCheckinPremiumContext } = await import('../../../../server/modules/checkin/services/premium-policy.js');
    const ctx = await resolveUserCheckinPremiumContext(1);
    expect(ctx.eligible).toBe(false);
    expect(ctx.premiumWeeklyCheckin).toBe(false);
    expect(prismaMock.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
