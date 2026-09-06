import { afterEach, describe, expect, it, vi } from 'vitest';

describe('mining-worker-client support/chat/announcements fail-closed', () => {
  const prev = process.env.GENESIS_MINING_WORKER_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.GENESIS_MINING_WORKER_URL;
    else process.env.GENESIS_MINING_WORKER_URL = prev;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('support HTTP timeout = lock budget + progress slack', async () => {
    const {
      MINING_WORKER_SUPPORT_TIMEOUT_MS,
      SUPPORT_LOCK_TIMEOUT_MS,
      MINING_WORKER_PROGRESS_TIMEOUT_MS
    } = await import('../../../../server/modules/mining-engine/services/mining-worker-client.js');
    expect(MINING_WORKER_SUPPORT_TIMEOUT_MS).toBe(
      SUPPORT_LOCK_TIMEOUT_MS + MINING_WORKER_PROGRESS_TIMEOUT_MS
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for support submit', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerSupportSubmit } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(
      callMiningWorkerSupportSubmit({ userId: 1, subject: 'Assunto', message: 'mensagem valida', attachments: [] })
    ).rejects.toThrow('GENESIS_MINING_WORKER_URL unset');
  });

  it('support submit happy path maps id + idempotentReplay', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, id: 't1', idempotentReplay: true })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { callMiningWorkerSupportSubmit } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerSupportSubmit({
      userId: 1,
      subject: 'Assunto',
      message: 'mensagem valida',
      attachments: [],
      idempotencyKey: 'key-12345678'
    });
    expect(out).toEqual({ ok: true, id: 't1', idempotentReplay: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mining.test/v1/support/submit',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('chat insert maps returning row', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            row: {
              id: '9',
              userId: 1,
              usernameSnapshot: 'jogador',
              body: 'oi',
              createdAt: 10,
              channel: 'global',
              kind: 'text',
              audioUrl: null,
              durationMs: null,
              editedAt: null,
              deletedAt: null
            }
          })
      }))
    );
    const { callMiningWorkerChatInsert } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerChatInsert({
      userId: 1,
      username: 'jogador',
      body: 'oi',
      channel: 'global',
      createdAt: 10,
      kind: 'text',
      audioUrl: null,
      durationMs: null
    });
    expect(out).toMatchObject({ ok: true, row: { id: '9', body: 'oi' } });
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for support admin reply', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerSupportAdminReply } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(
      callMiningWorkerSupportAdminReply({
        replyId: 'r1',
        ticketId: 't1',
        adminUserId: 5,
        message: 'ok',
        attachmentsJson: '[]',
        createdAt: 1
      })
    ).rejects.toThrow('GENESIS_MINING_WORKER_URL unset');
  });

  it('support admin reply happy path maps id', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, id: 'r1' })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { callMiningWorkerSupportAdminReply } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerSupportAdminReply({
      replyId: 'r1',
      ticketId: 't1',
      adminUserId: 5,
      message: 'ok',
      attachmentsJson: '[]',
      createdAt: 1
    });
    expect(out).toEqual({ ok: true, id: 'r1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mining.test/v1/support/admin-reply',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for support list-mine', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerSupportListMine } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerSupportListMine({ userId: 1 })).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for chat history', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerChatHistory } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerChatHistory({ channel: 'global' })).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for announcement pending', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerAnnouncementPending } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerAnnouncementPending({ userId: 1 })).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for chat can-access', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerChatCanAccess } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(callMiningWorkerChatCanAccess({ userId: 1, channel: 'am:1:2' })).rejects.toThrow(
      'GENESIS_MINING_WORKER_URL unset'
    );
  });

  it('unset URL → GENESIS_MINING_WORKER_URL unset for upload chat-audio', async () => {
    delete process.env.GENESIS_MINING_WORKER_URL;
    vi.resetModules();
    const { callMiningWorkerUploadChatAudio } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    await expect(
      callMiningWorkerUploadChatAudio({ buffer: new Uint8Array([1]), originalName: 'a.wav', mime: 'audio/wav' })
    ).rejects.toThrow('GENESIS_MINING_WORKER_URL unset');
  });

  it('announcement delete NOT_FOUND stays structured', async () => {
    process.env.GENESIS_MINING_WORKER_URL = 'http://mining.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ ok: false, error: 'Announcement not found.', code: 'NOT_FOUND' })
      }))
    );
    const { callMiningWorkerAnnouncementDelete } = await import(
      '../../../../server/modules/mining-engine/services/mining-worker-client.js'
    );
    const out = await callMiningWorkerAnnouncementDelete('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(out).toEqual({ ok: false, error: 'Announcement not found.', code: 'NOT_FOUND' });
  });
});
