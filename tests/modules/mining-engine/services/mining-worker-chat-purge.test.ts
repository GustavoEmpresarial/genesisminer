import { afterEach, describe, expect, it, vi } from 'vitest';

describe('mining-worker-client chat purge fail-closed', () => {
  const prev = process.env.GENESIS_MINING_WORKER_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.GENESIS_MINING_WORKER_URL;
    else process.env.GENESIS_MINING_WORKER_URL = prev;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerChatPurge } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerChatPurge({ limit: 10 })).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('happy path maps camelCase body', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          deleted: 2,
          ids: ['1', '2'],
          channels: ['global'],
          audioUrls: ['/img/chat-audio/a.webm'],
          beforeMs: 1000
        })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { callMiningWorkerChatPurge } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerChatPurge({ nowMs: 5000, limit: 100 });
    expect(out).toEqual({
      ok: true,
      deleted: 2,
      ids: ['1', '2'],
      channels: ['global'],
      audioUrls: ['/img/chat-audio/a.webm'],
      beforeMs: 1000
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mining.test/v1/chat/purge-expired',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ nowMs: 5000, limit: 100 })
      })
    );
  });

  it('HTTP 500 with error throws', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ ok: false, error: 'db down' })
      }))
    );
    const { callMiningWorkerChatPurge } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerChatPurge()).rejects.toThrow('db down');
  });
});
