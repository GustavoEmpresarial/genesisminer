import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_MINUTE } from '../../../../server/shared/utils/time.js';

const callMiningWorkerGerentePayout = vi.fn();

vi.mock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
  callMiningWorkerGerentePayout: (...args: unknown[]) => callMiningWorkerGerentePayout(...args)
}));

describe('payClosedManagerWeeks — thin client fail-closed', () => {
  const ORIGINAL = process.env.ACCOUNT_MANAGER_ENABLED;

  beforeEach(() => {
    vi.resetModules();
    process.env.ACCOUNT_MANAGER_ENABLED = '1';
    callMiningWorkerGerentePayout.mockReset();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ACCOUNT_MANAGER_ENABLED;
    else process.env.ACCOUNT_MANAGER_ENABLED = ORIGINAL;
  });

  it('feature desligada: não chama worker', async () => {
    process.env.ACCOUNT_MANAGER_ENABLED = '0';
    const { payClosedManagerWeeks } = await import('../../../../server/modules/gerente/services/payout.js');
    const out = await payClosedManagerWeeks(Date.now());
    expect(out).toEqual({ paid: 0, skipped: 0 });
    expect(callMiningWorkerGerentePayout).not.toHaveBeenCalled();
  });

  it('shouldStop true → early return sem HTTP', async () => {
    const { payClosedManagerWeeks } = await import('../../../../server/modules/gerente/services/payout.js');
    const out = await payClosedManagerWeeks(Date.now(), () => true);
    expect(out).toEqual({ paid: 0, skipped: 0 });
    expect(callMiningWorkerGerentePayout).not.toHaveBeenCalled();
  });

  it('worker ok → propaga paid/skipped', async () => {
    callMiningWorkerGerentePayout.mockResolvedValue({ ok: true, paid: 2, skipped: 1 });
    const now = Date.UTC(2026, 8, 2, 12, 0, 0);
    const { payClosedManagerWeeks } = await import('../../../../server/modules/gerente/services/payout.js');
    const out = await payClosedManagerWeeks(now);
    expect(out).toEqual({ paid: 2, skipped: 1 });
    expect(callMiningWorkerGerentePayout).toHaveBeenCalledWith(
      expect.objectContaining({ serverNowMs: now, timeoutMs: expect.any(Number) })
    );
    const arg = callMiningWorkerGerentePayout.mock.calls[0][0] as { timeoutMs: number };
    expect(arg.timeoutMs).toBeGreaterThanOrEqual(MS_PER_MINUTE);
  });

  it('GENESIS_MINING_WORKER_URL unset: propaga throw', async () => {
    callMiningWorkerGerentePayout.mockResolvedValue({
      ok: false,
      error: 'GENESIS_MINING_WORKER_URL unset'
    });
    const { payClosedManagerWeeks } = await import('../../../../server/modules/gerente/services/payout.js');
    await expect(payClosedManagerWeeks(Date.now())).rejects.toThrow('GENESIS_MINING_WORKER_URL unset');
  });
});
