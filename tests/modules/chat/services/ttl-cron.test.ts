import { describe, expect, it, vi } from 'vitest';

describe('modules/chat/services/ttl-cron', () => {
  it('não agenda setInterval — worker Rust owns o tick', async () => {
    vi.resetModules();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    try {
      const { startChatTtlCron } = await import('../../../../server/modules/chat/services/ttl-cron.js');
      const stop = startChatTtlCron({ uploadsDir: '/tmp' });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(typeof stop).toBe('function');
      stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
