import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('checkin.ts — getCheckinStatus / performCheckin', () => {
  let callCheckinStatus: ReturnType<typeof vi.fn>;
  let callCheckinPerform: ReturnType<typeof vi.fn>;

  const STATUS = {
    lastCheckinDay: null,
    streak: 0,
    frozen: true,
    checkedInToday: false
  };

  beforeEach(() => {
    vi.resetModules();
    callCheckinStatus = vi.fn().mockResolvedValue(STATUS);
    callCheckinPerform = vi.fn().mockResolvedValue({ ...STATUS, performed: true });
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callCheckinStatus,
      callCheckinPerform
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  it('getCheckinStatus delega ao genesis-mining-worker', async () => {
    const { getCheckinStatus } = await import('../../../../server/modules/checkin/services/checkin.js');
    const status = await getCheckinStatus(1, 1_700_000_000_000);
    expect(callCheckinStatus).toHaveBeenCalledWith({ userId: 1, nowMs: 1_700_000_000_000 });
    expect(status.streak).toBe(0);
  });

  it('performCheckin delega e mapeia 409 para CheckinPremiumCooldownError', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    callCheckinPerform.mockRejectedValueOnce(
      new HttpControlledError(409, { nextCheckinAllowedMs: 99, intervalDays: 7 })
    );
    const { performCheckin, CheckinPremiumCooldownError } = await import(
      '../../../../server/modules/checkin/services/checkin.js'
    );
    await expect(performCheckin(1, Date.now())).rejects.toBeInstanceOf(CheckinPremiumCooldownError);
  });

  it('performCheckin caminho feliz', async () => {
    const { performCheckin } = await import('../../../../server/modules/checkin/services/checkin.js');
    const result = await performCheckin(1, 1_700_000_000_000);
    expect(callCheckinPerform).toHaveBeenCalledWith({ userId: 1, nowMs: 1_700_000_000_000 });
    expect(result.performed).toBe(true);
  });
});
