import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('modules/support/services/ticket-model — supportStoredNameReferencedOnTicket', () => {
  let workerMock: {
    callMiningWorkerSupportAttachmentReferenced: ReturnType<typeof vi.fn>;
    callMiningWorkerSupportTicketForPlayer: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    workerMock = {
      callMiningWorkerSupportAttachmentReferenced: vi.fn().mockResolvedValue(false),
      callMiningWorkerSupportTicketForPlayer: vi.fn().mockResolvedValue(null)
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => ({ prisma: {} }));
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  async function load() {
    return import('../../../../server/modules/support/services/ticket-model.js');
  }

  it('rejeita storedName com caracteres de controlo/aspas sem tocar no worker', async () => {
    const { supportStoredNameReferencedOnTicket } = await load();
    expect(await supportStoredNameReferencedOnTicket('t1', 'x"y')).toBe(false);
    expect(workerMock.callMiningWorkerSupportAttachmentReferenced).not.toHaveBeenCalled();
  });

  it('ticket inexistente: false', async () => {
    workerMock.callMiningWorkerSupportAttachmentReferenced.mockResolvedValue(false);
    const { supportStoredNameReferencedOnTicket } = await load();
    expect(await supportStoredNameReferencedOnTicket('t1', 'support-7-1-1.png')).toBe(false);
  });

  it('nome referenciado nos anexos do ticket: true', async () => {
    workerMock.callMiningWorkerSupportAttachmentReferenced.mockResolvedValue(true);
    const { supportStoredNameReferencedOnTicket } = await load();
    expect(await supportStoredNameReferencedOnTicket('t1', 'support-7-1-1.png')).toBe(true);
  });

  it('nome referenciado numa resposta de staff: true', async () => {
    workerMock.callMiningWorkerSupportAttachmentReferenced.mockResolvedValue(true);
    const { supportStoredNameReferencedOnTicket } = await load();
    expect(await supportStoredNameReferencedOnTicket('t1', 'support-reply-1-1-1.png')).toBe(true);
  });

  it('nome não referenciado em lado nenhum: false', async () => {
    workerMock.callMiningWorkerSupportAttachmentReferenced.mockResolvedValue(false);
    const { supportStoredNameReferencedOnTicket } = await load();
    expect(await supportStoredNameReferencedOnTicket('t1', 'support-9-9-9.png')).toBe(false);
  });
});

describe('modules/support/services/ticket-model — insertSupportAdminReply fail-closed', () => {
  let workerMock: { callMiningWorkerSupportAdminReply: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    workerMock = {
      callMiningWorkerSupportAdminReply: vi.fn().mockResolvedValue({ ok: true, id: 'r1' })
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => ({ prisma: {} }));
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  const params = {
    replyId: 'r1',
    ticketId: 't1',
    adminUserId: 5,
    message: 'ok',
    attachmentsJson: '[]',
    createdAt: 1
  };

  it('delegates to mining worker and does not touch Prisma', async () => {
    const { insertSupportAdminReply } = await import('../../../../server/modules/support/services/ticket-model.js');
    await insertSupportAdminReply(params);
    expect(workerMock.callMiningWorkerSupportAdminReply).toHaveBeenCalledWith(params);
  });

  it('throws worker error (unset URL / !ok) — no Prisma fallback', async () => {
    workerMock.callMiningWorkerSupportAdminReply.mockRejectedValue(new Error('GENESIS_MINING_WORKER_URL unset'));
    const { insertSupportAdminReply } = await import('../../../../server/modules/support/services/ticket-model.js');
    await expect(insertSupportAdminReply(params)).rejects.toThrow('GENESIS_MINING_WORKER_URL unset');
  });

  it('listMySupportTicketSummaries delegates to worker — no Prisma fallback', async () => {
    const listMine = vi.fn().mockResolvedValue({
      ok: true,
      summaries: [
        {
          id: 't1',
          subject: 'S',
          status: 'open',
          createdAt: 10,
          adminReplyCount: 0,
          lastAdminAt: 0,
          lastPlayerAt: 10
        }
      ]
    });
    vi.resetModules();
    vi.doMock('../../../../server/core/database/prisma.js', () => ({ prisma: {} }));
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callMiningWorkerSupportAdminReply: vi.fn(),
      callMiningWorkerSupportListMine: listMine,
      callMiningWorkerSupportGet: vi.fn(),
      callMiningWorkerSupportState: vi.fn(),
      callMiningWorkerSupportArchive: vi.fn(),
      callMiningWorkerSupportReopen: vi.fn(),
      callMiningWorkerSupportAdminList: vi.fn(),
      callMiningWorkerSupportAdminGet: vi.fn(),
      callMiningWorkerSupportAdminHistory: vi.fn(),
      callMiningWorkerSupportAdminStats: vi.fn()
    }));
    const { listMySupportTicketSummaries } = await import('../../../../server/modules/support/services/ticket-model.js');
    const rows = await listMySupportTicketSummaries(7, { limit: 20 });
    expect(listMine).toHaveBeenCalledWith({ userId: 7, limit: 20 });
    expect(rows[0]).toMatchObject({ id: 't1', created_at: 10 });
  });

  it('updateSupportTicketStatusForUser archive/reopen go to worker', async () => {
    const archive = vi.fn().mockResolvedValue({ ok: true, updated: 1 });
    const reopen = vi.fn().mockResolvedValue({ ok: true, updated: 0 });
    vi.resetModules();
    vi.doMock('../../../../server/core/database/prisma.js', () => ({ prisma: {} }));
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => ({
      callMiningWorkerSupportAdminReply: vi.fn(),
      callMiningWorkerSupportListMine: vi.fn(),
      callMiningWorkerSupportGet: vi.fn(),
      callMiningWorkerSupportState: vi.fn(),
      callMiningWorkerSupportArchive: archive,
      callMiningWorkerSupportReopen: reopen,
      callMiningWorkerSupportAdminList: vi.fn(),
      callMiningWorkerSupportAdminGet: vi.fn(),
      callMiningWorkerSupportAdminHistory: vi.fn(),
      callMiningWorkerSupportAdminStats: vi.fn()
    }));
    const { updateSupportTicketStatusForUser } = await import('../../../../server/modules/support/services/ticket-model.js');
    expect(await updateSupportTicketStatusForUser('t1', 7, 'archived', 'open')).toBe(1);
    expect(archive).toHaveBeenCalledWith({ userId: 7, ticketId: 't1' });
    expect(await updateSupportTicketStatusForUser('t1', 7, 'open', 'archived')).toBe(0);
    expect(reopen).toHaveBeenCalledWith({ userId: 7, ticketId: 't1' });
  });

  it('throws when worker returns ok:false', async () => {
    workerMock.callMiningWorkerSupportAdminReply.mockResolvedValue({
      ok: false,
      error: 'Ticket não encontrado.',
      code: 'NOT_FOUND'
    });
    const { insertSupportAdminReply } = await import('../../../../server/modules/support/services/ticket-model.js');
    await expect(insertSupportAdminReply(params)).rejects.toThrow('Ticket não encontrado.');
  });
});
