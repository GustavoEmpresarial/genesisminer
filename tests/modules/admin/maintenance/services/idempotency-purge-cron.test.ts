import { describe, expect, it, vi } from 'vitest';

describe('modules/admin/maintenance/services/idempotency-purge-cron', () => {
  it('startIdempotencyPurgeCron é no-op (não agenda setInterval)', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const { startIdempotencyPurgeCron } = await import(
      '../../../../../server/modules/admin/maintenance/services/idempotency-purge-cron.js'
    );
    const stop = startIdempotencyPurgeCron();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop();
    setIntervalSpy.mockRestore();
  });
});
