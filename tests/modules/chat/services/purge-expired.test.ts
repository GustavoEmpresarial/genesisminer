import { afterEach, describe, expect, it, vi } from 'vitest';

describe('purgeExpiredChatMessages fail-closed', () => {
  afterEach(() => {
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
    vi.resetModules();
  });

  it('delegates to mining worker and returns mapped fields', async () => {
    const callMiningWorkerChatPurge = vi.fn().mockResolvedValue({
      ok: true,
      deleted: 1,
      ids: ['9'],
      channels: ['global'],
      audioUrls: ['/img/chat-audio/x.webm'],
      beforeMs: 42
    });
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callMiningWorkerChatPurge
    }));
    const { purgeExpiredChatMessages } = await import('../../../../server/modules/chat/services/chat.js');
    const out = await purgeExpiredChatMessages({ nowMs: 100, limit: 10 });
    expect(callMiningWorkerChatPurge).toHaveBeenCalledWith({ nowMs: 100, limit: 10 });
    expect(out).toEqual({
      deleted: 1,
      ids: ['9'],
      channels: ['global'],
      audioUrls: ['/img/chat-audio/x.webm'],
      beforeMs: 42
    });
  });

  it('clamps limit before calling worker', async () => {
    const callMiningWorkerChatPurge = vi.fn().mockResolvedValue({
      ok: true,
      deleted: 0,
      ids: [],
      channels: [],
      audioUrls: [],
      beforeMs: 1
    });
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callMiningWorkerChatPurge
    }));
    const { purgeExpiredChatMessages } = await import('../../../../server/modules/chat/services/chat.js');
    await purgeExpiredChatMessages({ limit: 99999 });
    expect(callMiningWorkerChatPurge).toHaveBeenCalledWith({ limit: 5000 });
  });
});
