import { afterEach, describe, expect, it, vi } from 'vitest';

describe('chat purgeExpiredChatMessages → mining worker', () => {
  afterEach(() => {
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
    vi.resetModules();
  });

  it('delegates to callMiningWorkerChatPurge', async () => {
    const callMiningWorkerChatPurge = vi.fn().mockResolvedValue({
      ok: true,
      deleted: 1,
      ids: ['9'],
      channels: ['global'],
      audioUrls: [],
      beforeMs: 42
    });
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callMiningWorkerChatPurge,
      callMiningWorkerProgress: vi.fn(),
      miningWorkerBaseUrl: vi.fn(),
      miningWorkerAuthToken: vi.fn(),
      MINING_WORKER_AUTH_HEADER: 'x-mining-worker-token',
      MINING_WORKER_DEFAULT_PORT: 8091,
      MINING_WORKER_PROGRESS_TIMEOUT_MS: 30_000
    }));
    const { purgeExpiredChatMessages } = await import('../../../../server/modules/chat/services/chat.js');
    const out = await purgeExpiredChatMessages({ nowMs: 1000, limit: 50 });
    expect(callMiningWorkerChatPurge).toHaveBeenCalledWith({ nowMs: 1000, limit: 50 });
    expect(out).toEqual({ deleted: 1, ids: ['9'], channels: ['global'], audioUrls: [], beforeMs: 42 });
  });
});
