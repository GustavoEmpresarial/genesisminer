import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('support services/mutation', () => {
  let ticketModelMock: Record<string, ReturnType<typeof vi.fn>>;
  let workerMock: {
    callMiningWorkerSupportSubmit: ReturnType<typeof vi.fn>;
    callMiningWorkerSupportReply: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    ticketModelMock = {
      getTicketForPlayerAction: vi.fn().mockResolvedValue({ id: 't1', user_id: 1, status: 'open' })
    };
    workerMock = {
      callMiningWorkerSupportSubmit: vi.fn().mockResolvedValue({ ok: true, id: 'tid-1' }),
      callMiningWorkerSupportReply: vi.fn().mockResolvedValue({ ok: true, replyId: 'rid-1' })
    };
    vi.doMock('../../../../server/modules/support/services/ticket-model.js', () => ticketModelMock);
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/support/services/ticket-model.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  describe('runSupportSubmitTicketMutation', () => {
    it('assunto curto: VALIDATION', async () => {
      const { runSupportSubmitTicketMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportSubmitTicketMutation({ userId: 1, subjectRaw: 'ab', messageRaw: 'mensagem valida', attachments: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(workerMock.callMiningWorkerSupportSubmit).not.toHaveBeenCalled();
    });

    it('mensagem curta: VALIDATION', async () => {
      const { runSupportSubmitTicketMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportSubmitTicketMutation({ userId: 1, subjectRaw: 'Assunto valido', messageRaw: 'curta', attachments: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(workerMock.callMiningWorkerSupportSubmit).not.toHaveBeenCalled();
    });

    it('sem idempotencyKey: delega ao worker sem chave', async () => {
      const { runSupportSubmitTicketMutation } = await import('../../../../server/modules/support/services/mutation.js');
      const out = await runSupportSubmitTicketMutation({ userId: 1, subjectRaw: 'Assunto valido', messageRaw: 'mensagem valida', attachments: [] });
      expect(out.id).toBe('tid-1');
      expect(workerMock.callMiningWorkerSupportSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, subject: 'Assunto valido', message: 'mensagem valida', attachments: [] })
      );
      expect(workerMock.callMiningWorkerSupportSubmit.mock.calls[0][0].idempotencyKey).toBeUndefined();
    });

    it('idempotencyKey válida: envia a chave ao worker', async () => {
      const { runSupportSubmitTicketMutation } = await import('../../../../server/modules/support/services/mutation.js');
      const out = await runSupportSubmitTicketMutation({ userId: 1, subjectRaw: 'Assunto valido', messageRaw: 'mensagem valida', attachments: [], idempotencyKeyRaw: 'key-12345678' });
      expect(out.id).toBe('tid-1');
      expect(workerMock.callMiningWorkerSupportSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'key-12345678' })
      );
    });
  });

  describe('runSupportPlayerReplyMutation', () => {
    it('ticketId vazio: VALIDATION', async () => {
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportPlayerReplyMutation({ userId: 1, ticketIdRaw: '', messageRaw: 'oi', attachments: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('sem mensagem e sem anexos: VALIDATION', async () => {
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportPlayerReplyMutation({ userId: 1, ticketIdRaw: 't1', messageRaw: '', attachments: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('ticket de outro utilizador: NOT_FOUND', async () => {
      ticketModelMock.getTicketForPlayerAction.mockResolvedValue({ id: 't1', user_id: 99, status: 'open' });
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportPlayerReplyMutation({ userId: 1, ticketIdRaw: 't1', messageRaw: 'oi tudo bem', attachments: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(workerMock.callMiningWorkerSupportReply).not.toHaveBeenCalled();
    });

    it('ticket arquivado: ARCHIVED', async () => {
      ticketModelMock.getTicketForPlayerAction.mockResolvedValue({ id: 't1', user_id: 1, status: 'archived' });
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      await expect(runSupportPlayerReplyMutation({ userId: 1, ticketIdRaw: 't1', messageRaw: 'oi tudo bem', attachments: [] })).rejects.toMatchObject({ code: 'ARCHIVED' });
      expect(workerMock.callMiningWorkerSupportReply).not.toHaveBeenCalled();
    });

    it('ticket arquivado com idempotencyKey: delega replay ao worker', async () => {
      ticketModelMock.getTicketForPlayerAction.mockResolvedValue({ id: 't1', user_id: 1, status: 'archived' });
      workerMock.callMiningWorkerSupportReply.mockResolvedValue({
        ok: true,
        replyId: 'rid-old',
        idempotentReplay: true
      });
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      const out = await runSupportPlayerReplyMutation({
        userId: 1,
        ticketIdRaw: 't1',
        messageRaw: 'oi tudo bem',
        attachments: [],
        idempotencyKeyRaw: 'key-12345678'
      });
      expect(out).toEqual({ replyId: 'rid-old', idempotentReplay: true });
      expect(workerMock.callMiningWorkerSupportReply).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't1', idempotencyKey: 'key-12345678' })
      );
    });

    it('caminho feliz sem idempotencyKey', async () => {
      const { runSupportPlayerReplyMutation } = await import('../../../../server/modules/support/services/mutation.js');
      const out = await runSupportPlayerReplyMutation({ userId: 1, ticketIdRaw: 't1', messageRaw: 'oi tudo bem', attachments: [] });
      expect(out.replyId).toBe('rid-1');
      expect(workerMock.callMiningWorkerSupportReply).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, ticketId: 't1', message: 'oi tudo bem', attachments: [] })
      );
    });
  });
});
