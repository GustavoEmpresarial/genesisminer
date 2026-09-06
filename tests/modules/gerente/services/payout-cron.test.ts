import { describe, expect, it, vi } from 'vitest';

describe('modules/gerente/services/payout-cron', () => {
  it('startGerentePayoutCron é no-op (não agenda setInterval)', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const { startGerentePayoutCron } = await import(
      '../../../../server/modules/gerente/services/payout-cron.js'
    );
    const stop = startGerentePayoutCron();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
    setIntervalSpy.mockRestore();
  });
});
